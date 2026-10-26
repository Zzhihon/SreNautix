import type { Channel, Disposition } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import type { TelegramPayload } from '../../src/channels/telegram/render.js';
import type { TgUpdate, TgUser } from '../../src/channels/telegram/types.js';
import { TelegramUpdates, WEBHOOK_PATH } from '../../src/channels/telegram/updates.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import { NotifyEngine } from '../../src/notify/engine.js';
import { Interactions, NOT_LINKED_TEXT, REPLY_WINDOW_MS } from '../../src/notify/interactions.js';
import { incidentTrack } from '../../src/incident/migrations.js';
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
import { fixture, fixtureFile, FixtureServer, type FixtureResponse } from '../support/fixture-server.js';

const TOKEN = 'test-token';
const CHAT = '-1001234567890';
const SECRET = 'webhook-secret-0123456789abcdef';
const T0 = Date.parse('2026-10-20T00:00:00Z');
const ALICE: TgUser = { id: 111111, is_bot: false, first_name: 'Alice', username: 'alice_oncall' };
const BOB: TgUser = { id: 222222, is_bot: false, first_name: 'Bob' };
const INCIDENT = '6f1c2a9e-8b3d-4c1e-9a7f-2d5e8b4c1c01';
const RUN = '6f1c2e8a-3b9d-4c1e-9f3a-1b2c3d4e5f60';
const P_L = '00000000-0000-4000-8000-000000000101';
const P_H = '00000000-0000-4000-8000-000000000102';

/** NotifyActions 的测试实现：按测试数据决定绑定关系与结果，记录每次调用。 */
class RecordingActions implements NotifyActions {
  calls: Array<{ op: string; principal: string | null; args: unknown[] }> = [];
  links = new Map<string, string>();
  codes = new Map<string, string>([['ABCD2345', 'oidc:alice']]);
  outcome: ActionOutcome = { ok: true, message: '已完成' };

