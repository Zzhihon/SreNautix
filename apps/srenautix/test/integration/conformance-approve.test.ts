import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runApproveConformance,
  type ApproveSubject,
  type RawCallback,
  type SignatureVector,
} from '@srenautix/integration-sdk';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { CALLBACK_PATH, MAX_SKEW_MS } from '../../src/channels/feishu/callback.js';
import { feishuSignature, verifyFeishuSignature } from '../../src/channels/feishu/crypto.js';
import { ButtonSigner } from '../../src/channels/feishu/render.js';
import { CALLBACK_PREFIX, type TelegramPayload } from '../../src/channels/telegram/render.js';
import { WEBHOOK_PATH } from '../../src/channels/telegram/updates.js';
import { webhookSecretMatches, WEBHOOK_SECRET_HEADER } from '../../src/channels/telegram/updates.js';
import { parseServerConfig } from '../../src/config/server.js';
import { ChatLinks, upsertUser } from '../../src/identity/chat-links.js';
import { hashPassword } from '../../src/identity/password.js';
import { feishuButtonKey } from '../../src/notify/index.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fixture, fixtureFile, FixtureServer } from '../support/fixture-server.js';
import { until } from '../support/monitoring.js';

/**
 * approve/v1 一致性测试（packages/integration-sdk 的 runApproveConformance）对 Telegram 与飞书各运行一次：
 * 真实的 server（buildServer）、PostgreSQL、提议与审批断言签发，渠道回调走 server 的 webhook 与回调路由；
 * 渠道的 Bot API 与开放平台由录制夹具回放。每次构造回调都新建一个 L 档待审批的提议，等它的批准按钮随消息发出。
 */
const PUBLIC = 'https://srenautix.example.test';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `conformance-approve-${process.pid}`);
const TG_CHAT = -1001234567890;
const TG_SECRET = 'webhook-secret-0123456789abcdef';
const BOT = '123456:TEST-bot-token';
const INGEST = 'ingest-token-conformance-0123456789';
const APPROVER = 'oidc:approver';
/** 提议的有效期：Telegram 回调没有时间戳，过期由提议 TTL 判定（从消息首次送达起算）。 */
const PROPOSAL_TTL_MS = 6_000;

interface FeishuVectors {
  encrypt_key: string;
  verification_token: string;
  app_secret: string;
  now_ms: number;
  card_action: { headers: Record<string, string>; body: string };
  url_verification: { headers: Record<string, string>; body: string };
}
const fv = fixtureFile<FeishuVectors>('feishu', 'signature-vectors.json');
const cardBase = fixtureFile<{ body: Record<string, unknown> }>('feishu', 'card-action.json').body;
const messageBase = fixtureFile<{ body: Record<string, unknown> }>('feishu', 'message-receive.json').body;
const FS_CHAT = (cardBase.event as { context: { open_chat_id: string } }).context.open_chat_id;

let db: TestDb;
let srv: ServerHandle;
let tg: FixtureServer;
let fsu: FixtureServer;
let cookie = '';
let csrf = '';
let incidentId = '';
/** 通知与渠道回调使用的时钟偏移（飞书回调的 5 分钟时效按它判断）。 */
let clockOffset = 0;
let replicas = 2;
let seq = 0;

