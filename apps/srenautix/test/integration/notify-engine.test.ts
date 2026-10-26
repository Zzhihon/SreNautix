import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Channel } from '@srenautix/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { NotifyService } from '../../src/notify/index.js';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import type { TelegramPayload } from '../../src/channels/telegram/render.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import { NotifyEngine, NotifyFatalError } from '../../src/notify/engine.js';
import { Interactions } from '../../src/notify/interactions.js';
import { incidentTrack } from '../../src/incident/migrations.js';
import { notifyTrack } from '../../src/notify/migrations.js';
import type { ActionOutcome, DesiredIncidentMessage, MessageSource, NotifyActions } from '../../src/notify/ports.js';
import { NotifyStore } from '../../src/notify/store.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fixture, FixtureServer } from '../support/fixture-server.js';
import { parseTelegramHtml } from '../support/telegram-html.js';

/** 发给 Bot API 的 HTML 解析后的文字（不合法的 HTML 在这里就失败） */
const visible = (html: unknown) => parseTelegramHtml(String(html)).text;

const TOKEN = 'test-token';
const CHAT = '-1001234567890';
const T0 = Date.parse('2026-10-20T00:00:00Z');
const send = `/bot${TOKEN}/sendMessage`;
const edit = `/bot${TOKEN}/editMessageText`;

/** 测试数据：期望消息列表，按语言返回；记录首次送达的回写。 */
class ListSource implements MessageSource {
  items: DesiredIncidentMessage[] = [];
  delivered_: Array<{ incidentId: string; proposalIds: string[] }> = [];
  async desired(language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    return this.items.filter((x) => x.language === language);
  }
  async delivered(incidentId: string, proposalIds: string[]): Promise<void> {
    this.delivered_.push({ incidentId, proposalIds });
  }
}

/** 投递测试不涉及按钮操作：没有绑定任何账号，所有操作都成功。 */
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

let n = 0;
function incident(over: Partial<DesiredIncidentMessage> & { title?: string } = {}): DesiredIncidentMessage {
  n++;
  const id = `6f1c2a9e-8b3d-4c1e-9a7f-${String(n).padStart(12, '0')}`;
  const title = over.title ?? `事件 ${n}`;
  return {
    incidentId: id,
    clusterId: 'prod',
    label: `Deployment:shop/app-${n}:2026-10-20T00:00:00Z`,
    severity: 'critical',
    state: 'firing',
    firstFiringAt: new Date(T0),
    endedAt: null,
    lane: 'urgent',
    language: 'zh',
    message: {
      incident_id: id,
      incident_version: 1,
      prefix: '[影子]',
      severity: 'critical',
      title,
      banner: '模型研判中',
      sections: [],
      buttons: [{ kind: 'approve', label: '批准 #1', callback: 'a', url: null }],
    },
    targets: [
      {
        key: 'a',
        kind: 'approve',
        incidentId: id,
        incidentVersion: 1,
        proposalId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        tier: 'L',
        researchRunId: null,
        rootComponent: null,
        disposition: null,
        choices: [],
      },
    ],
    ...over,
  };
}

function retitle(d: DesiredIncidentMessage, title: string): DesiredIncidentMessage {
  return { ...d, message: { ...d.message, title } };
}

let db: TestDb;
let fs: FixtureServer;
let now: number;
let source: ListSource;
let engine: NotifyEngine;
let store: NotifyStore;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack, incidentTrack, notifyTrack]);
  fs = new FixtureServer();
  await fs.start();
});

afterAll(async () => {
  await fs.stop();
  await db.close();
});