  private rec(op: string, actor: ChannelActor | null, ...args: unknown[]): ActionOutcome {
    this.calls.push({ op, principal: actor?.principalId ?? null, args });
    return this.outcome;
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
  async feedbackRoot(a: ChannelActor, t: unknown, v: string, root: string | null, reason: string | null) {
    return this.rec('feedbackRoot', a, t, v, root, reason);
  }
  async feedbackDisposition(a: ChannelActor, t: unknown, v: string, d: Disposition | null) {
    return this.rec('feedbackDisposition', a, t, v, d);
  }
  async resolvedConfirm(a: ChannelActor, id: string, version: number) {
    return this.rec('resolvedConfirm', a, id, version);
  }
  async link(channel: Channel, user: string, code: string): Promise<ActionOutcome> {
    this.calls.push({ op: 'link', principal: null, args: [channel, user, code] });
    const p = this.codes.get(code);
    if (!p) {
      return { ok: false, code: 'invalid', message: '绑定码无效或已过期' };
    }
    this.links.set(`${channel}:${user}`, p);
    return { ok: true, message: `已绑定到 ${p}` };
  }
  async linkedPrincipal(channel: Channel, user: string) {
    return this.links.get(`${channel}:${user}`) ?? null;
  }
  async linkByUnionId() {
    return null;
  }
}

function desired(): DesiredIncidentMessage {
  const target = (
    key: string,
    kind: DesiredIncidentMessage['targets'][number]['kind'],
    over: Partial<DesiredIncidentMessage['targets'][number]> = {},
  ) => ({
    key,
    kind,
    incidentId: INCIDENT,
    incidentVersion: 2,
    proposalId: null,
    tier: null,
    researchRunId: RUN,
    rootComponent: null,
    disposition: null,
    choices: [],
    ...over,
  });
  return {
    incidentId: INCIDENT,
    clusterId: 'prod',
    label: 'Deployment:shop/worker:2026-10-20T00:00:00Z',
    severity: 'critical',
    state: 'firing',
    firstFiringAt: new Date(T0),
    endedAt: null,
    lane: 'urgent',
    language: 'zh',
    message: {
      incident_id: INCIDENT,
      incident_version: 2,
      prefix: '',
      severity: 'critical',
      title: 'Deployment shop/worker 不可用',
      banner: null,
      sections: [],
      buttons: [
        { kind: 'approve', label: '批准 #1', callback: 'l:approve', url: null },
        { kind: 'reject', label: '拒绝 #1', callback: 'l:reject', url: null },
        { kind: 'approve', label: '批准 #2', callback: 'h:approve', url: null },
        { kind: 'feedback_confirm', label: '结论对', callback: 'fb:ok', url: null },
        { kind: 'feedback_reject', label: '结论错', callback: 'fb:bad', url: null },
        { kind: 'disposition_confirm', label: '处置对', callback: 'dp:ok', url: null },
        { kind: 'disposition_reject', label: '处置错', callback: 'dp:bad', url: null },
      ],
    },
    targets: [
      target('l:approve', 'approve', { proposalId: P_L, tier: 'L', researchRunId: null }),
      target('l:reject', 'reject', { proposalId: P_L, tier: 'L', researchRunId: null }),
      target('h:approve', 'approve', { proposalId: P_H, tier: 'H', researchRunId: null }),
      target('fb:ok', 'feedback_confirm', { rootComponent: 'Deployment:shop/worker' }),
      target('fb:bad', 'feedback_reject', {
        choices: ['Deployment:shop/worker', 'Node:node-3', 'postgres.cluster:data/pg'],
      }),
      target('dp:ok', 'disposition_confirm'),
      target('dp:bad', 'disposition_reject'),
    ],
  };
}

const sendOk = (id: number): FixtureResponse => {
  const f = fixture('telegram', 'send-message.ok');
  const body = f.body as { result: { message_id: number } };
  return { status: 200, body: { ...body, result: { ...body.result, message_id: id } } };
};

let db: TestDb;
let fs: FixtureServer;
let app: FastifyInstance;
let now: number;
let actions: RecordingActions;
let store: NotifyStore;
let engine: NotifyEngine;
let updates: TelegramUpdates;
let seq = 0;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack, incidentTrack, notifyTrack]);
  fs = new FixtureServer();
  await fs.start();
});

afterAll(async () => {
  await app?.close();
  await fs.stop();
  await db.close();
});

