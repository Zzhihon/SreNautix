import type { Channel, Incident } from '@srenautix/contract';
import { AlertCatalog, DEFAULT_RCA_PARAMS } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { timelineOf } from '../../src/console-bff/routes-incidents.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { IncidentPipeline, STAGE_A_MAX_RETRIES } from '../../src/incident/pipeline.js';
import { resolveIncidentRef } from '../../src/incident/read.js';
import { IngestService } from '../../src/ingest/service.js';
import type { RawAlert } from '../../src/ingest/normalize.js';
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
import { Scheduler } from '../../src/scheduler/admission.js';
import type { EvidenceRun, EvidenceRunner, RuleProposer } from '../../src/stage-a/ports.js';
import { StageAService } from '../../src/stage-a/service.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fixture, FixtureServer } from '../support/fixture-server.js';

// 阶段 A 缺失（ADR 0173），经真实 PG 与流水线：
// - 一轮流水线里某个事件的阶段 A 抛错（以 stage_a_reports 上的触发器注入写入失败），其余事件照常出报告、进入阶段 B 队列，
//   失败写进 stage_a_failed 记录并计数；
// - 当前版本超过 60 秒没有报告的事件补跑，补跑成功后照常进入阶段 B；补跑失败 3 次后记 stage_a_missing，不再补跑；
// - critical 事件首个告警进入 Alertmanager 60 秒后仍没有阶段 A：先发出不带证据卡的消息，带一行“阶段 A 尚未生成：原因”，
//   阶段 A 生成后照常编辑；warning 与还没到 60 秒的不发；
// - 时间线出现 stage_a_missing 条目，带原因码与级别。
// 证据卡执行器是固定返回空卡的端口实现：这里要测的是阶段 A 的写入失败与补跑，与卡的内容无关。

const CLUSTER = 'gap';
const TOKEN = 'test-token';
const CHAT = '-1001234567890';
const send = `/bot${TOKEN}/sendMessage`;
const edit = `/bot${TOKEN}/editMessageText`;
const metrics = new ServerMetrics('server', false);

const evidence: EvidenceRunner = {
  run: async (): Promise<EvidenceRun> => ({ cards: [], chains: [], runbooks: [], rootComponentType: null }),
  rerun: async () => [],
};
const rules: RuleProposer = { evaluate: () => [], excluded: () => null };

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
let ingest: IngestService;
let stageA: StageAService;
let pipeline: IncidentPipeline;
let notify: NotifyEngine;

function alert(name: string, deployment: string, severity: 'critical' | 'warning', seenAgoMs: number): RawAlert {
  const at = new Date(Date.now() - seenAgoMs);
  return {
    source: 'reconcile',
    labels: { alertname: name, severity, namespace: 'shop', deployment },
    annotations: {},
    severity,
    status: 'firing',
    suppressed: 'none',
    startsAt: at,
    endsAt: null,
    generatorUrl: null,
    fingerprint: `${name}-${deployment}`.padEnd(16, '0').slice(0, 16),
    alertname: name,
    alertmanagerSeenAt: at,
  };
}

const node = (name: string) => ({
  op: 'node_upsert' as const,
  at: new Date(Date.now() - 24 * 3600_000),
  source: 'informer' as const,
  node: {
    key: `Deployment:shop/${name}`,
    kind: 'Deployment',
    namespace: 'shop',
    name,
    uid: `uid-${name}`,
    labels: {},
    component_type: null,
    hub: false,
  },
});

async function incidentOf(deployment: string): Promise<Incident> {
  const r = await db.server.query<{ body: Incident }>(
    'SELECT body FROM server.incidents WHERE cluster_id = $1 AND label LIKE $2',
    [CLUSTER, `Deployment:shop/${deployment}:%`],
  );
  return r.rows[0]!.body;
}

