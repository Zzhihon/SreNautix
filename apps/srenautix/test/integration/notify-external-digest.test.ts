import { randomUUID } from 'node:crypto';
import type { Channel, EvidenceResult, Incident } from '@srenautix/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { ServerMetrics } from '../../src/metrics.js';
import { NotifyEngine } from '../../src/notify/engine.js';
import { ExternalRoots, externalTypeLookup } from '../../src/notify/external.js';
import { Interactions } from '../../src/notify/interactions.js';
import { NO_LINKS } from '../../src/notify/links.js';
import type { ActionOutcome, NotifyActions } from '../../src/notify/ports.js';
import { PgMessageSource, ReportSource } from '../../src/notify/source.js';
import { NotifyStore } from '../../src/notify/store.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import type { ProposalService } from '../../src/proposals/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fixture, FixtureServer } from '../support/fixture-server.js';
import { incident as baseIncident, stageA } from '../support/scenario.js';
import { parseTelegramHtml } from '../support/telegram-html.js';

// 外部上游的周期汇总（ADR 0147）：真实 PostgreSQL 上的事件、阶段 A 报告与告警，经 PgMessageSource 分类，
// 由投递引擎发到本地回放的 Bot API

const TOKEN = 'test-token';
const CHAT = '-1001234567890';
const CLUSTER = 'cchp';
const send = `/bot${TOKEN}/sendMessage`;
const edit = `/bot${TOKEN}/editMessageText`;
const H10 = Date.parse('2026-10-24T10:00:00Z');
const min = (m: number) => new Date(H10 + m * 60_000);

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

let db: TestDb;
let fs: FixtureServer;
let now: number;
let engine: NotifyEngine;
let source: PgMessageSource;

const TYPES = [
  { id: 'cchp.provider', external: true, match: { kind: 'provider' } },
  { id: 'cchp.component-provider', match: { kind: 'component', name_pattern: '^(provider|business)$' } },
];

async function insertAlert(a: {
  alertname: string;
  labels: Record<string, string>;
  severity: 'critical' | 'warning';
  startsAt: Date;
  endsAt: Date | null;
  component: string | null;
}): Promise<string> {
  const fp = randomUUID().replace(/-/g, '').slice(0, 16);
  const id = `${fp}@${Math.floor(a.startsAt.getTime() / 1000)}`;
  await db.server.query(
    `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status,
       suppressed, starts_at, ends_at, classification, entity_resolution, component, received_at, last_seen_at, updated_at)
     VALUES ($1, $2, $3, 'alertmanager', $4, $5, '{}', $6, $7, 'none', $8, $9,
       '{"role":"symptom","source":"label","confidence":1,"catalog_entry":null,"chronic":false}', 'labels', $10, now(), now(), now())`,
    [
      id,
      CLUSTER,
      fp,
      a.alertname,
      JSON.stringify({ alertname: a.alertname, severity: a.severity, ...a.labels }),
      a.severity,
      a.endsAt ? 'resolved' : 'firing',
      a.startsAt,
      a.endsAt,
      a.component,
    ],
  );
  return id;
}

