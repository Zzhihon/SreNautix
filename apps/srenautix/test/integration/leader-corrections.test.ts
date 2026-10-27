import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { Channel } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leaseLeader, type Leader } from '../../src/api/leader.js';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { incidentTrack } from '../../src/incident/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import { notifyCorrections } from '../../src/notify/corrections.js';
import { MAX_ENDED_EDITS, NotifyEngine } from '../../src/notify/engine.js';
import { Interactions } from '../../src/notify/interactions.js';
import { notifyTrack } from '../../src/notify/migrations.js';
import type { ActionOutcome, DesiredIncidentMessage, MessageSource, NotifyActions } from '../../src/notify/ports.js';
import { NotifyStore } from '../../src/notify/store.js';
import { afterCorrections, runCorrections } from '../../src/store/corrections.js';
import { migrateExpand, type Track } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { startEnvTest, type EnvTest } from '../support/envtest.js';

/**
 * 升级交接（ADR 0176）：真实 PostgreSQL 与真实的 Kubernetes Lease（envtest）。旧实例（ADR 0173 之前的版本）先持有租约，
 * 新实例启动时执行迁移；旧实例在迁移之后仍是主实例，按旧规则再次把已结束事件的消息放弃（ended_edit_cap）。新实例
 * 取得租约之后先执行数据修正，再开始通知的同步与投递，这条消息得到最后一次编辑。
 *
 * 旧实例对 notify_messages 的写入取自旧版本的投递代码：已结束事件的消息编辑次数用完时，不请求渠道，直接以
 * "事件结束后已编辑 N 次"放弃（NotifyStore.abandon 的同一条语句），不写终态记录。
 */
const NS = 'srenautix';
const LEASE = 'srenautix-server-leader';
const LEASE_MS = 3_000;
const CHAT = '-1001234567890';
const TOKEN = 'test-token';
const INCIDENT = '7a1c2a9e-8b3d-4c1e-9a7f-000000000176';
const CONSOLE = `https://srenautix.example.test/incidents/${INCIDENT}`;

/** ADR 0173 之前的版本的 schema：store 与 notify 都停在当时的最后一条迁移 */
const OLD_TRACKS: readonly Track[] = [
  { ...storeTrack, migrations: storeTrack.migrations.slice(0, 1) },
  identityTrack,
  incidentTrack,
  { ...notifyTrack, migrations: notifyTrack.migrations.slice(0, 3) },
];
const NEW_TRACKS: readonly Track[] = [storeTrack, identityTrack, incidentTrack, notifyTrack];

/** Bot API：sendMessage 与 editMessageText 记下请求并成功，编辑不存在的消息返回 400 */
class BotApi {
  readonly requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  readonly messages = new Map<number, string>();
  url = '';
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const method = (req.url ?? '').split('/').pop() ?? '';
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        this.requests.push({ method, body });
        const id = Number(body.message_id ?? 0);
        if (method !== 'editMessageText' || !this.messages.has(id)) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }));
          return;
        }
        this.messages.set(id, String(body.text));
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: true,
            result: { message_id: id, date: 1792840380, chat: { id: Number(CHAT), type: 'supergroup' }, text: '' },
          }),
        );
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

class OneSource implements MessageSource {
  constructor(readonly d: DesiredIncidentMessage) {}
  async desired(language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    return language === this.d.language ? [this.d] : [];
  }
  async byIds(ids: readonly string[], language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    return ids.includes(this.d.incidentId) && language === this.d.language ? [this.d] : [];
  }
  async delivered(): Promise<void> {}
}

class NoActions implements NotifyActions {
  private ok = async (): Promise<ActionOutcome> => ({ ok: true, message: 'ok' });
  approve = this.ok;
  reject = this.ok;
  undo = this.ok;
  feedbackRoot = this.ok;
  feedbackDisposition = this.ok;
  resolvedConfirm = this.ok;
  link = async (_c: Channel, _u: string, _code: string): Promise<ActionOutcome> => ({ ok: true, message: 'ok' });
  linkedPrincipal = async (): Promise<string | null> => null;
  linkByUnionId = async (): Promise<string | null> => null;
}

/** 已经恢复的事件：恢复之后又更新了一次（期望内容与渠道上的不同） */
const resolved: DesiredIncidentMessage = {
  incidentId: INCIDENT,
  clusterId: 'prod',
  label: 'Deployment:shop/api:2026-10-27T00:00:00Z',
  severity: 'critical',
  state: 'resolved',
  firstFiringAt: new Date('2026-10-27T00:00:00Z'),
  endedAt: new Date('2026-10-27T01:00:00Z'),
  lane: 'recovery',
  language: 'zh',
  message: {
    incident_id: INCIDENT,
    incident_version: 3,
    prefix: '[影子]',
    severity: 'critical',
    title: 'api 的队列积压',
    banner: '已恢复',
    sections: [
      {
        kind: 'situation',
        blocks: [{ type: 'text', text: '队列已经清空', source: null, model_generated: false }],
      },
    ],
    buttons: [{ kind: 'open_console', label: '打开控制台', callback: null, url: CONSOLE }],
  },
  targets: [],
} as DesiredIncidentMessage;