const hasReport = async (deployment: string) => {
  const inc = await incidentOf(deployment);
  const r = await db.server.query(
    'SELECT 1 FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2',
    [inc.incident_id, inc.incident_version],
  );
  return (r.rowCount ?? 0) > 0;
};

const queued = async (deployment: string) =>
  (
    await db.server.query<{ reason: string; state: string }>(
      'SELECT reason, state FROM server.research_queue WHERE incident_id = $1 ORDER BY enqueued_at',
      [(await incidentOf(deployment)).incident_id],
    )
  ).rows.map((r) => [r.reason, r.state]);

const stageARecords = async (deployment: string) =>
  (
    await db.server.query<{ code: string; ref: string | null; detail: string | null }>(
      "SELECT code, ref, detail FROM server.incident_reasons WHERE incident_id = $1 AND stage = 'stage_a' ORDER BY id",
      [(await incidentOf(deployment)).incident_id],
    )
  ).rows;

const counted = async (code: string) =>
  (await metrics.terminalStates.get()).values.find((v) => v.labels.stage === 'stage_a' && v.labels.code === code)
    ?.value ?? 0;

/** 把事件当前版本的写入时刻提前（模拟这个版本已经写入 2 分钟），body 与列一起改，重算不会改回 */
async function age(deployment: string): Promise<void> {
  const inc = await incidentOf(deployment);
  const at = new Date(Date.parse(inc.updated_at) - 120_000).toISOString();
  await db.admin.query(
    `UPDATE server.incidents SET updated_at = $2::timestamptz, body = jsonb_set(body, '{updated_at}', to_jsonb($3::text))
      WHERE incident_id = $1`,
    [inc.incident_id, at, at],
  );
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topology = new TopologyStore(db.server);
  await topology.apply(CLUSTER, ['api', 'billing', 'ledger', 'worker', 'fresh'].map(node));
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: CLUSTER, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: new AlertCatalog([]), nodes: topology, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  const engine = new IncidentEngine({
    pool: db.server,
    topology,
    params: () => DEFAULT_RCA_PARAMS,
    changes: async () => [],
    probes: async () => [],
    stale: { markStale: async () => 0 },
    metrics,
    suppressedAlerts: async () => new Map<string, string>(),
  });
  const scheduler = new Scheduler(
    db.server,
    {
      slots: 4,
      criticalReserved: 1,
      maxRunsPerIncident: 3,
      runWindowMs: 6 * 3600_000,
      stageTimeoutMs: 120_000,
      stormActiveAlerts: 200,
      stormNewIncidents: 20,
      stormWindowMs: 5 * 60_000,
      stormTopRoots: 3,
      maxRecoveries: 2,
    },
    metrics,
  );
  stageA = new StageAService(db.server, evidence, rules, {} as ProposalService, metrics);
  pipeline = new IncidentPipeline(CLUSTER, engine, stageA, scheduler, db.server, metrics, {
    changed: () => undefined,
    degraded: () => undefined,
    recovered: () => undefined,
  });

  fs = new FixtureServer();
  await fs.start();
  fs.on('POST', send, [fixture('telegram', 'send-message.ok')]);
  fs.on('POST', edit, [fixture('telegram', 'edit-message-text.ok')]);
  const reports = new ReportSource(
    db.server,
    new FeedbackService(db.server, metrics),
    topology,
    { alertTitle: () => null, actionVerify: () => null, links: NO_LINKS },
    { prefix: '', consoleUrl: 'https://srenautix.example.test' },
  );
  const source = new PgMessageSource(
    db.server,
    {
      prefix: '',
      consoleUrl: 'https://srenautix.example.test',
      severities: ['critical'],
      resolvedRetentionMs: 6 * 3_600_000,
    },
    { delivered: async () => undefined } as unknown as ProposalService,
    reports,
    null,
  );
  const store = new NotifyStore(db.server);
  notify = new NotifyEngine(
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
    new Interactions(store, new NoActions(), metrics, () => {}),
    metrics,
    { prefix: '', consoleUrl: null, digestRetentionMs: 6 * 3_600_000, now: () => Date.now() },
  );

  // billing、ledger、worker、fresh 的阶段 A 写入失败；api 照常
  await db.admin.query(`CREATE FUNCTION public.fail_stage_a() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM server.incidents i WHERE i.incident_id = NEW.incident_id
                   AND i.label ~ '^Deployment:shop/(billing|ledger|worker|fresh):') THEN
        RAISE EXCEPTION 'injected stage A failure for %', NEW.incident_id;
      END IF;
      RETURN NEW;
    END $$`);
  await db.admin.query(
    'CREATE TRIGGER fail_stage_a BEFORE INSERT ON server.stage_a_reports FOR EACH ROW EXECUTE FUNCTION public.fail_stage_a()',
  );
}, 120_000);

