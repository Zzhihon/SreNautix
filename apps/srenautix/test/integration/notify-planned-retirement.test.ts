import { randomUUID } from 'node:crypto';
import type { Channel, Incident, StageAReport } from '@srenautix/contract';
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
import { parseTelegramHtml } from '../support/telegram-html.js';
import { incident as baseIncident, stageA } from '../support/scenario.js';

// 计划内退役的事件不推送（ADR 0167）：阶段 A 判为 ignore、原因 planned_retirement 的事件不发新消息，控制台照常可见；
// 之前已经发出消息的事件（退役解释是后来才成立的）照常编辑

const TOKEN = 'test-token';
const CHAT = '-1001234567890';
const CLUSTER = 'east';
const send = `/bot${TOKEN}/sendMessage`;
const edit = `/bot${TOKEN}/editMessageText`;
const T0 = Date.parse('2026-10-24T03:02:00Z');

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

async function seed(root: string, alertname: string): Promise<string> {
  const fp = randomUUID().replace(/-/g, '').slice(0, 16);
  const alertId = `${fp}@${Math.floor(T0 / 1000)}`;
  await db.server.query(
    `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status,
       suppressed, starts_at, ends_at, classification, entity_resolution, component, received_at, last_seen_at, updated_at)
     VALUES ($1, $2, $3, 'reconcile', $4, $5, '{}', 'warning', 'firing', 'none', $6, NULL,
       '{"role":"symptom","source":"label","confidence":1,"catalog_entry":null,"chronic":false}', 'labels', $7, now(), now(), now())`,
    [alertId, CLUSTER, fp, alertname, JSON.stringify({ alertname, severity: 'warning' }), new Date(T0), root],
  );
  const id = randomUUID();
  const inc: Incident = {
    ...baseIncident(),
    incident_id: id,
    cluster_id: CLUSTER,
    label: `${root}:${new Date(T0).toISOString()}`,
    incident_version: 1,
    state: 'firing',
    severity: 'warning',
    first_firing_at: new Date(T0).toISOString(),
    ended_at: null,
    root: { component: root, entity: null, ambiguous: false, margin: 0.5, silent_root: false },
    candidates: [],
    members: [
      {
        alert_id: alertId,
        alertname,
        role: 'symptom',
        component: root,
        severity: 'warning',
        status: 'firing',
        starts_at: new Date(T0).toISOString(),
        ends_at: null,
        joined_version: 1,
        left_version: null,
      },
    ],
    components: [root],
    changes: [],
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
  };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, 1, 'firing', 'warning', $4, $5, $6)`,
    [id, CLUSTER, inc.label, new Date(T0), root, JSON.stringify(inc)],
  );
  await db.server.query(
    'INSERT INTO server.incident_members (incident_id, alert_id, joined_version, left_version) VALUES ($1, $2, 1, NULL)',
    [id, alertId],
  );
  return id;
}

/** 写入（或改写）事件的阶段 A 报告 */
async function report(id: string, d: Pick<StageAReport, 'disposition' | 'disposition_reason'>): Promise<void> {
  const r = { ...stageA([]), ...d, incident_id: id, incident_version: 1, rendered_at: new Date(T0).toISOString() };
  await db.server.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body,
       first_firing_at, rendered_at)
     VALUES ($1, $2, 1, $3, $4, false, $5, $6, $6)
     ON CONFLICT (incident_id, incident_version) DO UPDATE SET disposition = excluded.disposition, body = excluded.body`,
    [randomUUID(), id, r.disposition, r.evidence_fingerprint, JSON.stringify(r), new Date(T0)],
  );
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  fs = new FixtureServer();
  await fs.start();
  fs.on('POST', send, [fixture('telegram', 'send-message.ok')]);
  fs.on('POST', edit, [fixture('telegram', 'edit-message-text.ok')]);
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
    },
    { delivered: async () => undefined } as unknown as ProposalService,
    reports,
    null,
  );
  engine = new NotifyEngine(
    store,
    [
      new TelegramAdapter(
        new TelegramClient(fs.url, TOKEN),
        [{ channel: 'telegram', chat: CHAT, language: 'zh' }],
        { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 0 },
        '',
      ),
    ],
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

const texts = (path: string) =>
  fs.calls('POST', path).map((r) => parseTelegramHtml(String((r.body as Record<string, unknown>).text)).text);

describe('计划内退役的事件', () => {
  it('不推送新消息；之前已经发出消息的事件照常编辑，消息写明处置原因', async () => {
    const retired = await seed('Job:objstore', 'ObservabilityScrapeJobVanished');
    await report(retired, { disposition: 'ignore', disposition_reason: 'planned_retirement' });
    const other = await seed('Deployment:shop/api', 'ApiHighErrorRate');
    await report(other, { disposition: 'undetermined', disposition_reason: 'default' });
    now = T0 + 30_000;
    await engine.syncOnce();
    await engine.deliverOnce();
    expect(texts(send)).toHaveLength(1);
    expect(texts(send)[0]).toContain('ApiHighErrorRate');
    expect(texts(send)[0]).not.toContain('ObservabilityScrapeJobVanished');

    // 已经发出消息的事件，之后退役解释成立：照常编辑，写明处置原因
    await report(other, { disposition: 'ignore', disposition_reason: 'planned_retirement' });
    now = T0 + 90_000;
    await engine.syncOnce();
    await engine.deliverOnce();
    expect(texts(send)).toHaveLength(1);
    const edited = texts(edit);
    expect(edited.length).toBeGreaterThan(0);
    expect(edited.at(-1)).toContain('全部告警由计划内的退役解释');

    // 不推送的决定写进终态记录（ADR 0172）：只有没发过消息的退役事件，同一原因只记一次
    const withheld = await db.server.query<{ incident_id: string; code: string }>(
      "SELECT incident_id, code FROM server.incident_reasons WHERE stage = 'notify' AND code LIKE 'withheld_%'",
    );
    expect(withheld.rows).toEqual([{ incident_id: retired, code: 'withheld_planned_retirement' }]);
  });
});
