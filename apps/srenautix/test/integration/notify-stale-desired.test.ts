import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Channel } from '@srenautix/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { MAX_ENTITY_BYTES } from '../../src/channels/telegram/html.js';
import type { TelegramPayload } from '../../src/channels/telegram/render.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import { RENDER_VERSION } from '../../src/notify/channel.js';
import { composeMessage } from '../../src/notify/compose.js';
import { MAX_ENDED_EDITS, NotifyEngine } from '../../src/notify/engine.js';
import { Interactions } from '../../src/notify/interactions.js';
import { incidentTrack } from '../../src/incident/migrations.js';
import { notifyTrack } from '../../src/notify/migrations.js';
import type { ActionOutcome, DesiredIncidentMessage, MessageSource, NotifyActions } from '../../src/notify/ports.js';
import { NotifyStore } from '../../src/notify/store.js';
import { t } from '../../src/notify/text.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { largeIncidentInput } from '../support/report-fixture.js';
import { parseTelegramHtml, serializedEntityBytes, TELEGRAM_ENTITY_BYTES_LIMIT } from '../support/telegram-html.js';

// ADR 0145：旧渲染器留下的期望内容、永久 4xx 与已结束事件的编辑上限；ADR 0173：编辑次数用完后的最后一次编辑。
// CCHP 影子 0ead2c9：22 行旧代码渲染的期望内容（14–25 KB，事件都已恢复）的 editMessageText 每次都返回
// 400 ENTITIES_TOO_LONG，按“其他 4xx 5 分钟后重试”无限循环，投递失败计数一直上涨

const TOKEN = 'test-token';
const CHAT = '-1001234567890';
const T0 = Date.parse('2026-10-24T11:13:00Z');

interface BotRequest {
  method: string;
  body: Record<string, unknown>;
}

/**
 * Bot API 的严格模拟：sendMessage 与 editMessageText 带 parse_mode=HTML 时按 Bot API 的规则解析
 * （support/telegram-html.ts），解析失败返回 400 can't parse entities，实体序列化总大小超过实测上限返回
 * 400 ENTITIES_TOO_LONG，解析后的文字超过 4096 返回 message is too long；编辑不存在的消息返回 message to edit not found，
 * 内容与键盘都没变返回 message is not modified。rejectHtml / rejectPlain 让带格式或纯文本的请求以给定的 400 失败。
 */
class StrictBotApi {
  readonly requests: BotRequest[] = [];
  readonly messages = new Map<number, string>();
  rejectHtml: string | null = null;
  rejectPlain: string | null = null;
  url = '';
  private nextId = 700;
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const method = (req.url ?? '').split('/').pop() ?? '';
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        this.requests.push({ method, body });
        const r = this.handle(method, body);
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private handle(method: string, b: Record<string, unknown>): { status: number; body: unknown } {
    const fail = (description: string) => ({
      status: 400,
      body: { ok: false, error_code: 400, description },
    });
    if (method !== 'sendMessage' && method !== 'editMessageText') {
      return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } };
    }
    const raw = String(b.text ?? '');
    let text = raw;
    let entities: unknown[] = [];
    if (b.parse_mode !== undefined) {
      if (b.parse_mode !== 'HTML') {
        return fail(`Bad Request: unsupported parse_mode ${String(b.parse_mode)}`);
      }
      if (this.rejectHtml) {
        return fail(this.rejectHtml);
      }
      try {
        const p = parseTelegramHtml(raw);
        text = p.text;
        entities = p.entities;
        if (serializedEntityBytes(p.entities) > TELEGRAM_ENTITY_BYTES_LIMIT) {
          return fail('Bad Request: ENTITIES_TOO_LONG');
        }
      } catch (e) {
        return fail(`Bad Request: can't parse entities: ${(e as Error).message}`);
      }
    } else if (this.rejectPlain) {
      return fail(this.rejectPlain);
    }
    if (!text.trim()) {
      return fail('Bad Request: message text is empty');
    }
    if (text.length > 4096) {
      return fail('Bad Request: message is too long');
    }
    const content = JSON.stringify({ text, entities, markup: b.reply_markup ?? null });
    let id: number;
    if (method === 'sendMessage') {
      id = this.nextId++;
    } else {
      id = Number(b.message_id);
      const cur = this.messages.get(id);
      if (cur === undefined) {
        return fail('Bad Request: message to edit not found');
      }
      if (cur === content) {
        return fail(
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
        );
      }
    }
    this.messages.set(id, content);
    return {
      status: 200,
      body: {
        ok: true,
        result: { message_id: id, date: 1792840380, chat: { id: Number(b.chat_id), type: 'supergroup' }, text },
      },
    };
  }
}

