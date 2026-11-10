import type { AlertCatalogEntry, Incident } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import { AlertCatalog, DEFAULT_RCA_PARAMS, labelsFingerprint } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerIncidentRoutes } from '../../src/console-bff/routes-incidents.js';
import type { Auth } from '../../src/identity/auth.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { IngestService } from '../../src/ingest/service.js';
import type { RawAlert } from '../../src/ingest/normalize.js';
import { ServerMetrics } from '../../src/metrics.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import type { EvidenceRunner } from '../../src/stage-a/ports.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 事件摘要的问题陈述（ADR 0190）经真实 PG：告警经接入写入告警状态表，事件引擎或直接写入的事件给出成员，
// GET /v1/incidents 按头条告警组选出头条告警，注解取 summary、其次 description，研判结论取最近一次完成的研判。

const CLUSTER = 'shop-prod';
const MIN = 60_000;
const T = Math.floor(Date.now() / MIN) * MIN - 60 * MIN;
const metrics = new ServerMetrics('server', false);

const ENTRIES: AlertCatalogEntry[] = [
  {
    id: 'hpa-maxed-out',
    alertname: 'KubeHpaMaxedOut',
    role: 'symptom',
    category: 'performance',
    entity: { kind: 'HorizontalPodAutoscaler', name_labels: ['horizontalpodautoscaler'] },
  },
];
const catalog = new AlertCatalog([{ pack: 'test', entries: ENTRIES }]);

let db: TestDb;
let ingest: IngestService;
let engine: IncidentEngine;
let app: FastifyInstance;

function raw(labels: Record<string, string>, startsAt: number, annotations: Record<string, string>): RawAlert {
  return {
    source: 'alertmanager',
    labels,
    annotations,
    severity: labels.severity === 'critical' ? 'critical' : 'warning',
    status: 'firing',
    suppressed: 'none',
    startsAt: new Date(startsAt),
    endsAt: null,
    generatorUrl: null,
    fingerprint: labelsFingerprint(labels),
    alertname: labels.alertname!,
    alertmanagerSeenAt: new Date(startsAt),
  };
}

const alertId = (labels: Record<string, string>, startsAt: number) =>
  `${labelsFingerprint(labels)}@${Math.floor(startsAt / 1000)}`;

interface SeedMember {
  labels: Record<string, string>;
  at: number;
  role: 'cause' | 'symptom' | 'change';
  severity: 'critical' | 'warning';
  status?: 'firing' | 'resolved';
  left?: boolean;
  /** 告警注解；为 null 时告警不写入告警状态表 */
  annotations: Record<string, string> | null;
}

/** 直接写入的事件，成员告警经接入写入告警状态表 */
async function seed(n: number, members: SeedMember[]): Promise<string> {
  const id = `6d1e2f30-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(T + n * MIN).toISOString();
  const root = 'Deployment:shop/api';
  const written = members.filter((m) => m.annotations !== null);
  if (written.length) {
    await ingest.write(
      CLUSTER,
      'alertmanager',
      'alertmanager',
      written.map((m) => raw(m.labels, m.at, m.annotations!)),
      {},
    );
  }
  const body = {
    incident_id: id,
    cluster_id: CLUSTER,
    label: `${root}:${at.slice(0, 15)}0:00Z~${n}`,
    incident_version: 2,
    state: 'firing',
    severity: 'critical',
    first_firing_at: at,
    ended_at: null,
    root: { component: root, entity: null, ambiguous: false, margin: null, silent_root: false },
    candidates: [],
    members: members.map((m) => ({
      alert_id: alertId(m.labels, m.at),
      alertname: m.labels.alertname!,
      role: m.role,
      component: root,
      severity: m.severity,
      category: 'availability',
      status: m.status ?? 'firing',
      starts_at: new Date(m.at).toISOString(),
      ends_at: m.status === 'resolved' ? new Date(m.at + MIN).toISOString() : null,
      joined_version: 1,
      left_version: m.left ? 2 : null,
    })),
    components: [root],
    categories: ['availability'],
    primary_category: 'availability',
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 1,
    created_at: at,
    updated_at: at,
  } as unknown as Incident;
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body,
       categories, primary_category)
     VALUES ($1, $2, $3, 2, 'firing', 'critical', $4, $5, $6, $7, $8)`,
    [id, CLUSTER, body.label, at, root, JSON.stringify(body), ['availability'], 'availability'],
  );
  return id;
}