beforeEach(async () => {
  await db.admin.query(
    `TRUNCATE server.notify_messages, server.notify_storm_members, server.notify_storms, server.notify_pending_replies,
       server.notify_buttons, server.notify_callbacks, server.notify_action_results, server.telegram_poll_state CASCADE`,
  );
  fs.requests.length = 0;
  for (const p of ['sendMessage', 'editMessageText', 'answerCallbackQuery', 'setWebhook', 'getUpdates']) {
    fs.reset('POST', `/bot${TOKEN}/${p}`);
  }
  fs.on('POST', `/bot${TOKEN}/sendMessage`, [
    sendOk(101),
    sendOk(102),
    sendOk(103),
    sendOk(104),
    sendOk(105),
    sendOk(106),
  ]);
  fs.on('POST', `/bot${TOKEN}/editMessageText`, [fixture('telegram', 'edit-message-text.ok')]);
  fs.on('POST', `/bot${TOKEN}/answerCallbackQuery`, [fixture('telegram', 'answer-callback-query.ok')]);
  fs.on('POST', `/bot${TOKEN}/setWebhook`, [fixture('telegram', 'set-webhook.ok')]);
  now = T0;
  actions = new RecordingActions();
  store = new NotifyStore(db.server);
  const metrics = new ServerMetrics('server', false);
  const client = new TelegramClient(fs.url, TOKEN);
  const adapter = new TelegramAdapter(
    client,
    [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
    { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 0 },
    '',
  );
  const interactions = new Interactions(store, actions, metrics, () => undefined);
  const source: MessageSource = { desired: async () => [desired()], delivered: async () => undefined };
  engine = new NotifyEngine(store, [adapter], source, interactions, metrics, {
    prefix: '',
    consoleUrl: null,
    digestRetentionMs: 6 * 3_600_000,
    now: () => now,
  });
  updates = new TelegramUpdates({
    client,
    store,
    interactions,
    limiter: engine.limiter('telegram'),
    metrics,
    chats: new Map([[CHAT, 'zh']]),
    now: () => now,
  });
  await app?.close();
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  updates.registerWebhook(app, SECRET);
  await app.ready();
  await engine.syncOnce();
  await engine.deliverOnce();
});

async function callbackData(label: string): Promise<string> {
  const row = (await store.messages('telegram', CHAT, 'incident'))[0]!;
  const b = (row.payload as TelegramPayload).reply_markup.inline_keyboard.flat().find((x) => x.text === label);
  if (!b?.callback_data) {
    throw new Error(`消息中没有按钮 ${label}`);
  }
  return b.callback_data;
}

async function post(update: TgUpdate, secret = SECRET): Promise<number> {
  const r = await app.inject({
    method: 'POST',
    url: WEBHOOK_PATH,
    headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' },
    payload: JSON.stringify(update),
  });
  return r.statusCode;
}

const base = fixtureFile<{ update: TgUpdate }>('telegram', 'update-callback-query.json').update;
const replyBase = fixtureFile<{ update: TgUpdate }>('telegram', 'update-reply.json').update;

async function click(label: string, from = ALICE, id = `cb-${++seq}`, data?: string): Promise<string> {
  const before = fs.calls('POST', `/bot${TOKEN}/answerCallbackQuery`).length;
  const status = await post({
    ...base,
    update_id: 900000 + seq,
    callback_query: { ...base.callback_query!, id, from, data: data ?? (await callbackData(label)) },
  });
  expect(status).toBe(200);
  const answers = fs.calls('POST', `/bot${TOKEN}/answerCallbackQuery`);
  expect(answers.length).toBe(before + 1);
  return (answers[answers.length - 1]!.body as { text: string }).text;
}

async function reply(promptId: number, text: string, from = ALICE): Promise<void> {
  const status = await post({
    ...replyBase,
    update_id: 910000 + ++seq,
    message: {
      ...replyBase.message!,
      message_id: 500 + seq,
      from,
      text,
      reply_to_message: { ...replyBase.message!.reply_to_message!, message_id: promptId },
    },
  });
  expect(status).toBe(200);
}

const link = () => actions.links.set(`telegram:${ALICE.id}`, 'oidc:alice');
const lastSent = () => fs.calls('POST', `/bot${TOKEN}/sendMessage`).at(-1)!.body as Record<string, unknown>;

describe('Telegram webhook 与按钮', () => {
  it('secret token 不匹配时拒绝，不处理更新', async () => {
    expect(
      await post(
        { ...base, callback_query: { ...base.callback_query!, data: await callbackData('批准 #1') } },
        'wrong',
      ),
    ).toBe(401);
    expect(fs.calls('POST', `/bot${TOKEN}/answerCallbackQuery`)).toHaveLength(0);
  });

  it('setWebhook 带回调地址、secret_token 与订阅的更新类型', async () => {
    await updates.setWebhook('https://srenautix.example.com/', SECRET);
    expect(fs.calls('POST', `/bot${TOKEN}/setWebhook`)[0]!.body).toEqual({
      url: `https://srenautix.example.com${WEBHOOK_PATH}`,
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('未绑定账号点批准：提示绑定，不调用 server', async () => {
    expect(await click('批准 #1')).toBe(NOT_LINKED_TEXT);
    expect(actions.calls).toEqual([]);
  });

  it('/link 绑定后批准 L 档提议；重复投递只应答一次，按钮被第一个回调独占', async () => {
    const linkUpdate = fixtureFile<{ response: { body: { result: TgUpdate[] } } }>('telegram', 'get-updates.json')
      .response.body.result[0]!;
    expect(await post(linkUpdate)).toBe(200);
    expect(actions.calls[0]).toEqual({ op: 'link', principal: null, args: ['telegram', '111111', 'ABCD2345'] });
    expect(lastSent().text).toBe('已绑定到 oidc:alice');
    expect(lastSent().chat_id).toBe(111111);

    expect(await click('批准 #1', ALICE, 'cb-approve')).toBe('已提交，结果见消息');
    expect(actions.calls.filter((c) => c.op === 'approve')).toEqual([
      { op: 'approve', principal: 'oidc:alice', args: [P_L] },
    ]);
    // 同一回调重复投递
    expect(await click('批准 #1', ALICE, 'cb-approve')).toBe('已提交，结果见消息');
    // 其他成员再点
    actions.links.set(`telegram:${BOB.id}`, 'oidc:bob');
    expect(await click('批准 #1', BOB)).toBe('该按钮已被处理');
    expect(actions.calls.filter((c) => c.op === 'approve')).toHaveLength(1);

    // 结果写回消息的“最近操作”
    await engine.syncOnce();
    await engine.deliverOnce();
    const text = String((fs.calls('POST', `/bot${TOKEN}/editMessageText`).at(-1)!.body as { text: string }).text);
    expect(text).toContain('00:00 UTC @alice_oncall 批准：已完成');
  });

  it('H 档提议不能在聊天里批准', async () => {
    link();
    expect(await click('批准 #2')).toBe('这个提议需要在控制台审批（H 档，需要重新认证）');
    expect(actions.calls).toEqual([]);
  });

  it('server 暂时无法处理时释放按钮，可以再点', async () => {
    link();
    actions.outcome = { ok: false, code: 'unavailable', message: '暂时无法处理' };
    expect(await click('批准 #1')).toBe('已提交，结果见消息');
    actions.outcome = { ok: true, message: '已批准' };
    expect(await click('批准 #1')).toBe('已提交，结果见消息');
    expect(actions.calls.filter((c) => c.op === 'approve')).toHaveLength(2);
  });

  it('拒绝：提示以提及点击者开头并带 ForceReply；只有点击者在 5 分钟内的回复作为原因提交', async () => {
    link();
    expect(await click('拒绝 #1')).toBe('请在 5 分钟内回复机器人的提示消息，填写拒绝原因');
    const prompt = lastSent();
    expect(String(prompt.text).startsWith('@alice_oncall，请回复本消息填写拒绝原因')).toBe(true);
    expect(prompt.entities).toEqual([{ type: 'mention', offset: 0, length: '@alice_oncall'.length }]);
    expect(prompt.reply_markup).toEqual({ force_reply: true, selective: true, input_field_placeholder: '拒绝原因' });
    expect(prompt.reply_parameters).toBeUndefined();
    const promptId = 102;
    // 等待期间其他成员点同一个按钮
    actions.links.set(`telegram:${BOB.id}`, 'oidc:bob');
    expect(await click('拒绝 #1', BOB)).toBe('其他成员正在填写，见提示消息');
    // 其他成员的回复不算
    await reply(promptId, '不同意', BOB);
    expect(actions.calls).toEqual([]);
    // 超长原因要求重新回复
    await reply(promptId, '长'.repeat(501));
    expect(String(lastSent().text)).toContain('原因最长 500 字');
    await reply(promptId, '目标副本只剩 1 个，先扩容再重启');
    expect(actions.calls).toEqual([
      { op: 'reject', principal: 'oidc:alice', args: [P_L, '目标副本只剩 1 个，先扩容再重启'] },
    ]);
    // 已提交后再回复不重复提交
    await reply(promptId, '再说一次');
    expect(actions.calls).toHaveLength(1);
  });

  it('拒绝原因 5 分钟内没有填写：不提交，按钮释放，消息记一条结果', async () => {
    link();
    await click('拒绝 #1');
    now += REPLY_WINDOW_MS;
    await engine.syncOnce();
    await reply(102, '晚了');
    expect(actions.calls).toEqual([]);
    const r = await db.admin.query<{ action: string; message: string }>(
      'SELECT action, message FROM server.notify_action_results',
    );
    expect(r.rows).toEqual([{ action: 'reject_timeout', message: '5 分钟内未填写原因，未提交' }]);
    expect(await click('拒绝 #1')).toBe('请在 5 分钟内回复机器人的提示消息，填写拒绝原因');
  });

  it('结论对立即提交；结论错的回复给出真实根因（无法识别时说明，"-" 表示不知道）', async () => {
    link();
    expect(await click('结论对')).toBe('已提交，结果见消息');
    expect(actions.calls[0]!.args.slice(1)).toEqual(['confirmed', 'Deployment:shop/worker', null]);
    // 反馈按钮提交后释放，可以再点（改判）
    expect(await click('结论错')).toBe('请在 5 分钟内回复机器人的提示消息，填写真实根因组件');
    expect(String(lastSent().text)).toContain('可选：Deployment:shop/worker、Node:node-3、postgres.cluster:data/pg');
    await reply(102, 'redis 慢');
    expect(String(lastSent().text)).toContain('无法识别组件“redis”');
    await reply(102, 'node-3 磁盘写满');
    expect(actions.calls[1]!.args.slice(1)).toEqual(['rejected', 'Node:node-3', '磁盘写满']);
    expect(await click('结论错')).toBe('请在 5 分钟内回复机器人的提示消息，填写真实根因组件');
    // 103 是对无法识别组件的说明，第二次提示是 104
    await reply(104, '-');
    expect(actions.calls[2]!.args.slice(1)).toEqual(['rejected', null, null]);
  });

  it('处置错：发出只有点击者能用的选择按钮', async () => {
    link();
    actions.links.set(`telegram:${BOB.id}`, 'oidc:bob');
    expect(await click('处置错')).toBe('请选择正确的处置判断');
    const choose = lastSent();
    const kb = (choose.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard;
    expect(kb[0]!.map((b) => b.text)).toEqual(['处理', '忽略', '升级', '无法判定']);
    const escalate = kb[0]![2]!.callback_data;
    expect(await click('', BOB, undefined, escalate)).toBe('只有发起这次反馈的成员可以选择');
    expect(await click('', ALICE, undefined, escalate)).toBe('已提交，结果见消息');
    expect(actions.calls).toHaveLength(1);
    expect(actions.calls[0]!.op).toBe('feedbackDisposition');
    expect(actions.calls[0]!.args.slice(1)).toEqual(['rejected', 'escalate']);
  });

  it('回调已过期时应答失败不影响操作；其他群与无效按钮不处理', async () => {
    link();
    fs.reset('POST', `/bot${TOKEN}/answerCallbackQuery`).on('POST', `/bot${TOKEN}/answerCallbackQuery`, [
      fixture('telegram', 'answer-callback-query.expired'),
    ]);
    await click('结论对');
    expect(actions.calls).toHaveLength(1);
    const before = fs.requests.length;
    const other = {
      ...base.callback_query!,
      id: 'cb-other',
      message: { ...base.callback_query!.message!, chat: { id: -1009999999999, type: 'supergroup' } },
      data: await callbackData('结论对'),
    };
    expect(await post({ ...base, callback_query: other })).toBe(200);
    expect(fs.requests.length).toBe(before);
    expect(await click('', ALICE, 'cb-bad', 'b:AAAAAAAAAAAAAAAA')).toBe('按钮已失效，请在控制台操作');
  });

  it('长轮询：处理更新并持久化 offset', async () => {
    fs.on('POST', `/bot${TOKEN}/getUpdates`, [
      fixture('telegram', 'get-updates'),
      { status: 200, body: { ok: true, result: [] }, delayMs: 20 },
    ]);
    const ac = new AbortController();
    const loop = updates.pollLoop(ac.signal, () => true);
    for (let i = 0; i < 100 && (await store.pollOffset()) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    await loop;
    expect(await store.pollOffset()).toBe(870002);
    expect(actions.calls[0]!.op).toBe('link');
    const req = fs.calls('POST', `/bot${TOKEN}/getUpdates`);
    expect(req[0]!.body).toEqual({
      offset: 0,
      limit: 100,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });
    expect((req[1]!.body as { offset: number }).offset).toBe(870002);
  });
});