afterAll(async () => {
  await fs?.stop();
  await db?.close();
});

describe('阶段 A 缺失（ADR 0173）', () => {
  it('一轮流水线中某个事件的阶段 A 抛错：其余事件照常出报告并进入阶段 B，失败写进记录并计数', async () => {
    await ingest.write(
      CLUSTER,
      'am',
      'reconcile',
      [
        alert('ApiErrors', 'api', 'critical', 5 * 60_000),
        alert('BillingLag', 'billing', 'critical', 5 * 60_000),
        alert('LedgerLag', 'ledger', 'warning', 5 * 60_000),
        alert('WorkerSlow', 'worker', 'warning', 5 * 60_000),
        alert('FreshDown', 'fresh', 'critical', 10_000),
      ],
      {},
    );
    await pipeline.kick();
    expect(await hasReport('api')).toBe(true);
    expect(await queued('api')).toEqual([['new_incident', 'queued']]);
    for (const d of ['billing', 'ledger', 'worker', 'fresh']) {
      expect(await hasReport(d)).toBe(false);
      expect(await queued(d)).toEqual([]);
      const recs = await stageARecords(d);
      expect(recs.map((r) => [r.code, r.ref])).toEqual([['stage_a_failed', null]]);
      expect(recs[0]!.detail).toContain('injected stage A failure');
    }
    expect(await counted('stage_a_failed')).toBe(4);

    // 还没到期限：下一轮不补跑
    await pipeline.kick();
    expect(await counted('stage_a_failed')).toBe(4);
  });

  it('critical 事件首个告警进入 Alertmanager 60 秒后仍没有阶段 A：先发出不带证据卡的消息，带说明行', async () => {
    await notify.syncOnce();
    expect(await notify.deliverOnce()).toBe(2);
    const sent = fs.calls('POST', send).map((c) => String((c.body as { text: string }).text));
    expect(sent).toHaveLength(2);
    const billing = sent.find((t) => t.includes('billing'))!;
    expect(billing).toContain('阶段 A 尚未生成：阶段 A 执行失败（');
    expect(billing).toContain('injected stage A failure');
    expect(billing).not.toContain('card:');
    expect(billing).not.toContain('处置：');
    const api = sent.find((t) => t.includes('/api'))!;
    expect(api).not.toContain('阶段 A 尚未生成');
    // warning（不在推送范围）与 Alertmanager 中还不到 60 秒的事件没有消息
    expect(sent.some((t) => t.includes('worker') || t.includes('ledger') || t.includes('fresh'))).toBe(false);
    // 不推送的决定：严重度不在推送范围内的事件各记一次，再同步也不重复
    await notify.syncOnce();
    const withheld = await db.server.query<{ label: string; code: string }>(
      `SELECT i.label, x.code FROM server.incident_reasons x JOIN server.incidents i USING (incident_id)
        WHERE x.stage = 'notify' AND x.code LIKE 'withheld_%' ORDER BY i.label`,
    );
    expect(withheld.rows.map((r) => [r.label.split(':').slice(0, 2).join(':'), r.code])).toEqual([
      ['Deployment:shop/ledger', 'withheld_severity'],
      ['Deployment:shop/worker', 'withheld_severity'],
    ]);
  });

  it('补跑：超过期限的版本重新执行阶段 A，成功后照常进入阶段 B', async () => {
    await db.admin.query(`CREATE OR REPLACE FUNCTION public.fail_stage_a() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM server.incidents i WHERE i.incident_id = NEW.incident_id
                     AND i.label ~ '^Deployment:shop/(billing|worker|fresh):') THEN
          RAISE EXCEPTION 'injected stage A failure for %', NEW.incident_id;
        END IF;
        RETURN NEW;
      END $$`);
    await age('ledger');
    await pipeline.kick();
    expect(await hasReport('ledger')).toBe(true);
    expect(await queued('ledger')).toEqual([['new_incident', 'queued']]);
    expect((await stageARecords('ledger')).map((r) => r.code)).toEqual(['stage_a_failed']);
  });

  it(`补跑失败 ${STAGE_A_MAX_RETRIES} 次后记 stage_a_missing 并计数，不再补跑`, async () => {
    await age('billing');
    const before = await counted('stage_a_failed');
    for (let i = 0; i < STAGE_A_MAX_RETRIES + 2; i++) {
      await pipeline.kick();
    }
    const recs = await stageARecords('billing');
    expect(recs.map((r) => [r.code, r.ref])).toEqual([
      ['stage_a_failed', null],
      ...Array.from({ length: STAGE_A_MAX_RETRIES }, () => ['stage_a_failed', 'retry']),
      ['stage_a_missing', null],
    ]);
    expect(await counted('stage_a_failed')).toBe(before + STAGE_A_MAX_RETRIES);
    expect(await counted('stage_a_missing')).toBe(1);
    const exported = (await metrics.registry.metrics()).split('\n');
    expect(exported).toContain(
      'srenautix_terminal_states_total{stage="stage_a",code="stage_a_missing",level="error"} 1',
    );
    expect(await hasReport('billing')).toBe(false);
  });

  it('时间线：阶段 A 的失败与缺失带原因码与级别', async () => {
    const row = await resolveIncidentRef(db.server, (await incidentOf('billing')).incident_id);
    const entries = (await timelineOf(db.server, row!)).filter((e) => e.kind === 'stage_a_missing');
    expect(entries.map((e) => [e.code, e.level])).toEqual([
      ...Array.from({ length: STAGE_A_MAX_RETRIES + 1 }, () => ['stage_a_failed', 'error']),
      ['stage_a_missing', 'error'],
    ]);
    expect(entries[0]!.text).toContain('阶段 A 执行失败：');
    expect(entries[0]!.untrusted).toBe(true);
    expect(entries.at(-1)!.text).toBe('阶段 A 补跑 3 次仍然失败，当前版本没有报告：补跑 3 次仍然失败');
  });

  it('消息的说明行随原因更新；阶段 A 生成后照常编辑，说明行消失', async () => {
    await notify.syncOnce();
    expect(await notify.deliverOnce()).toBe(1);
    const missing = String((fs.calls('POST', edit).at(-1)!.body as { text: string }).text);
    expect(missing).toContain('阶段 A 尚未生成：阶段 A 补跑 3 次仍然失败，当前版本没有报告');

    await db.admin.query('DROP TRIGGER fail_stage_a ON server.stage_a_reports');
    await stageA.recompute((await incidentOf('billing')).incident_id, 'manual');
    await notify.syncOnce();
    expect(await notify.deliverOnce()).toBe(1);
    const edited = String((fs.calls('POST', edit).at(-1)!.body as { text: string }).text);
    expect(edited).toContain('billing');
    expect(edited).not.toContain('阶段 A 尚未生成');
    expect(edited).toContain('处置：');
  });
});