const file = (name: string, content: string) => {
  const p = join(ROOT, name);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${srv.apiUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      cookie: `__Host-srenautix_session=${cookie}`,
      ...(method === 'GET' ? {} : { origin: PUBLIC, 'x-csrf-token': csrf, 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(path: string, raw: RawCallback): Promise<{ status: number; text: string }> {
  const res = await fetch(`${srv.apiUrl}${path}`, { method: 'POST', headers: raw.headers, body: raw.body });
  return { status: res.status, text: await res.text() };
}

/** 新建一个 L 档待审批的提议（控制台的人工提议），等它在 channel 中的批准按钮随消息发出，返回按钮的 short id。 */
async function pendingApproveButton(channel: 'telegram' | 'feishu'): Promise<{ proposalId: string; shortId: string }> {
  const inc = (await api('GET', `/v1/incidents/${incidentId}`)).body as {
    incident_version: number;
    root: { component: string };
  };
  const sa = (await api('GET', `/v1/incidents/${incidentId}/stage-a`)).body as { evidence_fingerprint: string };
  const r = await api('POST', '/v1/proposals', {
    incident_id: incidentId,
    binding: {
      incident_version: inc.incident_version,
      root_component: inc.root.component,
      evidence_fingerprint: sa.evidence_fingerprint,
    },
    action: 'workload_scale',
    params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: ++replicas },
    research_run_id: null,
    rule_id: null,
    hypothesis_id: null,
    evidence_refs: [],
    expected_effect: '扩容后错误率下降',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body).toMatchObject({ state: 'awaiting_approval', tier: 'L' });
  const proposalId = r.body.proposal_id as string;
  const shortId = await until(`${channel} 的批准按钮`, async () => {
    const b = await db.admin.query<{ short_id: string }>(
      `SELECT short_id FROM server.notify_buttons WHERE channel = $1 AND kind = 'approve' AND target->>'proposalId' = $2`,
      [channel, proposalId],
    );
    return b.rows[0]?.short_id;
  });
  return { proposalId, shortId };
}

/** 回调处理之后的结果：读取 server 记录的回调与操作结果。 */
async function outcomeOf(
  channel: 'telegram' | 'feishu',
  callbackId: string,
  proposalId: string,
  seenBefore: boolean,
  resultsBefore: number,
): Promise<string> {
  const results = async () =>
    db.admin.query<{ ok: boolean; code: string | null }>(
      `SELECT ok, code FROM server.notify_action_results WHERE channel = $1 AND proposal_id = $2 AND action = 'approve' ORDER BY id`,
      [channel, proposalId],
    );
  if (seenBefore) {
    // 同一回调 id 的重复投递：server 只补应答，不能再次审批
    await sleep(500);
    const r = await results();
    return r.rowCount === resultsBefore ? 'replayed' : String(r.rows.at(-1)?.ok ? 'approved' : r.rows.at(-1)?.code);
  }
  const cb = await until('回调被记录', async () => {
    const r = await db.admin.query<{ outcome: string | null }>(
      'SELECT outcome FROM server.notify_callbacks WHERE channel = $1 AND callback_id = $2',
      [channel, callbackId],
    );
    return r.rows[0]?.outcome ?? null;
  });
  if (cb !== 'submitted') {
    return cb;
  }
  // 飞书在应答之后执行操作，Telegram 在 webhook 请求内执行
  const last = await until('审批操作完成', async () => {
    const r = await results();
    return r.rowCount && r.rowCount > resultsBefore ? r.rows.at(-1) : null;
  });
  return last.ok ? 'approved' : String(last.code);
}

/** 投递之前：这个回调 id 是否已被记录过，以及该提议已有几条审批操作结果。 */
async function seen(
  channel: string,
  callbackId: string,
  proposalId: string,
): Promise<{ seen: boolean; results: number }> {
  const c = await db.admin.query('SELECT 1 FROM server.notify_callbacks WHERE channel = $1 AND callback_id = $2', [
    channel,
    callbackId,
  ]);
  const r = await db.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM server.notify_action_results WHERE channel = $1 AND proposal_id = $2 AND action = 'approve'`,
    [channel, proposalId],
  );
  return { seen: (c.rowCount ?? 0) > 0, results: r.rows[0]?.n ?? 0 };
}

/** 等到通知层没有待发送的消息（编辑测试直接调用适配器，不能与后台的编辑争用同一个夹具路由）。 */
async function quiescent(): Promise<void> {
  await until('通知全部送达', async () => {
    const r = await db.admin.query(
      'SELECT 1 FROM server.notify_messages WHERE delivered_hash IS DISTINCT FROM desired_hash LIMIT 1',
    );
    return r.rowCount === 0;
  });
  await sleep(1_500);
}

type Outcome = Awaited<ReturnType<ApproveSubject['deliver']>>;

async function linkCode(): Promise<string> {
  return (await new ChatLinks(db.server).createCode(APPROVER)).code;
}

async function linked(channel: string, user: string): Promise<void> {
  await until(`${channel} 账号 ${user} 绑定完成`, async () => {
    const r = await db.admin.query('SELECT 1 FROM server.chat_links WHERE channel = $1 AND channel_user_id = $2', [
      channel,
      user,
    ]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** 一致性套件给出的渠道账号是任意字符串；Telegram 的用户 id 是整数，按哈希映射成稳定的整数。 */
function tgUserId(user: string): number {
  return 900_000_000 + (createHash('sha256').update(user).digest().readUInt32BE(0) % 99_999_999);
}

/** 飞书开放平台的加密：AES-256-CBC，密钥为 sha256(encrypt_key)，随机 IV 放在密文前，base64 编码。 */
function feishuEncrypt(plain: string): string {
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', createHash('sha256').update(fv.encrypt_key).digest(), iv);
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final()]).toString('base64');
}

/** 加密并签名的飞书回调请求（时间戳取 nowMs）。 */
function feishuRequest(envelope: unknown, nowMs: number): RawCallback {
  const body = JSON.stringify({ encrypt: feishuEncrypt(JSON.stringify(envelope)) });
  const ts = String(Math.floor(nowMs / 1000));
  const nonce = randomBytes(6).toString('hex');
  return {
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': feishuSignature(ts, nonce, fv.encrypt_key, Buffer.from(body)),
    },
    body,
  };
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const at = new Date(Date.now() - 3600_000);
  await topo.apply('c1', [
    {
      op: 'node_upsert',
      at,
      source: 'informer',
      node: {
        key: 'Deployment:shop/api',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'api',
        uid: 'uid-deploy-api',
        labels: {},
        component_type: null,
        hub: false,
      },
    },
  ]);

  tg = new FixtureServer();
  await tg.start();
  tg.on('POST', `/bot${BOT}/sendMessage`, [fixture('telegram', 'send-message.ok')]);
  tg.on('POST', `/bot${BOT}/editMessageText`, [fixture('telegram', 'edit-message-text.ok')]);
  tg.on('POST', `/bot${BOT}/answerCallbackQuery`, [fixture('telegram', 'answer-callback-query.ok')]);
  tg.on('POST', `/bot${BOT}/setWebhook`, [fixture('telegram', 'set-webhook.ok')]);
  fsu = new FixtureServer();
  await fsu.start();
  fsu.on('POST', '/open-apis/auth/v3/tenant_access_token/internal', [fixture('feishu', 'tenant-access-token.ok')]);
  fsu.on('POST', '/open-apis/im/v1/messages', [fixture('feishu', 'message-create.ok')]);
  fsu.on('PATCH', /^\/open-apis\/im\/v1\/messages\/[^/]+$/, [fixture('feishu', 'message-patch.ok')]);

  const totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  const signing = generateKeyPairSync('ed25519');
  const checkpoint = generateKeyPairSync('ed25519');
  const config = parseServerConfig({
    cluster_id: 'c1',
    profile: 'standard',
    log_level: 'warn',
    public_url: PUBLIC,
    policies_dir: resolve(
      file(
        'policies/c1.yaml',
        stringify({
          version: 1,
          cluster: 'c1',
          actions: [{ id: 'workload_scale', namespaces: ['shop'] }],
          approvers: [
            { principal: 'local:admin', namespaces: ['*'], max_tier: 'H' },
            { principal: APPROVER, namespaces: ['shop'], max_tier: 'L' },
          ],
        }),
      ),
      '..',
    ),
    ingest: {
      sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', INGEST) }],
      reconcile: { enabled: false },
    },
    packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
    datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
    topology: { source: 'off' },
    notify: {
      prefix: '[影子]',
      telegram: {
        enabled: true,
        bot_token_file: file('bot-token', BOT),
        api_base: tg.url,
        chats: [{ id: TG_CHAT }],
        updates: 'webhook',
        webhook_secret_file: file('tg-secret', TG_SECRET),
        edit_gap: '1s',
      },
      feishu: {
        enabled: true,
        api_base: fsu.url,
        app_id: 'cli_a5fb0ae6a4000000',
        app_secret_file: file('fs-app-secret', fv.app_secret),
        encrypt_key_file: file('fs-encrypt-key', fv.encrypt_key),
        verification_token_file: file('fs-token', fv.verification_token),
        chats: [{ chat_id: FS_CHAT }],
      },
    },
    approvals: {
      signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
      key_id: 'conformance',
      proposal_ttl: `${PROPOSAL_TTL_MS / 1000}s`,
    },
    callers: { tokens_file: file('callers.yaml', stringify({ callers: [] })) },
    identity: {
      local_admin: {
        username: 'admin',
        password_hash_file: file('admin.hash', await hashPassword('correct horse battery')),
        totp_secret_file: file('admin.totp', totp.secret.base32),
      },
      bindings_dir: resolve(
        file(
          'bindings/b.yaml',
          stringify({
            bindings: [
              {
                subject: { kind: 'group', name: 'srenautix:local-admin' },
                role: 'admin',
                scope: { clusters: ['*'], namespaces: ['*'] },
              },
              {
                subject: { kind: 'group', name: 'approvers' },
                role: 'approver',
                scope: { clusters: ['*'], namespaces: ['shop'] },
              },
            ],
          }),
        ),
        '..',
      ),
    },
    audit: {
      checkpoint_key_file: file(
        'checkpoint.pem',
        checkpoint.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
      ),
    },
  });
  srv = await buildServer({
    config,
    pg: db.serverConfig,
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: 0 },
    now: () => Date.now() + clockOffset,
  });
  // 审批人经 OIDC 登录过（角色绑定按组计算）
  await upsertUser(db.server, { id: APPROVER, display_name: 'Approver', groups: ['approvers'] }, 'oidc', {});
  const login = await fetch(`${srv.apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery', totp: totp.generate() }),
  });
  expect(login.status).toBe(200);
  cookie = /__Host-srenautix_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  csrf = ((await login.json()) as { csrf_token: string }).csrf_token;

  const webhook = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json'), 'utf8'),
  ) as { alerts: Array<{ startsAt: string }> };
  webhook.alerts[0]!.startsAt = new Date(Date.now() - 30_000).toISOString();
  const ing = await fetch(`${srv.apiUrl}/v1/ingest/am`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/json' },
    body: JSON.stringify(webhook),
  });
  expect(ing.status).toBe(200);
  incidentId = await until('事件与阶段 A 报告', async () => {
    const r = await db.admin.query<{ incident_id: string }>(
      'SELECT incident_id FROM server.stage_a_reports ORDER BY rendered_at LIMIT 1',
    );
    return r.rows[0]?.incident_id;
  });
}, 120_000);