class MapSource implements MessageSource {
  /** 同步时需要消息的事件（推送范围内、恢复后保留期内） */
  items: DesiredIncidentMessage[] = [];
  /** 库里的全部事件，不论保留期 */
  all = new Map<string, DesiredIncidentMessage>();
  async desired(language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    return this.items.filter((x) => x.language === language);
  }
  async byIds(ids: readonly string[], language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    return ids.map((id) => this.all.get(id)).filter((d): d is DesiredIncidentMessage => d?.language === language);
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

let n = 0;
function small(over: Partial<DesiredIncidentMessage> = {}): DesiredIncidentMessage {
  n++;
  const id = `7a1c2a9e-8b3d-4c1e-9a7f-${String(n).padStart(12, '0')}`;
  const title = `事件 ${n}`;
  return {
    incidentId: id,
    clusterId: 'prod',
    label: `Deployment:shop/app-${n}:2026-10-24T00:00:00Z`,
    severity: 'critical',
    state: 'firing',
    firstFiringAt: new Date(T0 - 3_600_000),
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
      sections: [
        {
          kind: 'situation',
          blocks: [
            {
              type: 'paragraph',
              text: '',
              runs: [
                { text: '告警 ', style: 'plain', href: null },
                { text: 'KubePodCrashLooping', style: 'bold', href: 'https://grafana.example.test/explore?a=1&b=<2>' },
                { text: ' 持续 5 分钟', style: 'plain', href: null },
              ],
            },
          ],
        },
      ],
      buttons: [
        { kind: 'open_console', label: '打开控制台', callback: null, url: 'https://srenautix.example.test/i/1' },
      ],
    },
    targets: [],
    ...over,
  } as DesiredIncidentMessage;
}

function retitle(d: DesiredIncidentMessage, title: string): DesiredIncidentMessage {
  return { ...d, message: { ...d.message, title } };
}

/** #13 的大事件，已经恢复：70 个成员告警、53 张卡，链接与 CCHP 的 vmalert 相同 */
function resolvedLarge(): DesiredIncidentMessage {
  const input = largeIncidentInput();
  const ended = '2026-10-23T20:10:00Z';
  const inc = { ...input.incident, state: 'resolved' as const, ended_at: ended };
  const { message, targets } = composeMessage({ ...input, incident: inc });
  return {
    incidentId: inc.incident_id,
    clusterId: inc.cluster_id,
    label: inc.label,
    severity: inc.severity,
    state: 'resolved',
    firstFiringAt: new Date(inc.first_firing_at),
    endedAt: new Date(ended),
    lane: 'recovery',
    message,
    targets,
    language: 'zh',
  };
}

/** 旧渲染器（94b411b 之前，按个数分配实体）产出的内容：24 个 700 多字符的链接都带实体，序列化后超过 1.6 万字节 */
function oldPayload(): TelegramPayload {
  const lines = Array.from({ length: 24 }, (_, i) => {
    const url = `https://grafana.example.test/explore?schemaVersion=1&amp;orgId=1&amp;panes=${'%7B%22a%22'.repeat(70)}${i}`;
    return `- <a href="${url}">告警来源 ${i + 1}</a>`;
  });
  return {
    text: `<b>[严重] 发布后回退失败</b>\n已恢复\n\n${lines.join('\n')}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  };
}

let db: TestDb;
let bot: StrictBotApi;
let now: number;
let source: MapSource;
let store: NotifyStore;
let metrics: ServerMetrics;
let engine: NotifyEngine;

function newEngine(): NotifyEngine {
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
    source,
    new Interactions(store, new NoActions(), metrics, () => {}),
    metrics,
    {
      prefix: '[影子]',
      consoleUrl: null,
      digestRetentionMs: 6 * 3_600_000,
      now: () => now,
    },
  );
}

const failures = async () => (await metrics.notifyFailures.get()).values.reduce((s, v) => s + v.value, 0);
const abandoned = async (reason: string) =>
  (await metrics.notifyAbandoned.get()).values.find(
    (v) => v.labels.channel === 'telegram' && v.labels.reason === reason,
  )?.value ?? 0;

async function rowOf(incidentId: string) {
  const r = (await store.messages('telegram', CHAT, 'incident')).find((m) => m.incidentId === incidentId);
  if (!r) {
    throw new Error(`没有事件 ${incidentId} 的消息`);
  }
  return r;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack, incidentTrack, notifyTrack]);
  bot = new StrictBotApi();
  await bot.start();
});

afterAll(async () => {
  await bot.stop();
  await db.close();
});

beforeEach(async () => {
  await db.admin.query(
    'TRUNCATE server.notify_messages, server.notify_storm_members, server.notify_storms, server.notify_buttons CASCADE',
  );
  bot.requests.length = 0;
  bot.messages.clear();
  bot.rejectHtml = null;
  bot.rejectPlain = null;
  now = T0;
  source = new MapSource();
  store = new NotifyStore(db.server);
  metrics = new ServerMetrics('server', false);
  engine = newEngine();
});

describe('旧渲染器留下的期望内容（ADR 0145）', () => {
  it('超出实体预算的旧内容：启动后按当前代码重新渲染（已恢复的事件用已结束状态的模板），投递成功', async () => {
    const d = resolvedLarge();
    // 事件恢复超过保留期，同步不再给出它的期望消息；库里还有它
    source.all.set(d.incidentId, d);
    const old = oldPayload();
    // 严格模拟与 Telegram 一样拒绝旧内容
    bot.messages.set(77, JSON.stringify({ text: 'x', entities: [], markup: null }));
    await expect(
      new TelegramClient(bot.url, TOKEN).editMessageText({
        chat_id: Number(CHAT),
        message_id: 77,
        text: old.text,
        parse_mode: 'HTML',
      }),
    ).rejects.toThrow('ENTITIES_TOO_LONG');
    // 旧代码写入的行（没有新列）：已有渠道消息 77，期望与已呈现不同，重试了 681 次
    await db.server.query(
      `INSERT INTO server.notify_messages (channel, chat, kind, subject, incident_id, lane, silent, desired_payload,
         desired_hash, desired_at, external_id, delivered_hash, delivered_at, first_delivered_at, last_attempt_at,
         next_attempt_at, attempts, last_error, created_at)
       VALUES ('telegram', $1, 'incident', $2::text, $2::uuid, 'recovery', false, $3, 'old-desired', $4, '77', 'old-delivered', $4, $4,
         $5, $5, 681, 'telegram editMessageText: 400 Bad Request: ENTITIES_TOO_LONG', $4)`,
      [CHAT, d.incidentId, JSON.stringify(old), new Date('2026-10-22T08:00:00Z'), new Date(T0 - 60_000)],
    );
    expect((await rowOf(d.incidentId)).renderVersion).toBeNull();
    bot.requests.length = 0;

    await engine.syncOnce();
    const row = await rowOf(d.incidentId);
    expect(row.renderVersion).toBe(RENDER_VERSION);
    expect(row.ended).toBe(true);
    expect(row.desiredHash).not.toBe('old-desired');
    expect(row.lane).toBe('recovery');

    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests).toHaveLength(1);
    const req = bot.requests[0]!;
    expect(req.method).toBe('editMessageText');
    expect(req.body.message_id).toBe(77);
    expect(req.body.parse_mode).toBe('HTML');
    const parsed = parseTelegramHtml(String(req.body.text));
    expect(serializedEntityBytes(parsed.entities)).toBeLessThanOrEqual(MAX_ENTITY_BYTES);
    expect(parsed.text).toContain(t.state('zh', 'resolved'));
    const done = await rowOf(d.incidentId);
    expect(done.deliveredHash).toBe(done.desiredHash);
    expect(done.attempts).toBe(0);
    expect(await failures()).toBe(0);

    // 再次启动：没有旧内容，不再请求
    engine = newEngine();
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toHaveLength(1);
  });

  it('已经呈现的旧内容不重新渲染；事件已不存在的旧内容保持原样，交给永久错误的处理', async () => {
    const gone = '7a1c2a9e-8b3d-4c1e-9a7f-ffffffffffff';
    await db.server.query(
      `INSERT INTO server.notify_messages (channel, chat, kind, subject, incident_id, lane, desired_payload, desired_hash,
         desired_at, external_id, delivered_hash, next_attempt_at, created_at)
       VALUES ('telegram', $1, 'incident', $2::text, $2::uuid, 'edit', $3, 'h', $4, '78', 'h', $4, $4),
              ('telegram', $1, 'incident', $5::text, $5::uuid, 'edit', $3, 'h2', $4, '79', 'h1', $4, $4)`,
      [CHAT, '7a1c2a9e-8b3d-4c1e-9a7f-eeeeeeeeeeee', JSON.stringify(oldPayload()), new Date(T0 - 60_000), gone],
    );
    await engine.syncOnce();
    const rows = await store.messages('telegram', CHAT, 'incident');
    expect(rows.map((r) => [r.desiredHash, r.renderVersion])).toEqual([
      ['h', null],
      ['h2', null],
    ]);
    // 事件不存在的那一行：仍被拒绝，降级为纯文本后编辑成功（消息 79 在渠道上）
    bot.messages.set(79, JSON.stringify({ text: 'x', entities: [], markup: null }));
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests.map((r) => [r.method, r.body.parse_mode ?? null])).toEqual([
      ['editMessageText', 'HTML'],
      ['editMessageText', null],
    ]);
    expect(await failures()).toBe(0);
  });
});

describe('永久 4xx：纯文本降级与放弃（ADR 0145）', () => {
  it('永久 400 之后改为纯文本重试一次：文字与键盘不变，不计入投递失败', async () => {
    const d = small();
    source.items = [d];
    bot.rejectHtml = 'Bad Request: ENTITIES_TOO_LONG';
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests).toHaveLength(2);
    const [html, plain] = bot.requests as [BotRequest, BotRequest];
    expect(html.body.parse_mode).toBe('HTML');
    expect(plain.method).toBe('sendMessage');
    expect(plain.body.parse_mode).toBeUndefined();
    expect(plain.body.text).toBe(parseTelegramHtml(String(html.body.text)).text);
    expect(plain.body.text).toContain('告警 KubePodCrashLooping 持续 5 分钟');
    expect(plain.body.reply_markup).toEqual(html.body.reply_markup);
    const row = await rowOf(d.incidentId);
    expect(row.deliveredHash).toBe(row.desiredHash);
    expect(row.externalId).toBe('700');
    expect(await failures()).toBe(0);
    expect(await abandoned('entities_too_long')).toBe(0);

    // 内容变化后先按原格式编辑
    bot.rejectHtml = null;
    source.items = [retitle(d, '事件改名')];
    now += 10_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests.at(-1)!.body.parse_mode).toBe('HTML');
    expect(bot.requests.at(-1)!.body.message_id).toBe(700);
  });

  it('纯文本仍被拒绝：放弃这一版内容，之后不再请求 Telegram；内容变化后重新尝试', async () => {
    const d = small();
    source.items = [d];
    bot.rejectHtml = 'Bad Request: ENTITIES_TOO_LONG';
    bot.rejectPlain = 'Bad Request: BUTTON_URL_INVALID';
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toHaveLength(2);
    const row = await rowOf(d.incidentId);
    expect(row.abandonedAt?.getTime()).toBe(now);
    expect(row.abandonedReason).toBe('entities_too_long');
    expect(await abandoned('entities_too_long')).toBe(1);
    expect(await failures()).toBe(0);
    expect(await store.pendingCount('telegram')).toBe(0);
    // 状态条的 ChannelDeliveryFailed（roles/server.ts）不把放弃的内容算作投递失败
    const cond = await db.server.query(
      `SELECT channel FROM server.notify_messages WHERE last_error IS NOT NULL AND delivered_hash IS DISTINCT FROM desired_hash
         AND abandoned_at IS NULL AND attempts >= 0`,
    );
    expect(cond.rows).toEqual([]);

    // 之后的同步（内容不变）与投递都不再请求 Telegram
    for (let i = 0; i < 4; i++) {
      now += 15 * 60_000;
      await engine.syncOnce();
      expect(await engine.deliverOnce()).toBe(0);
    }
    expect(bot.requests).toHaveLength(2);
    // 重启后也不重试
    engine = newEngine();
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toHaveLength(2);

    // 内容变化：清除放弃，重新尝试
    bot.rejectHtml = null;
    bot.rejectPlain = null;
    source.items = [retitle(d, '事件改名')];
    await engine.syncOnce();
    expect((await rowOf(d.incidentId)).abandonedAt).toBeNull();
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests).toHaveLength(3);
  });

  it('message is not modified 按成功处理，不计入失败', async () => {
    const d = small();
    source.items = [d];
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    // 渠道上的消息已是最新内容，但库里没有记下（例如送达后进程退出）
    await db.admin.query('UPDATE server.notify_messages SET delivered_hash = NULL');
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests.map((r) => r.method)).toEqual(['sendMessage', 'editMessageText']);
    const row = await rowOf(d.incidentId);
    expect(row.deliveredHash).toBe(row.desiredHash);
    expect(row.abandonedAt).toBeNull();
    expect(await failures()).toBe(0);
  });

  it('群的问题（chat not found）不是内容问题：照常 5 分钟后重试并计入投递失败', async () => {
    source.items = [small()];
    bot.rejectHtml = 'Bad Request: chat not found';
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toHaveLength(1);
    expect(await failures()).toBe(1);
    const r = await db.admin.query<{ next_attempt_at: Date; abandoned_at: Date | null }>(
      'SELECT next_attempt_at, abandoned_at FROM server.notify_messages',
    );
    expect(r.rows[0]!.abandoned_at).toBeNull();
    expect(r.rows[0]!.next_attempt_at.getTime()).toBe(now + 5 * 60_000);
  });
});

describe('已结束事件的编辑上限与最后一次编辑（ADR 0145、0173）', () => {
  /** 恢复后发出第一条，再成功编辑满上限次 */
  async function editedToCap(): Promise<DesiredIncidentMessage> {
    let d = small({ state: 'resolved', endedAt: new Date(T0), lane: 'recovery' });
    source.items = [d];
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    expect((await rowOf(d.incidentId)).endedEdits).toBe(0);
    for (let i = 1; i <= MAX_ENDED_EDITS; i++) {
      d = retitle(d, `恢复后第 ${i} 次更新`);
      source.items = [d];
      now += 10_000;
      await engine.syncOnce();
      expect(await engine.deliverOnce()).toBe(1);
      expect((await rowOf(d.incidentId)).endedEdits).toBe(i);
    }
    expect(bot.requests).toHaveLength(1 + MAX_ENDED_EDITS);
    return d;
  }

  const records = async (incidentId: string) =>
    (
      await db.admin.query<{ code: string; ref: string | null }>(
        "SELECT code, ref FROM server.incident_reasons WHERE incident_id = $1 AND stage = 'notify' ORDER BY id",
        [incidentId],
      )
    ).rows.map((r) => [r.code, r.ref]);

  it(`成功编辑满 ${MAX_ENDED_EDITS} 次后内容再变化：最后一次编辑为精简内容加说明行与控制台链接，之后不再编辑；重新触发后计数清零`, async () => {
    let d = await editedToCap();
    d = retitle(d, '再一次更新');
    source.items = [d];
    now += 10_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests).toHaveLength(2 + MAX_ENDED_EDITS);
    const last = bot.requests.at(-1)!;
    expect(last.method).toBe('editMessageText');
    const parsed = parseTelegramHtml(String(last.body.text));
    expect(parsed.text).toContain('再一次更新');
    expect(parsed.text).toContain('消息停止更新（原因：编辑次数达到上限），完整内容见控制台');
    expect(String(last.body.text)).toContain('<a href="https://srenautix.example.test/i/1">控制台</a>');
    // 只留打开控制台的按钮
    expect(JSON.stringify(last.body.reply_markup)).toContain('https://srenautix.example.test/i/1');
    const row = await rowOf(d.incidentId);
    expect(row.finalEditedAt?.getTime()).toBe(now);
    expect(row.abandonedAt).toBeNull();
    expect(await records(d.incidentId)).toEqual([
      ['delivered', `telegram:${CHAT}`],
      ['final_edit', `telegram:${CHAT}`],
    ]);

    // 之后内容再变化：不再请求 Telegram，不算放弃
    for (let i = 0; i < 3; i++) {
      source.items = [retitle(d, `之后第 ${i} 次更新`)];
      now += 10_000;
      await engine.syncOnce();
      expect(await engine.deliverOnce()).toBe(0);
    }
    expect(bot.requests).toHaveLength(2 + MAX_ENDED_EDITS);
    expect(await store.pendingCount('telegram')).toBe(0);
    expect(await abandoned('ended_edit_cap')).toBe(0);

    // 事件重新触发：不再是已结束，计数与最后一次编辑清零，照常编辑
    source.items = [{ ...retitle(d, '重新触发'), state: 'firing', endedAt: null, lane: 'urgent' }];
    now += 10_000;
    await engine.syncOnce();
    const fired = await rowOf(d.incidentId);
    expect(fired.endedEdits).toBe(0);
    expect(fired.finalEditedAt).toBeNull();
    expect(await engine.deliverOnce()).toBe(1);
    expect(bot.requests).toHaveLength(3 + MAX_ENDED_EDITS);
  });

  it('最后一次编辑也被拒绝时才放弃（ended_edit_cap），事件仍已结束时内容再变化也不重试', async () => {
    let d = await editedToCap();
    bot.rejectHtml = 'Bad Request: ENTITIES_TOO_LONG';
    bot.rejectPlain = 'Bad Request: message is too long';
    d = retitle(d, '再一次更新');
    source.items = [d];
    now += 10_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    // 原格式与纯文本各一次
    expect(bot.requests).toHaveLength(3 + MAX_ENDED_EDITS);
    const row = await rowOf(d.incidentId);
    expect(row.abandonedReason).toBe('ended_edit_cap');
    expect(row.finalEditedAt).toBeNull();
    expect(await abandoned('ended_edit_cap')).toBe(1);
    expect(await abandoned('entities_too_long')).toBe(0);
    expect(await failures()).toBe(0);
    expect((await records(d.incidentId)).map((r) => r[0])).toEqual(['delivered', 'ended_edit_cap']);
    const terminal = (await metrics.terminalStates.get()).values.find(
      (v) => v.labels.stage === 'notify' && v.labels.code === 'ended_edit_cap',
    );
    expect(terminal?.labels.level).toBe('error');
    expect(terminal?.value).toBe(1);

    bot.rejectHtml = null;
    bot.rejectPlain = null;
    source.items = [retitle(d, '又一次更新')];
    now += 10_000;
    await engine.syncOnce();
    expect(await engine.deliverOnce()).toBe(0);
    expect(bot.requests).toHaveLength(3 + MAX_ENDED_EDITS);
    expect((await rowOf(d.incidentId)).abandonedReason).toBe('ended_edit_cap');
  });

  it('被渠道拒绝的编辑不计数：恢复后的编辑反复被拒绝时照常 5 分钟后重试，渠道恢复后编辑成功', async () => {
    let d = small({ state: 'resolved', endedAt: new Date(T0), lane: 'recovery' });
    source.items = [d];
    await engine.syncOnce();
    await engine.deliverOnce();
    // 普通拒绝（不是永久错误）：照常 5 分钟后重试，不消耗编辑次数
    bot.rejectHtml = 'Bad Request: chat not found';
    d = retitle(d, '恢复后的更新');
    source.items = [d];
    await engine.syncOnce();
    for (let i = 0; i < MAX_ENDED_EDITS + 3; i++) {
      now += 5 * 60_000;
      await engine.deliverOnce();
    }
    expect(bot.requests).toHaveLength(1 + MAX_ENDED_EDITS + 3);
    const rejected = await rowOf(d.incidentId);
    expect(rejected.endedEdits).toBe(0);
    expect(rejected.abandonedAt).toBeNull();
    bot.rejectHtml = null;
    now += 5 * 60_000;
    expect(await engine.deliverOnce()).toBe(1);
    expect((await rowOf(d.incidentId)).endedEdits).toBe(1);
  });
});

describe('迁移（ADR 0145）', () => {
  it('只加列：旧代码的写入照常，新列取默认值；放弃时间与原因同时有或同时没有', async () => {
    const r = await db.admin.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'server' AND table_name = 'notify_messages'
          AND column_name IN ('render_version', 'ended', 'ended_edits', 'abandoned_at', 'abandoned_reason', 'final_edited_at')
        ORDER BY column_name`,
    );
    expect(r.rows.map((x) => [x.column_name, x.is_nullable])).toEqual([
      ['abandoned_at', 'YES'],
      ['abandoned_reason', 'YES'],
      ['ended', 'NO'],
      ['ended_edits', 'NO'],
      ['final_edited_at', 'YES'],
      ['render_version', 'YES'],
    ]);
    await expect(
      db.admin.query(
        `INSERT INTO server.notify_messages (channel, chat, kind, subject, incident_id, lane, desired_payload, desired_hash,
           desired_at, next_attempt_at, created_at, abandoned_at)
         VALUES ('telegram', $1, 'incident', $2::text, $2::uuid, 'edit', '{}', 'h', now(), now(), now(), now())`,
        [CHAT, '7a1c2a9e-8b3d-4c1e-9a7f-dddddddddddd'],
      ),
    ).rejects.toThrow(/notify_messages_abandoned_check/);
  });
});
