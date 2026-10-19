import type { Channel, Disposition } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { FeishuAdapter } from '../../src/channels/feishu/adapter.js';
import { CALLBACK_PATH, registerFeishuCallback } from '../../src/channels/feishu/callback.js';
import { FeishuClient } from '../../src/channels/feishu/client.js';
import { ButtonSigner } from '../../src/channels/feishu/render.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import { NotifyEngine } from '../../src/notify/engine.js';
import { feishuButtonKey } from '../../src/notify/index.js';
import { Interactions, NOT_LINKED_TEXT } from '../../src/notify/interactions.js';
import { notifyTrack } from '../../src/notify/migrations.js';
import type {
  ActionOutcome,
  ChannelActor,
  DesiredIncidentMessage,
  MessageSource,
  NotifyActions,
} from '../../src/notify/ports.js';
import { NotifyStore } from '../../src/notify/store.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fixture, fixtureFile, FixtureServer } from '../support/fixture-server.js';

const APP_ID = 'cli_a5fb0ae6a4000000';
const CHAT = 'oc_e4d2605ca917e695f54f11aaf56f0001';
const OPEN_ID = 'ou_3c14f3a59eaf2825dbe25359f15e1001';
const UNION_ID = 'on_cad4860e7af114fb4ff6c5d496d1001';
const MSG_ID = 'om_dc13264520392913993dd051dba21dcf';
const INCIDENT = '6f1c2a9e-8b3d-4c1e-9a7f-2d5e8b4c1d01';
const P_L = '00000000-0000-4000-8000-000000000201';

interface Vectors {
  encrypt_key: string;
  verification_token: string;
  app_secret: string;
  now_ms: number;
  button: { short_id: string; signature: string };
  card_action: { headers: Record<string, string>; body: string };
  url_verification: { headers: Record<string, string>; body: string };
}
const v = fixtureFile<Vectors>('feishu', 'signature-vectors.json');
const cardBase = fixtureFile<{ body: Record<string, unknown> }>('feishu', 'card-action.json').body;
const messageBase = fixtureFile<{ body: Record<string, unknown> }>('feishu', 'message-receive.json').body;

/** NotifyActions 的测试实现：按测试数据决定绑定关系与结果，记录每次调用。 */
class RecordingActions implements NotifyActions {
  calls: Array<{ op: string; principal: string | null; args: unknown[] }> = [];
  links = new Map<string, string>();
  unions = new Map<string, string>([[UNION_ID, 'oidc:alice']]);
  private rec(op: string, a: ChannelActor, ...args: unknown[]): ActionOutcome {
    this.calls.push({ op, principal: a.principalId, args });
    return { ok: true, message: '已完成' };
  }
  async approve(a: ChannelActor, id: string) {
    return this.rec('approve', a, id);
  }
  async reject(a: ChannelActor, id: string, reason: string) {
    return this.rec('reject', a, id, reason);
  }
  async undo(a: ChannelActor, id: string) {
    return this.rec('undo', a, id);
  }
  async feedbackRoot(a: ChannelActor, _t: unknown, verdict: string, root: string | null, reason: string | null) {
    return this.rec('feedbackRoot', a, verdict, root, reason);
  }
  async feedbackDisposition(a: ChannelActor, _t: unknown, verdict: string, d: Disposition | null) {
    return this.rec('feedbackDisposition', a, verdict, d);
  }
  async resolvedConfirm(a: ChannelActor, id: string) {
    return this.rec('resolvedConfirm', a, id);
  }
  async link(channel: Channel, user: string, code: string): Promise<ActionOutcome> {
    this.calls.push({ op: 'link', principal: null, args: [channel, user, code] });
    this.links.set(`${channel}:${user}`, 'oidc:alice');
    return { ok: true, message: '已绑定到 oidc:alice' };
  }
  async linkedPrincipal(channel: Channel, user: string) {
    return this.links.get(`${channel}:${user}`) ?? null;
  }
  async linkByUnionId(channel: Channel, user: string, union: string) {
    this.calls.push({ op: 'linkByUnionId', principal: null, args: [channel, user, union] });
    const p = this.unions.get(union) ?? null;
    if (p) {
      this.links.set(`${channel}:${user}`, p);
    }
    return p;
  }
}