afterAll(async () => {
  await srv?.stop();
  await tg?.stop();
  await fsu?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('approve/v1 一致性', () => {
  it('Telegram：webhook 的 secret_token 校验来源，按钮只批准 L 档，同一回调只处理一次，过期的提议不能批准', async () => {
    // 回调构造时刻（墙上时间）与套件给出的时间：deliver 的 nowMs 与构造时 nowMs 之差就是回调送达的延迟
    const made = new Map<string, { wall: number; nowMs: number; proposalId: string }>();
    const subject: ApproveSubject = {
      name: 'telegram（webhook）',
      authenticity: 'transport_secret',
      expiryMs: PROPOSAL_TTL_MS,
      async verify(raw) {
        return webhookSecretMatches(lower(raw.headers)[WEBHOOK_SECRET_HEADER], TG_SECRET);
      },
      forgeSecret(raw) {
        return { headers: { ...raw.headers, [WEBHOOK_SECRET_HEADER]: `${TG_SECRET}-forged` }, body: raw.body };
      },
      async link(user) {
        const code = await linkCode();
        const r = await post(WEBHOOK_PATH, {
          headers: { 'content-type': 'application/json', [WEBHOOK_SECRET_HEADER]: TG_SECRET },
          body: JSON.stringify({
            update_id: ++seq,
            message: {
              message_id: 5000 + seq,
              from: { id: tgUserId(user), is_bot: false, first_name: user },
              chat: { id: TG_CHAT, type: 'supergroup', title: 'oncall' },
              date: Math.floor(Date.now() / 1000),
              text: `/link ${code}`,
            },
          }),
        });
        expect(r.status, r.text).toBe(200);
        await linked('telegram', String(tgUserId(user)));
      },
      async approveCallback({ channelUserId, nowMs }) {
        const b = await pendingApproveButton('telegram');
        const id = `cq-${++seq}`;
        made.set(id, { wall: Date.now(), nowMs, proposalId: b.proposalId });
        return {
          headers: { 'content-type': 'application/json', [WEBHOOK_SECRET_HEADER]: TG_SECRET },
          body: JSON.stringify({
            update_id: seq,
            callback_query: {
              id,
              from: { id: tgUserId(channelUserId), is_bot: false, first_name: channelUserId },
              message: {
                message_id: 101,
                chat: { id: TG_CHAT, type: 'supergroup', title: 'oncall' },
                date: Math.floor(Date.now() / 1000),
              },
              chat_instance: '-7000000000000000001',
              data: `${CALLBACK_PREFIX}${b.shortId}`,
            },
          }),
        };
      },
      async deliver(raw, nowMs) {
        let id: string;
        try {
          id = (JSON.parse(raw.body) as { callback_query: { id: string } }).callback_query.id;
        } catch {
          id = '';
        }
        const m = made.get(id);
        if (m) {
          // 提议 TTL 由状态库的时间判定：按套件要求的延迟真实等待
          await sleep(m.wall + (nowMs - m.nowMs) - Date.now());
        }
        if (!m) {
          throw new Error('不是本被测对象构造的回调');
        }
        const before = await seen('telegram', id, m.proposalId);
        const r = await post(WEBHOOK_PATH, raw);
        if (r.status === 401) {
          return 'bad_signature';
        }
        expect(r.status, r.text).toBe(200);
        return (await outcomeOf('telegram', id, m.proposalId, before.seen, before.results)) as Outcome;
      },
      async editTwice() {
        await quiescent();
        const adapter = srv.notify.telegram!.adapter;
        const chat = adapter.chats[0]!;
        const sent = tg.calls('POST', `/bot${BOT}/sendMessage`).at(-1)!.body as TelegramPayload & {
          reply_markup?: TelegramPayload['reply_markup'];
        };
        const payload: TelegramPayload = {
          text: sent.text,
          parse_mode: sent.parse_mode,
          reply_markup: sent.reply_markup ?? { inline_keyboard: [] },
        };
        const id = await adapter.send(chat, payload, true);
        tg.reset('POST', `/bot${BOT}/editMessageText`).on(
          'POST',
          `/bot${BOT}/editMessageText`,
          [fixture('telegram', 'edit-message-text.ok'), fixture('telegram', 'edit-message-text.not-modified')],
          false,
        );
        const from = tg.calls('POST', `/bot${BOT}/editMessageText`).length;
        const results: Array<'edited' | 'not_modified'> = [];
        for (let i = 0; i < 2; i++) {
          try {
            await adapter.edit(chat, id, payload);
            results.push('edited');
          } catch (e) {
            const k = adapter.classify(e).kind;
            if (k !== 'not_modified') {
              throw e;
            }
            results.push('not_modified');
          }
        }
        const edits = tg.calls('POST', `/bot${BOT}/editMessageText`).slice(from);
        const texts = edits.map((r) => (r.body as { text: string }).text);
        // 渠道上的内容取最后一次被接受（edited）的编辑
        const applied = texts.filter((_, i) => results[i] === 'edited');
        tg.reset('POST', `/bot${BOT}/editMessageText`).on('POST', `/bot${BOT}/editMessageText`, [
          fixture('telegram', 'edit-message-text.ok'),
        ]);
        return { results, before: texts[0] as string, after: applied.at(-1) as string };
      },
    };
    const vectors: SignatureVector[] = [
      {
        name: 'secret_token 正确',
        headers: { [WEBHOOK_SECRET_HEADER]: TG_SECRET },
        body: '{"update_id":1}',
        now_ms: Date.now(),
        valid: true,
      },
      {
        name: 'secret_token 错误',
        headers: { [WEBHOOK_SECRET_HEADER]: 'webhook-secret-0123456789abcdeX' },
        body: '{"update_id":1}',
        now_ms: Date.now(),
        valid: false,
      },
      { name: '没有 secret_token', headers: {}, body: '{"update_id":1}', now_ms: Date.now(), valid: false },
    ];
    const report = await runApproveConformance(subject, vectors, Date.now());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    // 重放没有产生第二次审批：经 Telegram 批准成功的操作恰好一次
    const ok = await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.notify_action_results WHERE channel = 'telegram' AND action = 'approve' AND ok",
    );
    expect(ok.rows[0]!.n).toBe(1);
  }, 180_000);

  it('飞书：请求签名与 5 分钟时效、按钮值签名，同一事件只处理一次', async () => {
    const signer = new ButtonSigner(feishuButtonKey(fv.app_secret));
    const made = new Map<string, { eventId: string; proposalId: string }>();
    const header = cardBase.header as Record<string, unknown>;
    const event = cardBase.event as Record<string, unknown>;
    const subject: ApproveSubject = {
      name: '飞书（卡片回调，加密）',
      authenticity: 'body_signature',
      expiryMs: MAX_SKEW_MS,
      async verify(raw, nowMs) {
        const h = lower(raw.headers);
        const ts = h['x-lark-request-timestamp'];
        const ok = verifyFeishuSignature(
          { timestamp: ts, nonce: h['x-lark-request-nonce'], signature: h['x-lark-signature'] },
          fv.encrypt_key,
          Buffer.from(raw.body),
        );
        return ok && !!ts && /^\d+$/.test(ts) && Math.abs(nowMs - Number(ts) * 1000) <= MAX_SKEW_MS;
      },
      async link(user) {
        const code = await linkCode();
        const base = messageBase.event as { sender: Record<string, unknown>; message: Record<string, unknown> };
        const envelope = {
          ...messageBase,
          header: {
            ...(messageBase.header as object),
            event_id: `link-${++seq}`,
            create_time: String(Date.now()),
          },
          event: {
            ...base,
            sender: { ...base.sender, sender_id: { open_id: user } },
            message: {
              ...base.message,
              message_id: `om_link_${seq}`,
              chat_id: FS_CHAT,
              chat_type: 'group',
              message_type: 'text',
              content: JSON.stringify({ text: `/link ${code}` }),
              mentions: [],
            },
          },
        };
        const r = await post(CALLBACK_PATH, feishuRequest(envelope, Date.now()));
        expect(r.status, r.text).toBe(200);
        await linked('feishu', user);
      },
      async approveCallback({ channelUserId, nowMs }) {
        const b = await pendingApproveButton('feishu');
        const eventId = `ev-${++seq}-${randomBytes(4).toString('hex')}`;
        const envelope = {
          ...cardBase,
          header: { ...header, event_id: eventId, create_time: String(nowMs * 1000) },
          event: {
            ...event,
            operator: { ...(event.operator as object), open_id: channelUserId, union_id: `on_${channelUserId}` },
            action: { ...(event.action as object), value: signer.value(b.shortId) },
            context: { ...(event.context as object), open_chat_id: FS_CHAT },
          },
        };
        const raw = feishuRequest(envelope, nowMs);
        made.set(raw.body, { eventId, proposalId: b.proposalId });
        return raw;
      },
      async deliver(raw, nowMs) {
        // 篡改过的请求体不在 made 中：它在签名校验处被拒绝，不会进入回调处理
        const m = made.get(raw.body);
        const before = m ? await seen('feishu', m.eventId, m.proposalId) : { seen: false, results: 0 };
        clockOffset = nowMs - Date.now();
        let r: { status: number; text: string };
        try {
          r = await post(CALLBACK_PATH, raw);
        } finally {
          clockOffset = 0;
        }
        if (r.status === 401) {
          return /过期|超出 5 分钟/.test(r.text) ? 'expired' : 'bad_signature';
        }
        expect(r.status, r.text).toBe(200);
        if (!m) {
          throw new Error('签名校验通过的回调不是本被测对象构造的');
        }
        return (await outcomeOf('feishu', m.eventId, m.proposalId, before.seen, before.results)) as Outcome;
      },
      async editTwice() {
        await quiescent();
        const adapter = srv.notify.feishu!.adapter;
        const chat = adapter.chats[0]!;
        const created = fsu.calls('POST', '/open-apis/im/v1/messages').at(-1)!.body as { content: string };
        const card = JSON.parse(created.content) as unknown;
        const id = await adapter.send(chat, card, true, `conformance-edit-${seq}`);
        const from = fsu.calls('PATCH', /^\/open-apis\/im\/v1\/messages\//).length;
        await adapter.edit(chat, id, card);
        await adapter.edit(chat, id, card);
        const patches = fsu
          .calls('PATCH', /^\/open-apis\/im\/v1\/messages\//)
          .slice(from)
          .map((p) => (p.body as { content: string }).content);
        return {
          results: ['edited', 'edited'] as Array<'edited' | 'not_modified'>,
          before: patches[0] as string,
          after: patches[1] as string,
        };
      },
    };
    const card = { ...fv.card_action, headers: lower(fv.card_action.headers) };
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith('0') ? '1' : '0');
    const vectors: SignatureVector[] = [
      { name: '卡片回调（录制）', ...card, now_ms: fv.now_ms, valid: true },
      {
        name: 'url_verification（录制）',
        headers: lower(fv.url_verification.headers),
        body: fv.url_verification.body,
        now_ms: fv.now_ms,
        valid: true,
      },
      {
        name: '签名改动一位',
        headers: { ...card.headers, 'x-lark-signature': flip(card.headers['x-lark-signature'] as string) },
        body: card.body,
        now_ms: fv.now_ms,
        valid: false,
      },
      {
        name: '请求体改动',
        headers: card.headers,
        body: card.body.replace('"encrypt":"', '"encrypt":"A'),
        now_ms: fv.now_ms,
        valid: false,
      },
      { name: '时间戳超出 5 分钟', ...card, now_ms: fv.now_ms + MAX_SKEW_MS + 1000, valid: false },
    ];
    const report = await runApproveConformance(subject, vectors, Date.now());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);

    // 集成页的连接测试：飞书经开放平台取得 tenant_access_token，回调按签名校验
    const t = await api('POST', `/v1/integrations/${encodeURIComponent('notify:feishu')}/test`, {});
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: true });
    expect((t.body.results as Array<{ capability: string; ok: boolean }>).map((x) => [x.capability, x.ok])).toEqual([
      ['notify.send', true],
      ['notify.edit', true],
      ['notify.callback_verify', true],
      ['notify.link', true],
      ['approve.l_tier', true],
    ]);
  }, 180_000);
});
