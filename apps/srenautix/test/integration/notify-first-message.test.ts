import { randomUUID } from 'node:crypto';
import type { Channel, Incident } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { ServerMetrics } from '../../src/metrics.js';
import { NotifyEngine } from '../../src/notify/engine.js';
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

// 首条消息时延（ADR 0159）：从事件的计时起点（新事件为首个告警触发，拆分出的事件为拆分时刻）到这个事件第一条
// 事件消息送达；两个渠道目标只记第一条；business_impact 按 notify.business_impact_alerts 判定。
// 原事件开始 57 分钟后拆出的事件继承原事件的首个告警时刻，从首个告警计时会记成 57 分钟。

const TOKEN = 'test-token';
const CHATS = ['-1001234567890', '-1001234567891'];
const CLUSTER = 'east';
const send = `/bot${TOKEN}/sendMessage`;
const T0 = Date.parse('2026-10-25T10:25:00Z');
const sec = (s: number) => new Date(T0 + s * 1000);

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
let now = T0;
let engine: NotifyEngine;
const metrics = new ServerMetrics('server', false);

async function seed(o: {
  root: string;
  alertname: string;
  labels: Record<string, string>;
  severity: 'critical' | 'warning';
  firstFiring: Date;
  created: Date;
  splitFrom: string | null;
}): Promise<string> {
  const fp = randomUUID().replace(/-/g, '').slice(0, 16);
  const alertId = `${fp}@${Math.floor(o.firstFiring.getTime() / 1000)}`;
  await db.server.query(
    `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status,
       suppressed, starts_at, ends_at, classification, entity_resolution, component, received_at, last_seen_at, updated_at)
     VALUES ($1, $2, $3, 'reconcile', $4, $5, '{}', $6, 'firing', 'none', $7, NULL,
       '{"role":"symptom","source":"label","confidence":1,"catalog_entry":null,"chronic":false}', 'labels', $8, now(), now(), now())`,
    [
      alertId,
      CLUSTER,
      fp,
      o.alertname,
      JSON.stringify({ alertname: o.alertname, severity: o.severity, ...o.labels }),
      o.severity,
      o.firstFiring,
      o.root,
    ],
  );
  const id = randomUUID();
  const inc: Incident = {
    ...baseIncident(),
    incident_id: id,
    cluster_id: CLUSTER,
    label: `${o.root}:${o.firstFiring.toISOString()}`,
    incident_version: 1,
    state: 'firing',
    severity: o.severity,
    first_firing_at: o.firstFiring.toISOString(),
    ended_at: null,
    root: { component: o.root, entity: null, ambiguous: false, margin: 0.5, silent_root: false },
    candidates: [],
    members: [
      {
        alert_id: alertId,
        alertname: o.alertname,
        role: 'symptom',
        component: o.root,
        severity: o.severity,
        status: 'firing',
        starts_at: o.firstFiring.toISOString(),
        ends_at: null,
        joined_version: 1,
        left_version: null,
      },
    ],
    components: [o.root],
    changes: [],
    split_from: o.splitFrom,
    created_at: o.created.toISOString(),
    updated_at: o.created.toISOString(),
  };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component,
       split_from, body, created_at)
     VALUES ($1, $2, $3, 1, 'firing', $4, $5, $6, $7, $8, $9)`,
    [id, CLUSTER, inc.label, o.severity, o.firstFiring, o.root, o.splitFrom, JSON.stringify(inc), o.created],
  );
  await db.server.query(
    'INSERT INTO server.incident_members (incident_id, alert_id, joined_version, left_version) VALUES ($1, $2, 1, NULL)',
    [id, alertId],
  );
  const report = { ...stageA([]), incident_id: id, incident_version: 1, rendered_at: o.created.toISOString() };
  await db.server.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body,
       first_firing_at, rendered_at)
     VALUES ($1, $2, 1, $3, $4, false, $5, $6, $7)`,
    [
      randomUUID(),
      id,
      report.disposition,
      report.evidence_fingerprint,
      JSON.stringify(report),
      o.firstFiring,
      o.created,
    ],
  );
  return id;
}