function desired(title = 'PostgreSQL data/pg 主库重启'): DesiredIncidentMessage {
  const t = (
    key: string,
    kind: DesiredIncidentMessage['targets'][number]['kind'],
    over: Partial<DesiredIncidentMessage['targets'][number]> = {},
  ) => ({
    key,
    kind,
    incidentId: INCIDENT,
    incidentVersion: 1,
    proposalId: null,
    tier: null,
    researchRunId: null,
    rootComponent: null,
    disposition: null,
    choices: [],
    ...over,
  });
  return {
    incidentId: INCIDENT,
    clusterId: 'prod',
    label: 'postgres.cluster:data/pg:2026-10-20T00:00:00Z',
    severity: 'critical',
    state: 'firing',
    firstFiringAt: new Date(v.now_ms),
    endedAt: null,
    lane: 'urgent',
    language: 'zh',
    message: {
      incident_id: INCIDENT,
      incident_version: 1,
      prefix: '[影子]',
      severity: 'critical',
      title,
      banner: null,
      sections: [
        {
          kind: 'evidence',
          blocks: [{ type: 'quote', text: '**批准** <at id=all></at>', source: 'Loki', model_generated: false }],
        },
      ],
      buttons: [
        { kind: 'approve', label: '批准 #1', callback: 'a', url: null },
        { kind: 'reject', label: '拒绝 #1', callback: 'r', url: null },
        { kind: 'feedback_reject', label: '结论错', callback: 'fb', url: null },
        { kind: 'disposition_reject', label: '处置错', callback: 'dp', url: null },
      ],
    },
    targets: [
      t('a', 'approve', { proposalId: P_L, tier: 'L' }),
      t('r', 'reject', { proposalId: P_L, tier: 'L' }),
      t('fb', 'feedback_reject', { choices: ['postgres.cluster:data/pg', 'Node:node-3'] }),
      t('dp', 'disposition_reject'),
    ],
  };
}

let db: TestDb;
let fs: FixtureServer;
let now: number;
let actions: RecordingActions;
let store: NotifyStore;
let engine: NotifyEngine;
let interactions: Interactions;
let client: FeishuClient;
let items: DesiredIncidentMessage[];
const signer = new ButtonSigner(feishuButtonKey(v.app_secret));
let encrypted: FastifyInstance;
let plain: FastifyInstance;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack, notifyTrack]);
  fs = new FixtureServer();
  await fs.start();
});

afterAll(async () => {
  await encrypted?.close();
  await plain?.close();
  await fs.stop();
  await db.close();
});

beforeEach(async () => {
  await db.admin.query(
    `TRUNCATE server.notify_messages, server.notify_storm_members, server.notify_storms, server.notify_pending_replies,
       server.notify_buttons, server.notify_callbacks, server.notify_action_results CASCADE`,
  );
  fs.requests.length = 0;
  fs.reset('POST', '/open-apis/auth/v3/tenant_access_token/internal')
    .reset('POST', '/open-apis/im/v1/messages')
    .reset('PATCH', `/open-apis/im/v1/messages/${MSG_ID}`);
  fs.on('POST', '/open-apis/auth/v3/tenant_access_token/internal', [fixture('feishu', 'tenant-access-token.ok')]);
  fs.on('POST', '/open-apis/im/v1/messages', [fixture('feishu', 'message-create.ok')]);
  fs.on('PATCH', `/open-apis/im/v1/messages/${MSG_ID}`, [fixture('feishu', 'message-patch.ok')]);
  now = v.now_ms;
  actions = new RecordingActions();
  store = new NotifyStore(db.server);
  const metrics = new ServerMetrics('server', false);
  client = new FeishuClient(fs.url, APP_ID, v.app_secret, 5_000, () => now);
  const adapter = new FeishuAdapter(
    client,
    [{ channel: 'feishu', chat: CHAT, language: 'zh' }],
    { perChatPerMinute: 100, perAppPerMinute: 100, perAppPerSecond: 5, editGapMs: 1_000 },
    '[影子]',
    signer,
  );
  interactions = new Interactions(store, actions, metrics, () => undefined);
  items = [desired()];
  const source: MessageSource = { desired: async () => items, delivered: async () => undefined };
  engine = new NotifyEngine(store, [adapter], source, interactions, metrics, {
    prefix: '[影子]',
    consoleUrl: null,
    digestRetentionMs: 6 * 3_600_000,
    now: () => now,
  });
  const deps = {
    verificationToken: v.verification_token,
    signer,
    chats: new Set([CHAT]),
    interactions,
    actions,
    store,
    client,
    autoLinkUnionId: true,
    now: () => now,
  };
  await encrypted?.close();
  await plain?.close();
  encrypted = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerFeishuCallback(encrypted, { ...deps, encryptKey: v.encrypt_key });
  plain = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerFeishuCallback(plain, { ...deps, encryptKey: null });
  await Promise.all([encrypted.ready(), plain.ready()]);
});