/** 一个外部上游的事件：一条成员告警、根因上的一张卡（provider 故障率）与可读名称 */
async function seedIncident(o: {
  root: string;
  name: string | null;
  alertname: string;
  labels?: Record<string, string>;
  at: Date;
  ended: Date | null;
  value?: string;
  severity?: 'critical' | 'warning';
}): Promise<string> {
  const severity = o.severity ?? 'warning';
  const alertId = await insertAlert({
    alertname: o.alertname,
    labels: o.labels ?? {},
    severity,
    startsAt: o.at,
    endsAt: o.ended,
    component: o.root,
  });
  const base = baseIncident();
  const id = randomUUID();
  const [kind, name] = o.root.split(':') as [string, string];
  const inc: Incident = {
    ...base,
    incident_id: id,
    cluster_id: CLUSTER,
    label: `${o.root}:${o.at.toISOString()}`,
    incident_version: 1,
    state: o.ended ? 'resolved' : 'firing',
    severity,
    first_firing_at: o.at.toISOString(),
    ended_at: o.ended ? o.ended.toISOString() : null,
    root: { component: o.root, entity: null, ambiguous: false, margin: 0.5, silent_root: false },
    candidates: [],
    members: [
      {
        alert_id: alertId,
        alertname: o.alertname,
        role: 'symptom',
        component: o.root,
        severity,
        status: o.ended ? 'resolved' : 'firing',
        starts_at: o.at.toISOString(),
        ends_at: o.ended ? o.ended.toISOString() : null,
        joined_version: 1,
        left_version: null,
      },
    ],
    components: [o.root],
    changes: [],
    created_at: o.at.toISOString(),
    updated_at: (o.ended ?? o.at).toISOString(),
  };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at, root_component, body)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
    [id, CLUSTER, inc.label, inc.state, severity, o.at, o.ended, o.root, JSON.stringify(inc)],
  );
  const cards: EvidenceResult[] = o.value
    ? [
        {
          ...stageA().cards[0]!,
          ref: 'card:1',
          card_id: 'cchp/provider/error-ratio',
          title: { 'zh-CN': 'provider 故障率', en: 'Provider fault ratio' },
          entity: { cluster_id: CLUSTER, kind, namespace: null, name, uid: null },
          verdict: 'abnormal',
          display_state: 'abnormal',
          value: o.value,
          threshold: 0.2,
          unit: 'percent',
        },
      ]
    : [];
  const report = { ...stageA(cards), incident_id: id, incident_version: 1, rendered_at: o.at.toISOString() };
  await db.server.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body,
       first_firing_at, rendered_at)
     VALUES ($1, $2, 1, $3, $4, false, $5, $6, $6)`,
    [randomUUID(), id, report.disposition, report.evidence_fingerprint, JSON.stringify(report), o.at],
  );
  if (o.name) {
    await db.server.query(
      'INSERT INTO server.component_names (cluster_id, component, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [CLUSTER, o.root, o.name],
    );
  }
  return id;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  fs = new FixtureServer();
  await fs.start();
});

afterAll(async () => {
  await fs.stop();
  await db.close();
});

beforeEach(async () => {
  await db.admin.query(
    `TRUNCATE server.notify_messages, server.notify_storm_members, server.notify_storms, server.notify_buttons,
       server.notify_external_windows, server.incidents, server.stage_a_reports, server.alert_state, server.component_names CASCADE`,
  );
  fs.requests.length = 0;
  fs.reset('POST', send).reset('POST', edit);
  fs.on('POST', send, [fixture('telegram', 'send-message.ok')]);
  fs.on('POST', edit, [fixture('telegram', 'edit-message-text.ok')]);
  now = min(50).getTime();
  const metrics = new ServerMetrics('server', false);
  const store = new NotifyStore(db.server);
  const reports = new ReportSource(
    db.server,
    new FeedbackService(db.server, metrics),
    new TopologyStore(db.server),
    { alertTitle: () => null, actionVerify: () => null, links: NO_LINKS },
    { prefix: '[影子]', consoleUrl: 'https://srenautix.example.test' },
  );
  const external = new ExternalRoots(
    db.server,
    {
      enabled: true,
      periodMs: 3_600_000,
      components: ['component:provider'],
      alertLabels: { theme: ['provider'] },
      impact: { alertLabels: { layer: ['L0'] }, impactCards: true },
    },
    externalTypeLookup(
      () => TYPES,
      async () => null,
    ),
  );
  source = new PgMessageSource(
    db.server,
    {
      prefix: '[影子]',
      consoleUrl: 'https://srenautix.example.test',
      severities: ['critical', 'warning'],
      resolvedRetentionMs: 6 * 3_600_000,
    },
    { delivered: async () => undefined } as unknown as ProposalService,
    reports,
    external,
  );
  const adapter = new TelegramAdapter(
    new TelegramClient(fs.url, TOKEN),
    [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
    { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 3_000 },
    '[影子]',
  );
  engine = new NotifyEngine(
    store,
    [adapter],
    source,
    new Interactions(store, new NoActions(), metrics, () => undefined),
    metrics,
    {
      prefix: '[影子]',
      consoleUrl: 'https://srenautix.example.test',
      digestRetentionMs: 6 * 3_600_000,
      externalDigestPeriodMs: 3_600_000,
      now: () => now,
    },
  );
});

const sent = () => fs.calls('POST', send).map((r) => r.body as Record<string, unknown>);

async function round(at: Date): Promise<void> {
  now = at.getTime();
  await engine.syncOnce();
  await engine.deliverOnce();
}

const KIMI = 'provider:01a13f9e-132d-7803-9a7e-5c8730c4f01e';
const LCODEX = 'provider:01a13502-db15-7da2-a26d-87d84d75b634';
const YUZI = 'provider:01a154f6-c1dd-710e-b7b2-14352afe477d';

async function seedHour(): Promise<{ kimi: string; lcodex: string; theme: string }> {
  const kimi = await seedIncident({
    root: KIMI,
    name: 'Kimi',
    alertname: 'CCHPProviderErrorRatioCollapse',
    at: min(5),
    ended: null,
    value: '35.2%',
    severity: 'critical',
  });
  const lcodex = await seedIncident({
    root: LCODEX,
    name: 'lcodex',
    alertname: 'CCHPProviderTTFTSlowHigh',
    at: min(20),
    ended: min(42),
    value: '22.0%',
  });
  await seedIncident({ root: YUZI, name: '柚子', alertname: 'CCHPProviderErrorRatioHigh', at: min(31), ended: null });
  // 按主题聚合的升级告警：根因是逻辑组件 component:provider，成员告警带 theme=provider
  const theme = await seedIncident({
    root: 'component:provider',
    name: null,
    alertname: 'AlertThemeEscalated',
    labels: { theme: 'provider', component: 'provider' },
    at: min(40),
    ended: null,
  });
  return { kimi, lcodex, theme };
}

describe('外部上游的周期汇总', () => {
  it('迁移放宽 notify_messages 的 kind 与风暴约束，保留 lane 等其他约束', async () => {
    const r = await db.server.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'server.notify_messages'::regclass AND contype = 'c' ORDER BY conname`,
    );
    const names = r.rows.map((x) => x.conname);
    expect(names).toEqual(expect.arrayContaining(['notify_messages_kind_check', 'notify_messages_storm_check']));
    expect(r.rows.find((x) => x.conname === 'notify_messages_kind_check')!.def).toContain('external_digest');
    expect(r.rows.some((x) => x.def.includes('lane'))).toBe(true);
    expect(r.rows.some((x) => x.def.includes('incident_id IS NOT NULL'))).toBe(true);
  });

  it('一小时内多个 provider 的事件不逐条推送，整点后只发 1 条摘要，之后不再重发', async () => {
    await seedHour();
    await round(min(50));
    expect(sent()).toHaveLength(0);
    // 周期结束后等一分钟再统计
    await round(min(60.5));
    expect(sent()).toHaveLength(0);
    await round(min(61.5));
    expect(sent()).toHaveLength(1);
    const body = sent()[0]!;
    expect(body.disable_notification).toBe(true);
    const { text } = parseTelegramHtml(String(body.text));
    const lines = text.split('\n');
    expect(lines[0]).toBe('[影子] 外部上游汇总 10:00–11:00 UTC');
    expect(text).toContain('本时段 4 个上游有问题（上一时段 0 个）：新增 4、持续 0；未恢复 3、已恢复 1。');
    expect(text).toContain('业务影响：无（业务告警 layer=L0 0 条，影响卡无异常）');
    const items = lines.filter((l) => l.startsWith('- '));
    expect(items).toHaveLength(4);
    expect(items[0]).toBe('- [严重] Kimi provider 故障率 35.2% · 触发 1 次 · 新增 · 未恢复');
    expect(items).toContain('- lcodex provider 故障率 22.0% · 触发 1 次 · 新增 · 10:42 恢复');
    expect(items).toContain('- 柚子 告警 CCHPProviderErrorRatioHigh · 触发 1 次 · 新增 · 未恢复');
    expect(items).toContain('- component:provider 告警 AlertThemeEscalated · 触发 1 次 · 新增 · 未恢复');
    await round(min(65));
    await round(min(90));
    expect(sent()).toHaveLength(1);
    // 统计存了一份：下一时段与它对比
    const w = await db.server.query('SELECT window_start FROM server.notify_external_windows ORDER BY window_start');
    expect(w.rows.map((x) => (x.window_start as Date).toISOString())).toEqual([
      '2026-10-24T09:00:00.000Z',
      '2026-10-24T10:00:00.000Z',
    ]);
  });

  it('伴随业务影响（L0 告警触发）时即时推送仍在触发的上游事件，并标明上游故障已影响业务；issue 照常判定', async () => {
    const { kimi, lcodex, theme } = await seedHour();
    await round(min(50));
    expect(sent()).toHaveLength(0);
    expect(await source.externalState(kimi)).toBe('firing');
    expect(await source.externalState(lcodex)).toBe('ended');
    await insertAlert({
      alertname: 'CCHPErrorBudgetBurnFast',
      labels: { layer: 'L0', component: 'edge-envoy' },
      severity: 'critical',
      startsAt: min(52),
      endsAt: null,
      component: 'component:edge-envoy',
    });
    await round(min(53));
    // 未恢复的三个上游事件即时推送；已经恢复的 lcodex 不推送。三条新消息开启一次风暴，另有一条风暴汇总
    const texts = sent().map((b) => parseTelegramHtml(String(b.text)).text);
    const incidents = texts.filter((t) => t.includes('上游故障已影响业务：CCHPErrorBudgetBurnFast'));
    expect(incidents).toHaveLength(3);
    expect(texts.some((t) => t.includes('lcodex'))).toBe(false);
    expect(await source.externalState(kimi)).toBeNull();
    expect(await source.externalState(theme)).toBeNull();
    // 整点的摘要仍然发出，写明业务影响与已即时推送
    fs.requests.length = 0;
    await round(min(61.5));
    const digest = sent()
      .map((b) => parseTelegramHtml(String(b.text)).text)
      .find((t) => t.includes('外部上游汇总'));
    expect(digest).toContain('业务影响：CCHPErrorBudgetBurnFast（10:52 起，未恢复），相关事件已即时推送');
    expect(digest).toContain('- [严重] Kimi provider 故障率 35.2% · 触发 1 次 · 新增 · 未恢复 · 波及业务，已即时推送');
  });

  it('关闭外部上游汇总时照常逐条推送', async () => {
    const off = new PgMessageSource(
      db.server,
      {
        prefix: '[影子]',
        consoleUrl: 'https://srenautix.example.test',
        severities: ['critical', 'warning'],
        resolvedRetentionMs: 6 * 3_600_000,
      },
      { delivered: async () => undefined } as unknown as ProposalService,
      new ReportSource(
        db.server,
        new FeedbackService(db.server, new ServerMetrics('server', false)),
        new TopologyStore(db.server),
        { alertTitle: () => null, actionVerify: () => null, links: NO_LINKS },
        { prefix: '[影子]', consoleUrl: 'https://srenautix.example.test' },
      ),
      null,
    );
    await seedIncident({
      root: KIMI,
      name: 'Kimi',
      alertname: 'CCHPProviderErrorRatioCollapse',
      at: min(5),
      ended: null,
    });
    const d = await off.desired('zh');
    expect(d).toHaveLength(1);
    expect(d[0]!.digest).toBeUndefined();
    expect(off.externalWindow).toBeUndefined();
    expect(await off.externalState(d[0]!.incidentId)).toBeNull();
  });
});