/** 首条消息时延直方图中某组标签的样本数与总和 */
async function observed(labels: Record<string, string>): Promise<{ count: number; sum: number }> {
  const m = await metrics.firstMessageLatency.get();
  const match = (l: Partial<Record<string, string | number>>) => Object.entries(labels).every(([k, v]) => l[k] === v);
  const count =
    m.values.find((v) => v.metricName === 'srenautix_first_message_latency_seconds_count' && match(v.labels))?.value ??
    0;
  const sum =
    m.values.find((v) => v.metricName === 'srenautix_first_message_latency_seconds_sum' && match(v.labels))?.value ?? 0;
  return { count, sum };
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  fs = new FixtureServer();
  await fs.start();
  fs.on('POST', send, [fixture('telegram', 'send-message.ok')]);
  const store = new NotifyStore(db.server);
  const reports = new ReportSource(
    db.server,
    new FeedbackService(db.server, metrics),
    new TopologyStore(db.server),
    { alertTitle: () => null, actionVerify: () => null, links: NO_LINKS },
    { prefix: '', consoleUrl: 'https://srenautix.example.test' },
  );
  const source = new PgMessageSource(
    db.server,
    {
      prefix: '',
      consoleUrl: 'https://srenautix.example.test',
      severities: ['critical', 'warning'],
      resolvedRetentionMs: 6 * 3_600_000,
      businessImpactAlerts: [
        {
          labels: { severity: ['critical'], layer: ['L0', 'L1', 'L2', 'L3', 'L4'] },
          exclude_labels: { component: ['provider'] },
        },
        { labels: { component: ['release'] }, exclude_labels: {} },
      ],
    },
    { delivered: async () => undefined } as unknown as ProposalService,
    reports,
    null,
  );
  const adapter = new TelegramAdapter(
    new TelegramClient(fs.url, TOKEN),
    CHATS.map((chat) => ({ channel: 'telegram' as const, chat, language: 'zh' as const })),
    { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 3_000 },
    '',
  );
  engine = new NotifyEngine(
    store,
    [adapter],
    source,
    new Interactions(store, new NoActions(), metrics, () => undefined),
    metrics,
    { prefix: '', consoleUrl: 'https://srenautix.example.test', digestRetentionMs: 6 * 3_600_000, now: () => now },
  );
}, 120_000);

afterAll(async () => {
  await fs.stop();
  await db.close();
});

describe('首条消息时延', () => {
  it('新事件从首个告警触发计时，拆分出的事件从拆分时刻计时；每个事件只记第一条消息；业务影响类按成员告警判定', async () => {
    const parent = await seed({
      root: 'Cluster:data/postgres',
      alertname: 'CNPGInstanceRestarted',
      labels: { layer: 'L3' },
      severity: 'critical',
      firstFiring: sec(0),
      created: sec(42),
      splitFrom: null,
    });
    await seed({
      root: 'Node:storage-03',
      alertname: 'NodeMemoryRequestsNearAllocatable',
      labels: {},
      severity: 'warning',
      firstFiring: sec(0),
      created: sec(66),
      splitFrom: null,
    });
    now = sec(68).getTime();
    await engine.syncOnce();
    await engine.deliverOnce();
    // 两个渠道目标都发出了消息，每个事件只记一次
    expect(fs.calls('POST', send).length).toBe(4);
    expect(await observed({ business_impact: 'true', origin: 'new' })).toEqual({ count: 1, sum: 68 });
    expect(await observed({ business_impact: 'false', origin: 'new' })).toEqual({ count: 1, sum: 68 });

    // L2 的 critical，但组件是 provider：按 exclude_labels 不算业务影响告警（在风暴窗口之外发出）
    await seed({
      root: 'component:provider',
      alertname: 'ProviderErrorRateHigh',
      labels: { layer: 'L2', component: 'provider' },
      severity: 'critical',
      firstFiring: sec(380),
      created: sec(400),
      splitFrom: null,
    });
    now = sec(402).getTime();
    await engine.syncOnce();
    await engine.deliverOnce();
    expect(fs.calls('POST', send).length).toBe(6);
    expect(await observed({ business_impact: 'false', origin: 'new' })).toEqual({ count: 2, sum: 90 });

    // 57 分钟后从原事件拆分出来，成员告警的首个触发时刻仍是 10:25
    await seed({
      root: 'component:release',
      alertname: 'ReleaseRollbackFailed',
      labels: { component: 'release' },
      severity: 'critical',
      firstFiring: sec(0),
      created: sec(57 * 60 + 12),
      splitFrom: parent,
    });
    now = sec(57 * 60 + 15).getTime();
    await engine.syncOnce();
    await engine.deliverOnce();
    expect(fs.calls('POST', send).length).toBe(8);
    expect(await observed({ business_impact: 'true', origin: 'split' })).toEqual({ count: 1, sum: 3 });
    // 已有消息的事件之后的编辑与另一个渠道目标的消息不再计入
    expect(await observed({ business_impact: 'true', origin: 'new' })).toEqual({ count: 1, sum: 68 });
  });
});