/** 等到第 n 次操作被交回 server，且所有按钮的独占都已释放（操作在应答之后异步执行，结束后才释放按钮）。 */
async function waitCalls(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const calls = actions.calls.filter((c) => !c.op.startsWith('link')).length;
    const claimed = await db.admin.query(
      'SELECT 1 FROM server.notify_buttons WHERE claimed_by IS NOT NULL AND finished_at IS NULL',
    );
    if (calls >= n && !claimed.rowCount) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`10 秒内没有等到第 ${n} 次操作完成（已有 ${calls} 次，独占中的按钮 ${claimed.rowCount} 个）`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function shortIdOf(kind: string): Promise<string> {
  const r = await db.admin.query<{ short_id: string }>('SELECT short_id FROM server.notify_buttons WHERE kind = $1', [
    kind,
  ]);
  return r.rows[0]!.short_id;
}

function cardAction(over: {
  eventId: string;
  sid: string;
  form?: Record<string, unknown>;
  chat?: string;
  token?: string;
  createTime?: string;
}) {
  const header = cardBase.header as Record<string, unknown>;
  const event = cardBase.event as Record<string, unknown>;
  return {
    ...cardBase,
    header: {
      ...header,
      event_id: over.eventId,
      token: over.token ?? header.token,
      create_time: over.createTime ?? header.create_time,
    },
    event: {
      ...event,
      action: {
        ...(event.action as object),
        value: signer.value(over.sid),
        ...(over.form ? { form_value: over.form } : {}),
      },
      context: { ...(event.context as object), open_chat_id: over.chat ?? CHAT },
    },
  };
}

async function postPlain(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await plain.inject({
    method: 'POST',
    url: CALLBACK_PATH,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: r.statusCode, json: r.json() as Record<string, unknown> };
}

const toastOf = (j: Record<string, unknown>) => (j.toast as { content: string }).content;

describe('飞书卡片投递（录制夹具）', () => {
  it('获取 tenant_access_token 一次，发送卡片后就地更新；uuid 由消息身份与内容决定', async () => {
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    const create = fs.calls('POST', '/open-apis/im/v1/messages')[0]!;
    expect(create.query).toBe('?receive_id_type=chat_id');
    expect(create.headers.authorization).toBe('Bearer t-g1044ghJRUIJJ5ELPZ5GDKJJ2ZN7CYJ6NXHLLONE');
    const body = create.body as { receive_id: string; msg_type: string; content: string; uuid: string };
    expect(body.receive_id).toBe(CHAT);
    expect(body.msg_type).toBe('interactive');
    expect(body.uuid).toMatch(/^[0-9a-f]{32}$/);
    const card = JSON.parse(body.content) as {
      config: { update_multi: boolean };
      header: { title: { content: string } };
    };
    expect(card.config.update_multi).toBe(true);
    expect(card.header.title.content).toBe('[影子] [严重] PostgreSQL data/pg 主库重启');
    // 不可信原文只在 plain_text 中
    expect(body.content).toContain('"tag":"plain_text","content":"**批准** <at id=all></at>"');

    items = [desired('主库已恢复')];
    now += 2_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    const patch = fs.calls('PATCH', `/open-apis/im/v1/messages/${MSG_ID}`)[0]!;
    expect(JSON.parse((patch.body as { content: string }).content).header.title.content).toBe(
      '[影子] [严重] 主库已恢复',
    );
    expect(fs.calls('POST', '/open-apis/auth/v3/tenant_access_token/internal')).toHaveLength(1);
  });

  it('230020 频率限制暂停发送；已撤回的消息改为重新发送', async () => {
    fs.reset('POST', '/open-apis/im/v1/messages').on('POST', '/open-apis/im/v1/messages', [
      fixture('feishu', 'rate-limited'),
      fixture('feishu', 'message-create.ok'),
    ]);
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(await engine.deliverOnce()).toBe(0);
    now += 1_000;
    expect(await engine.deliverOnce()).toBe(1);
    fs.reset('PATCH', `/open-apis/im/v1/messages/${MSG_ID}`).on('PATCH', `/open-apis/im/v1/messages/${MSG_ID}`, [
      fixture('feishu', 'message-recalled'),
    ]);
    items = [desired('变化')];
    now += 2_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(await engine.deliverOnce()).toBe(1);
    expect(fs.calls('POST', '/open-apis/im/v1/messages')).toHaveLength(3);
    // 重新发送的 uuid 与第一次不同，不会被 1 小时去重吞掉
    const uuids = fs.calls('POST', '/open-apis/im/v1/messages').map((r) => (r.body as { uuid: string }).uuid);
    expect(uuids[2]).not.toBe(uuids[1]);
  });
});

describe('飞书回调（Encrypt Key 与签名）', () => {
  const post = (c: { headers: Record<string, string>; body: string }, headers: Record<string, string> = {}) =>
    encrypted.inject({
      method: 'POST',
      url: CALLBACK_PATH,
      headers: { 'content-type': 'application/json', ...c.headers, ...headers },
      payload: c.body,
    });

  it('加密的 url_verification 回应 challenge', async () => {
    const r = await post(v.url_verification);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ challenge: 'ajls384kdjx98XX' });
  });

  it('加密的卡片回调：签名正确时按 union_id 自动绑定并批准，3 秒内应答，同一 event_id 只处理一次', async () => {
    await store.registerButtons(
      'feishu',
      CHAT,
      [{ shortId: v.button.short_id, kind: 'approve', owner: null, target: { ...desired().targets[0]!, key: 'a' } }],
      new Date(now),
    );
    const r = await post(v.card_action);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ toast: { type: 'info', content: '已提交，结果见消息' } });
    await waitCalls(1);
    expect(actions.calls).toEqual([
      { op: 'linkByUnionId', principal: null, args: ['feishu', OPEN_ID, UNION_ID] },
      { op: 'approve', principal: 'oidc:alice', args: [P_L] },
    ]);
    const again = await post(v.card_action);
    expect(again.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 30));
    expect(actions.calls.filter((c) => c.op === 'approve')).toHaveLength(1);
  });

  it('签名错误、时间戳超出 5 分钟、未加密的载荷都被拒绝', async () => {
    expect((await post(v.card_action, { 'X-Lark-Signature': '0'.repeat(64) })).statusCode).toBe(401);
    now += 6 * 60_000;
    expect((await post(v.card_action)).statusCode).toBe(401);
    now = v.now_ms;
    const plainBody = JSON.stringify(cardBase);
    const r = await encrypted.inject({
      method: 'POST',
      url: CALLBACK_PATH,
      headers: { 'content-type': 'application/json', ...v.card_action.headers },
      payload: plainBody,
    });
    expect(r.statusCode).toBe(401);
    expect(actions.calls).toEqual([]);
  });
});