beforeEach(async () => {
  await db.admin.query(
    'TRUNCATE server.notify_messages, server.notify_storm_members, server.notify_storms, server.notify_buttons CASCADE',
  );
  fs.requests.length = 0;
  fs.reset('POST', send).reset('POST', edit);
  fs.on('POST', send, [fixture('telegram', 'send-message.ok')]);
  fs.on('POST', edit, [fixture('telegram', 'edit-message-text.ok')]);
  now = T0;
  source = new ListSource();
  store = new NotifyStore(db.server);
  const metrics = new ServerMetrics('server', false);
  const adapter = new TelegramAdapter(
    new TelegramClient(fs.url, TOKEN),
    [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
    { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 3_000 },
    '[影子]',
  );
  const interactions = new Interactions(store, new NoActions(), metrics, () => undefined);
  engine = new NotifyEngine(store, [adapter], source, interactions, metrics, {
    prefix: '[影子]',
    consoleUrl: 'https://console.example.com/',
    digestRetentionMs: 6 * 3_600_000,
    now: () => now,
  });
});

const sent = () => fs.calls('POST', send).map((r) => r.body as Record<string, unknown>);
const edited = () => fs.calls('POST', edit).map((r) => r.body as Record<string, unknown>);

describe('NotifyService', () => {
  it('从配置组装：webhook 模式启动时 setWebhook，同步与投递循环把消息发出，syncNow 立即同步', async () => {
    const dir = resolve(import.meta.dirname, '../../../../.scratch/notify-service-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot-token'), `${TOKEN}\n`);
    writeFileSync(join(dir, 'webhook-secret'), 'secret-0123456789abcdef\n');
    fs.reset('POST', `/bot${TOKEN}/setWebhook`).on('POST', `/bot${TOKEN}/setWebhook`, [
      fixture('telegram', 'set-webhook.ok'),
    ]);
    const svc = new NotifyService({
      pool: db.server,
      config: {
        prefix: '[影子]',
        severities: ['critical', 'warning'],
        resolved_retention: '6h',
        telegram: {
          enabled: true,
          bot_token_file: join(dir, 'bot-token'),
          api_base: fs.url,
          chats: [{ id: Number(CHAT), language: 'zh' }],
          updates: 'webhook',
          webhook_secret_file: join(dir, 'webhook-secret'),
          messages_per_minute: 20,
          edit_gap: '3s',
        },
        digest: {
          external_roots: {
            enabled: true,
            period: '1h',
            components: [],
            alert_labels: {},
            business_impact: { impact_cards: true, within: '30m', topology_hops: 6 },
          },
        },
        business_impact_alerts: [{ labels: { severity: ['critical'] }, exclude_labels: {} }],
      },
      publicUrl: 'https://srenautix.example.com',
      source,
      actions: new NoActions(),
      metrics: new ServerMetrics('server', false),
      isLeader: () => true,
    });
    const app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
    svc.registerRoutes(app);
    await app.ready();
    const ac = new AbortController();
    await svc.start(ac.signal);
    expect(fs.calls('POST', `/bot${TOKEN}/setWebhook`)[0]!.body).toMatchObject({
      url: 'https://srenautix.example.com/v1/channels/telegram/webhook',
      secret_token: 'secret-0123456789abcdef',
    });
    source.items = [incident()];
    svc.syncNow();
    for (let i = 0; i < 200 && sent().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sent()).toHaveLength(1);
    const unauth = await app.inject({ method: 'POST', url: '/v1/channels/telegram/webhook', payload: {} });
    expect(unauth.statusCode).toBe(401);
    await svc.stop();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('投递引擎（Telegram，录制夹具）', () => {
  it('新事件发一条消息，每次送达都回写消息中的提议；内容变化就地编辑，编辑间隔内的变化合并为最新内容', async () => {
    const d = incident();
    source.items = [d];
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    expect(sent()).toHaveLength(1);
    const body = sent()[0]!;
    expect(body.chat_id).toBe(Number(CHAT));
    expect(body.parse_mode).toBe('HTML');
    expect(visible(body.text).startsWith('[影子] [严重] 事件')).toBe(true);
    expect(body.disable_notification).toBeUndefined();
    expect((body.reply_markup as TelegramPayload['reply_markup']).inline_keyboard[0]![0]!.text).toBe('批准 #1');
    expect(source.delivered_).toEqual([{ incidentId: d.incidentId, proposalIds: [d.targets[0]!.proposalId] }]);

    source.items = [retitle(d, '第一次变化')];
    now += 1_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    source.items = [retitle(d, '第二次变化')];
    now += 1_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    now += 1_500;
    expect(await engine.deliverOnce()).toBe(1);
    expect(edited()).toHaveLength(1);
    expect(edited()[0]!.message_id).toBe(101);
    expect(visible(edited()[0]!.text)).toContain('第二次变化');
    // 编辑成功同样回写：之后加入已有消息的提议由此开始计算 TTL（提议中转只记录第一次送达）
    expect(source.delivered_).toEqual([
      { incidentId: d.incidentId, proposalIds: [d.targets[0]!.proposalId] },
      { incidentId: d.incidentId, proposalIds: [d.targets[0]!.proposalId] },
    ]);

    // 期望不变时不再编辑
    now += 10_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
  });

  it('编辑结果为“内容未变化”时视为已呈现；要编辑的消息被删除时改为重新发送', async () => {
    const d = incident();
    source.items = [d];
    await engine.syncOnce();
    await engine.deliverOnce();
    fs.reset('POST', edit).on(
      'POST',
      edit,
      [fixture('telegram', 'edit-message-text.not-modified'), fixture('telegram', 'edit-message-text.not-found')],
      false,
    );
    source.items = [retitle(d, '变化一')];
    now += 5_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    source.items = [retitle(d, '变化二')];
    now += 5_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(sent()).toHaveLength(1);
    expect(await engine.deliverOnce()).toBe(1);
    expect(sent()).toHaveLength(2);
    expect(visible(sent()[1]!.text)).toContain('变化二');
    const row = (await store.messages('telegram', CHAT, 'incident'))[0]!;
    expect(row.externalId).toBe('101');
    expect(row.deliveredHash).toBe(row.desiredHash);
  });

  it('429 按 retry_after 暂停整个渠道，到时补发', async () => {
    fs.reset('POST', send).on('POST', send, [
      fixture('telegram', 'too-many-requests'),
      fixture('telegram', 'send-message.ok'),
    ]);
    source.items = [incident(), incident()];
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(sent()).toHaveLength(1);
    now += 3_000;
    expect(await engine.deliverOnce()).toBe(0);
    expect(sent()).toHaveLength(1);
    now += 4_000;
    expect(await engine.deliverOnce()).toBe(2);
    expect(sent()).toHaveLength(3);
  });

  it('风暴：5 分钟内第 3 个事件开启风暴，新事件静默发送并列入汇总；之后的新事件并入同一风暴', async () => {
    const first = incident();
    source.items = [first];
    await engine.syncOnce();
    await engine.deliverOnce();
    now += 60_000;
    const a = incident();
    const b = incident();
    source.items = [first, a, b];
    await engine.syncOnce();
    // 两条新事件消息、汇总消息，以及第一条消息的编辑（带上所属风暴）
    expect(await engine.deliverOnce()).toBe(4);
    const bodies = sent();
    expect(bodies).toHaveLength(4);
    expect(bodies[1]!.disable_notification).toBe(true);
    expect(bodies[2]!.disable_notification).toBe(true);
    const digest = bodies[3]!;
    expect(visible(digest.text)).toContain('[影子] 事件风暴：自 00:01 UTC 起 3 个事件');
    for (const d of [first, a, b]) {
      expect(visible(digest.text)).toContain(d.label);
    }
    expect(edited().some((e) => visible(e.text).includes('属于 00:01 UTC 开始的事件风暴'))).toBe(true);

    now += 60_000;
    const c = incident();
    source.items = [first, a, b, c];
    await engine.syncOnce();
    await engine.deliverOnce();
    const last = sent()[sent().length - 1]!;
    expect(last.disable_notification).toBe(true);
    expect(edited().some((e) => visible(e.text).includes('起 4 个事件'))).toBe(true);
  });

  it('令牌桶：每个群每分钟 20 次，超出的推迟到令牌补充；审批与新事件先于汇总', async () => {
    source.items = Array.from({ length: 22 }, () => incident());
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(20);
    expect(sent()).toHaveLength(20);
    // 20 条新事件消息（urgent）都先于汇总（digest）
    expect(sent().every((b) => !visible(b.text).includes('事件风暴：自'))).toBe(true);
    expect(sent().every((b) => b.disable_notification === true)).toBe(true);
    now += 3_000;
    expect(await engine.deliverOnce()).toBe(1);
    now += 6_000;
    expect(await engine.deliverOnce()).toBe(2);
    expect(visible(sent()[sent().length - 1]!.text)).toContain('事件风暴：自 00:00 UTC 起 22 个事件');
  });

  it('Bot API 拒绝消息（400 以外的 4xx）时记录错误并 5 分钟后重试；token 无效时抛出配置错误', async () => {
    // 内容本身被拒绝的 400 是永久错误，走纯文本降级与放弃（notify-stale-desired.test.ts）
    fs.reset('POST', send).on('POST', send, [
      {
        status: 403,
        body: {
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot is not a member of the supergroup chat',
        },
      },
      fixture('telegram', 'unauthorized'),
    ]);
    source.items = [incident()];
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    const row = (await store.messages('telegram', CHAT, 'incident'))[0]!;
    const r = await db.admin.query<{ last_error: string; next_attempt_at: Date }>(
      'SELECT last_error, next_attempt_at FROM server.notify_messages WHERE id = $1',
      [row.id],
    );
    expect(r.rows[0]!.last_error).toContain('bot is not a member');
    expect(r.rows[0]!.next_attempt_at.getTime()).toBe(now + 5 * 60_000);
    now += 5 * 60_000;
    await expect(engine.deliverOnce()).rejects.toThrow(NotifyFatalError);
  });

  it('Telegram 不可达时消息保留在库中，恢复后补发最新内容', async () => {
    const down = new TelegramAdapter(
      new TelegramClient('http://127.0.0.1:9', TOKEN, 2_000),
      [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
      { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 3_000 },
      '',
    );
    const metrics = new ServerMetrics('server', false);
    const e2 = new NotifyEngine(
      store,
      [down],
      source,
      new Interactions(store, new NoActions(), metrics, () => undefined),
      metrics,
      {
        prefix: '',
        consoleUrl: null,
        digestRetentionMs: 6 * 3_600_000,
        now: () => now,
      },
    );
    source.items = [incident()];
    await e2.syncOnce();
    expect(await e2.deliverOnce()).toBe(0);
    const r = await db.admin.query<{ next_attempt_at: Date; attempts: number }>(
      'SELECT next_attempt_at, attempts FROM server.notify_messages',
    );
    expect(r.rows[0]!.attempts).toBe(1);
    expect(r.rows[0]!.next_attempt_at.getTime()).toBe(now + 15_000);
    now += 15_000;
    expect(await engine.deliverOnce()).toBe(1);
  });

  it('状态库降级时直接发送（不带回调按钮），恢复后补写，之后的同步按期望状态编辑同一条消息', async () => {
    const known = incident();
    source.items = [known];
    await engine.syncOnce();
    await engine.deliverOnce();
    const d = incident();
    expect(await engine.sendDirect(d)).toBe(1);
    const direct = sent()[sent().length - 1]!;
    expect(direct.reply_markup).toBeUndefined();
    // 同样的内容不重复发送；已知消息改为编辑
    expect(await engine.sendDirect(d)).toBe(0);
    now += 5_000;
    expect(await engine.sendDirect(retitle(known, '降级期间的变化'))).toBe(1);
    expect(edited()[edited().length - 1]!.message_id).toBe(101);
    expect(engine.directPending).toBe(2);

    expect(await engine.backfill()).toBe(2);
    expect(source.delivered_.map((x) => x.incidentId)).toContain(d.incidentId);
    const before = sent().length;
    source.items = [known, d];
    now += 5_000;
    await engine.syncOnce();
    await engine.deliverOnce();
    expect(sent().length).toBe(before);
    const withButtons = edited().filter(
      (e) => (e.reply_markup as TelegramPayload['reply_markup']).inline_keyboard.length > 0,
    );
    expect(withButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('只发送的渠道（Telegram updates: none）不渲染回调按钮，只保留打开控制台的链接，也不登记按钮', async () => {
    const sendOnly = new TelegramAdapter(
      new TelegramClient(fs.url, TOKEN),
      [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
      { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 3_000 },
      '[影子]',
      false,
    );
    const metrics = new ServerMetrics('server', false);
    const e = new NotifyEngine(
      store,
      [sendOnly],
      source,
      new Interactions(store, new NoActions(), metrics, () => undefined),
      metrics,
      {
        prefix: '[影子]',
        consoleUrl: 'https://console.example.com/',
        digestRetentionMs: 6 * 3_600_000,
        now: () => now,
      },
    );
    const d = incident();
    d.message.buttons.push({
      kind: 'open_console',
      label: '在控制台打开',
      callback: null,
      url: 'https://console.example.com/incidents/x',
    });
    source.items = [d];
    await e.syncOnce();
    await e.deliverOnce();
    const kb = (sent()[sent().length - 1]!.reply_markup as TelegramPayload['reply_markup']).inline_keyboard.flat();
    expect(kb).toEqual([{ text: '在控制台打开', url: 'https://console.example.com/incidents/x' }]);
    const buttons = await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM server.notify_buttons');
    expect(buttons.rows[0]?.n).toBe(0);
  });
});