let env: EnvTest;
let db: TestDb;
let bot: BotApi;
let kubeconfig: string;
const leaders: Leader[] = [];

const lease = (identity: string) => {
  const l = leaseLeader({ namespace: NS, name: LEASE, durationMs: LEASE_MS, kubeconfigPath: kubeconfig, identity });
  leaders.push(l);
  return l;
};
/** 这条消息的当前状态；升级之前的 schema 没有 final_edited_at，按整行读取 */
const message = async () =>
  (
    await db.admin.query<{
      id: number;
      abandoned_reason: string | null;
      final_edited_at?: Date | null;
      delivered_hash: string | null;
      desired_hash: string;
      last_error: string | null;
    }>('SELECT * FROM server.notify_messages WHERE incident_id = $1', [INCIDENT])
  ).rows[0]!;

/** 新版本的通知引擎；isLeader 取新实例经数据修正包装之后的主实例身份 */
function newEngine(isLeader: () => boolean): NotifyEngine {
  const store = new NotifyStore(db.server);
  const metrics = new ServerMetrics('server', false);
  const adapter = new TelegramAdapter(
    new TelegramClient(bot.url, TOKEN),
    [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
    { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 0 },
    '[影子]',
    false,
  );
  return new NotifyEngine(
    store,
    [adapter],
    new OneSource(resolved),
    new Interactions(store, new NoActions(), metrics, () => {}),
    metrics,
    { prefix: '[影子]', consoleUrl: null, digestRetentionMs: 6 * 3_600_000, isLeader, now: Date.now },
  );
}

beforeAll(async () => {
  env = await startEnvTest();
  kubeconfig = env.adminKubeconfig;
  const kc = new KubeConfig();
  kc.loadFromFile(kubeconfig);
  await kc.makeApiClient(CoreV1Api).createNamespace({ body: { metadata: { name: NS } } });
  db = await newTestDb();
  bot = new BotApi();
  await bot.start();
}, 120_000);

afterAll(async () => {
  for (const l of leaders) {
    await l.stop();
  }
  await bot?.stop();
  await db?.close();
  await env?.stop();
});

describe('升级交接：迁移只改 schema，语义修正在取得主实例之后执行', () => {
  it('旧实例在新迁移之后再次放弃消息，新实例取得租约后这条消息得到最后一次编辑', async () => {
    // 升级之前：旧版本的 schema；已结束事件的消息已发出并编辑满上限，最近一次期望内容按旧规则放弃
    await migrateExpand(db.server, 'server', OLD_TRACKS);
    bot.messages.set(901, 'old');
    await db.server.query(
      `INSERT INTO server.notify_messages (channel, chat, kind, subject, incident_id, lane, desired_payload, desired_hash,
         desired_at, external_id, delivered_hash, delivered_at, first_delivered_at, next_attempt_at, created_at,
         render_version, ended, ended_edits, abandoned_at, abandoned_reason, last_error)
       VALUES ('telegram', $1, 'incident', $2::text, $2::uuid, 'recovery', '{"text":"旧内容"}', 'old-desired', now(), '901',
         'old-delivered', now(), now(), now(), now(), 1, true, $3, now(), 'ended_edit_cap', $4)`,
      [CHAT, INCIDENT, MAX_ENDED_EDITS, `事件结束后已编辑 ${MAX_ENDED_EDITS} 次`],
    );
    const id = (await message()).id;

    // 旧实例持有租约
    const old = lease('server-old');
    await old.acquired();
    expect(old.isLeader()).toBe(true);

    // 新实例启动：执行迁移（只改 schema，不动这条放弃），参与选主但拿不到租约
    await migrateExpand(db.server, 'server', NEW_TRACKS);
    expect((await message()).abandoned_reason).toBe('ended_edit_cap');
    const fresh = afterCorrections(lease('server-new'), db.server, notifyCorrections, 'server-new', 200);
    const engine = newEngine(() => fresh.isLeader());
    await new Promise((r) => setTimeout(r, LEASE_MS / 2));
    expect(fresh.isLeader()).toBe(false);
    // 不是主实例：同步与投递不写 notify_messages，不请求渠道
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toEqual([]);

    // 迁移之后旧实例仍是主实例：同步写入新的期望内容（旧版本内容变化时清除放弃），投递时按旧规则再次放弃
    expect(old.isLeader()).toBe(true);
    await db.server.query(
      `UPDATE server.notify_messages SET desired_hash = 'old-desired-2', abandoned_at = NULL, abandoned_reason = NULL
        WHERE id = $1`,
      [id],
    );
    await new NotifyStore(db.server).abandon(
      id,
      'old-desired-2',
      new Date(),
      'ended_edit_cap',
      `事件结束后已编辑 ${MAX_ENDED_EDITS} 次`,
    );
    expect((await message()).abandoned_reason).toBe('ended_edit_cap');

    // 旧实例退出（不释放租约，与 Pod 终止相同）；租约过期后新实例取得租约，先执行数据修正
    await old.stop();
    await fresh.acquired();
    expect(fresh.isLeader()).toBe(true);
    const done = await db.admin.query<{ name: string; holder: string; rows: number }>(
      'SELECT name, holder, rows FROM server.data_corrections',
    );
    expect(done.rows).toEqual([{ name: 'notify/ended-edit-cap-final-edit', holder: 'server-new', rows: 1 }]);
    expect((await message()).abandoned_reason).toBeNull();

    // 新实例的同步把期望内容渲染为最后一次编辑，投递发出它
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests.map((r) => [r.method, r.body.message_id])).toEqual([['editMessageText', 901]]);
    const text = bot.messages.get(901)!;
    expect(text).toContain('队列已经清空');
    expect(text).toContain('消息停止更新（原因：编辑次数达到上限），完整内容见');
    const after = await message();
    expect(after.final_edited_at).toBeInstanceOf(Date);
    expect(after.abandoned_reason).toBeNull();
    expect(after.delivered_hash).toBe(after.desired_hash);
    const reasons = await db.admin.query<{ code: string }>(
      "SELECT code FROM server.incident_reasons WHERE incident_id = $1 AND stage = 'notify' ORDER BY id",
      [INCIDENT],
    );
    expect(reasons.rows.map((r) => r.code)).toEqual(['final_edit']);

    // 之后不再请求渠道
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toHaveLength(1);
  });

  it('修正只执行一次；本版本自己写的 ended_edit_cap（最后一次编辑被拒绝，带终态记录）不清除', async () => {
    const other = '7a1c2a9e-8b3d-4c1e-9a7f-000000000177';
    const r = await db.server.query<{ id: number }>(
      `INSERT INTO server.notify_messages (channel, chat, kind, subject, incident_id, lane, desired_payload, desired_hash,
         desired_at, external_id, next_attempt_at, created_at, render_version, ended, ended_edits, abandoned_at,
         abandoned_reason, last_error)
       VALUES ('telegram', $1, 'incident', $2::text, $2::uuid, 'recovery', '{}', 'h-new', now(), '902', now(), now(), 3,
         true, $3, now(), 'ended_edit_cap', 'entities_too_long：Bad Request: ENTITIES_TOO_LONG') RETURNING id`,
      [CHAT, other, MAX_ENDED_EDITS],
    );
    await db.server.query(
      `INSERT INTO server.incident_reasons (incident_id, stage, code, detail, ref, once_key)
       VALUES ($1, 'notify', 'ended_edit_cap', 'Bad Request: ENTITIES_TOO_LONG', $2, $3)`,
      [other, `telegram:${CHAT}`, `${r.rows[0]!.id}:h-new`],
    );
    // 已经记录过：再次执行（例如另一个副本取得主实例）不改动任何行
    expect(await runCorrections(db.server, notifyCorrections, 'server-other')).toEqual([]);
    // 即使修正还没有执行过，带终态记录的放弃也不清除
    await db.admin.query('DELETE FROM server.data_corrections');
    expect(await runCorrections(db.server, notifyCorrections, 'server-other')).toEqual([
      { name: 'notify/ended-edit-cap-final-edit', rows: 0 },
    ]);
    const kept = await db.admin.query<{ abandoned_reason: string | null }>(
      'SELECT abandoned_reason FROM server.notify_messages WHERE incident_id = $1',
      [other],
    );
    expect(kept.rows).toEqual([{ abandoned_reason: 'ended_edit_cap' }]);
  });

  it('修正失败时单活工作暂停：主实例身份保持为 false，失败原因修复后重试成功', async () => {
    let fail = true;
    const flaky = [
      {
        name: 'test/flaky',
        run: async () => {
          if (fail) {
            throw new Error('修正失败');
          }
          return 0;
        },
      },
    ];
    // 之前的实例都退出，等租约过期；这个实例取得租约之后修正失败，主实例身份保持为 false
    for (const x of leaders) {
      await x.stop();
    }
    const l = afterCorrections(lease('server-flaky'), db.server, flaky, 'server-flaky', 200);
    await new Promise((r) => setTimeout(r, LEASE_MS + 2_000));
    expect(l.isLeader()).toBe(false);
    expect((await db.admin.query("SELECT 1 FROM server.data_corrections WHERE name = 'test/flaky'")).rowCount).toBe(0);
    fail = false;
    await l.acquired();
    expect(l.isLeader()).toBe(true);
    const recorded = await db.admin.query("SELECT 1 FROM server.data_corrections WHERE name = 'test/flaky'");
    expect(recorded.rowCount).toBe(1);
  });
});