describe('飞书回调（明文）', () => {
  beforeEach(async () => {
    await engine.syncOnce();
    await engine.deliverOnce();
  });

  it('verification token 不匹配或回调过期时拒绝；不在配置中的群只回提示', async () => {
    const sid = await shortIdOf('approve');
    expect((await postPlain(cardAction({ eventId: 'e-token', sid, token: 'wrong' }))).status).toBe(401);
    expect(
      (await postPlain(cardAction({ eventId: 'e-stale', sid, createTime: String((v.now_ms - 10 * 60_000) * 1000) })))
        .status,
    ).toBe(401);
    const other = await postPlain(cardAction({ eventId: 'e-chat', sid, chat: 'oc_other' }));
    expect(other.status).toBe(200);
    expect(toastOf(other.json)).toBe('这个群不是已配置的通知渠道');
    const forged = await postPlain({
      ...cardAction({ eventId: 'e-forged', sid }),
      event: {
        ...(cardAction({ eventId: 'e-forged', sid }).event as object),
        action: { value: { k: sid, s: 'AAAAAAAAAAAAAAAA' } },
      },
    });
    expect(toastOf(forged.json)).toBe('按钮无效');
    expect(actions.calls).toEqual([]);
  });

  it('未绑定且没有可匹配的 union_id 时提示绑定', async () => {
    actions.unions.clear();
    const r = await postPlain(cardAction({ eventId: 'e-unlinked', sid: await shortIdOf('approve') }));
    expect(toastOf(r.json)).toBe(NOT_LINKED_TEXT);
    expect(actions.calls.filter((c) => c.op === 'approve')).toHaveLength(0);
  });

  it('拒绝必须在卡片表单里填写原因；结论错与处置错从下拉选择', async () => {
    const reject = await shortIdOf('reject');
    const empty = await postPlain(cardAction({ eventId: 'e-r1', sid: reject, form: { reason: '  ' } }));
    expect(toastOf(empty.json)).toBe('拒绝必须填写原因（不超过 500 字）');
    const ok = await postPlain(cardAction({ eventId: 'e-r2', sid: reject, form: { reason: '先扩容' } }));
    expect(toastOf(ok.json)).toBe('已提交，结果见消息');
    await waitCalls(1);
    expect(actions.calls.find((c) => c.op === 'reject')).toEqual({
      op: 'reject',
      principal: 'oidc:alice',
      args: [P_L, '先扩容'],
    });

    const fb = await shortIdOf('feedback_reject');
    expect(toastOf((await postPlain(cardAction({ eventId: 'e-f1', sid: fb, form: { root: 'Redis:x' } }))).json)).toBe(
      '请从列表中选择真实根因组件',
    );
    await postPlain(cardAction({ eventId: 'e-f2', sid: fb, form: { root: 'Node:node-3' } }));
    await waitCalls(2);
    await postPlain(cardAction({ eventId: 'e-f3', sid: fb, form: { root: '-' } }));
    await waitCalls(3);
    const roots = actions.calls.filter((c) => c.op === 'feedbackRoot').map((c) => c.args);
    expect(roots).toEqual([
      ['rejected', 'Node:node-3', null],
      ['rejected', null, null],
    ]);

    const dp = await shortIdOf('disposition_reject');
    expect(toastOf((await postPlain(cardAction({ eventId: 'e-d1', sid: dp, form: {} }))).json)).toBe(
      '请选择正确的处置判断',
    );
    await postPlain(cardAction({ eventId: 'e-d2', sid: dp, form: { disposition: 'ignore' } }));
    await waitCalls(4);
    expect(actions.calls.find((c) => c.op === 'feedbackDisposition')!.args).toEqual(['rejected', 'ignore']);
  });

  it('群里 @机器人 发送 /link <绑定码> 完成绑定并回复', async () => {
    fs.on('POST', '/open-apis/im/v1/messages', [fixture('feishu', 'message-create.ok')]);
    const r = await postPlain({
      ...messageBase,
      header: { ...(messageBase.header as object), create_time: String(v.now_ms) },
    });
    expect(r.status).toBe(200);
    expect(actions.calls[0]).toEqual({ op: 'link', principal: null, args: ['feishu', OPEN_ID, 'ABCD2345'] });
    const reply = fs.calls('POST', '/open-apis/im/v1/messages').at(-1)!.body as {
      msg_type: string;
      content: string;
      uuid: string;
    };
    expect(reply.msg_type).toBe('text');
    expect(JSON.parse(reply.content)).toEqual({ text: '已绑定到 oidc:alice' });
    expect(reply.uuid).toBe('5e3702a84e847582be8db7fb73283c02');
    // 同一事件重复投递不再处理
    await postPlain({ ...messageBase, header: { ...(messageBase.header as object), create_time: String(v.now_ms) } });
    expect(actions.calls.filter((c) => c.op === 'link')).toHaveLength(1);
  });
});