/** server 侧的研判镜像（worker 事件写入的同一张表） */
async function run(incidentId: string, n: number, state: string, summary: string | null, startedAt: number) {
  await db.server.query(
    `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, disposition, conclusion_level,
       root_component, summary, started_at, finished_at)
     VALUES ($1, $2, 2, 'incident_created', $3, $4, $5, 'Deployment:shop/api', $6, $7, $8)`,
    [
      `7e2f3a40-0000-4000-8000-${String(n).padStart(12, '0')}`,
      incidentId,
      state,
      state === 'completed' ? 'act' : null,
      state === 'completed' ? 'likely' : null,
      summary,
      new Date(startedAt),
      new Date(startedAt + MIN),
    ],
  );
}

type Headline = {
  alert_id: string;
  alertname: string;
  summary: string | null;
  started_at: string;
  research_summary: string | null;
} | null;

const list = async () => {
  const r = await app.inject({ method: 'GET', url: `/v1/incidents?state=all&cluster_id=${CLUSTER}` });
  expect(r.statusCode).toBe(200);
  const body = r.json() as { items: Array<{ incident_id: string; headline: Headline }> };
  expect(responseErrors('/v1/incidents', 'get', 200, body)).toBeNull();
  return new Map(body.items.map((x) => [x.incident_id, x.headline]));
};

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topology = new TopologyStore(db.server);
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: CLUSTER, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog, nodes: topology, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  engine = new IncidentEngine({
    pool: db.server,
    topology,
    params: () => DEFAULT_RCA_PARAMS,
    changes: async () => [],
    probes: async () => [],
    stale: { markStale: async () => 0 },
    metrics,
    suppressedAlerts: async () => new Map<string, string>(),
  });
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerIncidentRoutes(app, {
    pool: db.server,
    auth: { reader: async () => ({ scopes: 'all' }) } as unknown as Auth,
    feedback: new FeedbackService(db.server, metrics),
    topology,
    evidence: {} as EvidenceRunner,
    worker: null,
    services: () => new ServiceCatalog([], []),
    businessImpactAlerts: () => [],
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('事件摘要的问题陈述（ADR 0190）', () => {
  it('事件引擎生成的事件：头条告警的 summary 注解与开始时间，还没有研判时研判结论为 null', async () => {
    const labels = {
      alertname: 'KubeHpaMaxedOut',
      namespace: 'shop',
      horizontalpodautoscaler: 'api',
      severity: 'warning',
    };
    await ingest.write(
      CLUSTER,
      'alertmanager',
      'alertmanager',
      [raw(labels, T, { summary: 'HPA shop/api 已扩到上限 10 个副本', description: '持续 15 分钟' })],
      {},
    );
    const r = await engine.recompute(CLUSTER);
    expect(r.changes.map((c) => c.type)).toEqual(['incident.created']);
    const incidentId = (
      await db.server.query<{ incident_id: string }>('SELECT incident_id FROM server.incidents WHERE cluster_id = $1', [
        CLUSTER,
      ])
    ).rows[0]!.incident_id;
    expect((await list()).get(incidentId)).toEqual({
      alert_id: alertId(labels, T),
      alertname: 'KubeHpaMaxedOut',
      summary: 'HPA shop/api 已扩到上限 10 个副本',
      started_at: new Date(T).toISOString(),
      research_summary: null,
    });
  });

  it('头条告警组：正在触发的 symptom 优先于更早的 cause；已恢复与已离开的成员不参加；组内取最早的一条', async () => {
    const cause = { alertname: 'PodCrashLooping', namespace: 'shop', pod: 'api-1', severity: 'critical' };
    const resolvedSymptom = { alertname: 'ApiLatencyHigh', namespace: 'shop', severity: 'warning' };
    const leftSymptom = { alertname: 'ApiTimeouts', namespace: 'shop', severity: 'warning' };
    const late = { alertname: 'ApiErrorRateHigh', namespace: 'shop', route: '/pay', severity: 'warning' };
    const early = { alertname: 'ApiErrorRateHigh', namespace: 'shop', route: '/cart', severity: 'warning' };
    const id = await seed(1, [
      {
        labels: cause,
        at: T + 1 * MIN,
        role: 'cause',
        severity: 'critical',
        annotations: { summary: 'api-1 反复重启' },
      },
      {
        labels: resolvedSymptom,
        at: T + 2 * MIN,
        role: 'symptom',
        severity: 'warning',
        status: 'resolved',
        annotations: { summary: '延迟升高' },
      },
      {
        labels: leftSymptom,
        at: T + 2 * MIN,
        role: 'symptom',
        severity: 'warning',
        left: true,
        annotations: { summary: '超时' },
      },
      { labels: late, at: T + 4 * MIN, role: 'symptom', severity: 'warning', annotations: { summary: '/pay 5xx 9%' } },
      // 只有 description 注解
      {
        labels: early,
        at: T + 3 * MIN,
        role: 'symptom',
        severity: 'warning',
        annotations: { description: '/cart 5xx 12%' },
      },
    ]);
    await run(id, 1, 'completed', '旧的结论', T + 5 * MIN);
    await run(id, 2, 'completed', 'api-1 反复重启，/cart 与 /pay 返回 5xx', T + 6 * MIN);
    // 之后失败的研判不取代最近一次完成的研判
    await run(id, 3, 'failed', null, T + 7 * MIN);
    expect((await list()).get(id)).toEqual({
      alert_id: alertId(early, T + 3 * MIN),
      alertname: 'ApiErrorRateHigh',
      summary: '/cart 5xx 12%',
      started_at: new Date(T + 3 * MIN).toISOString(),
      research_summary: 'api-1 反复重启，/cart 与 /pay 返回 5xx',
    });
  });

  it('没有正在触发的 symptom 时取正在触发的 critical；再没有时取全部成员；告警不在告警状态表时注解为 null', async () => {
    const warn = { alertname: 'NodeDiskPressure', node: 'n1', severity: 'warning' };
    const crit = { alertname: 'PgReplicaLagHigh', namespace: 'db', severity: 'critical' };
    const critical = await seed(2, [
      { labels: warn, at: T + 1 * MIN, role: 'cause', severity: 'warning', annotations: { summary: '磁盘压力' } },
      { labels: crit, at: T + 2 * MIN, role: 'cause', severity: 'critical', annotations: {} },
    ]);
    const gone = { alertname: 'ConfigReloadFailed', namespace: 'shop', severity: 'warning' };
    const later = { alertname: 'ConfigDrift', namespace: 'shop', severity: 'warning' };
    const fallback = await seed(3, [
      { labels: later, at: T + 5 * MIN, role: 'change', severity: 'warning', annotations: { summary: '配置漂移' } },
      { labels: gone, at: T + 4 * MIN, role: 'change', severity: 'warning', annotations: null },
    ]);
    const empty = await seed(4, []);
    const got = await list();
    expect(got.get(critical)).toEqual({
      alert_id: alertId(crit, T + 2 * MIN),
      alertname: 'PgReplicaLagHigh',
      summary: null,
      started_at: new Date(T + 2 * MIN).toISOString(),
      research_summary: null,
    });
    expect(got.get(fallback)).toEqual({
      alert_id: alertId(gone, T + 4 * MIN),
      alertname: 'ConfigReloadFailed',
      summary: null,
      started_at: new Date(T + 4 * MIN).toISOString(),
      research_summary: null,
    });
    expect(got.get(empty)).toBeNull();
  });
});
