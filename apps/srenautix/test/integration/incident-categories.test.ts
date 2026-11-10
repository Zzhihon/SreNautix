import type { AlertCatalogEntry, Incident, IncidentCategory } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import { AlertCatalog, DEFAULT_RCA_PARAMS, labelsFingerprint } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerIncidentRoutes } from '../../src/console-bff/routes-incidents.js';
import type { Auth } from '../../src/identity/auth.js';
import { incidentCorrections } from '../../src/incident/corrections.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { IngestService } from '../../src/ingest/service.js';
import type { RawAlert } from '../../src/ingest/normalize.js';
import { ServerMetrics } from '../../src/metrics.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import type { EvidenceRunner } from '../../src/stage-a/ports.js';
import { runCorrections } from '../../src/store/corrections.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 告警类别经真实 PG（ADR 0183）：事件引擎写入类别列与 body；GET /v1/incidents 的 category、exclude_category、
// exclude_component 在 SQL 里筛选，unclassified 与之前版本写下的行不被排除；数据修正 incident/categories 补写之前版本的事件。

const CLUSTER = 'shop-prod';
const MIN = 60_000;
const T = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
const metrics = new ServerMetrics('server', false);

const ENTRIES: AlertCatalogEntry[] = [
  {
    id: 'hpa-maxed-out',
    alertname: 'KubeHpaMaxedOut',
    role: 'symptom',
    category: 'performance',
    entity: { kind: 'HorizontalPodAutoscaler', name_labels: ['horizontalpodautoscaler'] },
  },
  {
    id: 'pod-crash-looping',
    alertname: 'KubePodCrashLooping',
    role: 'cause',
    category: 'availability',
    entity: { kind: 'Pod', name_labels: ['pod'] },
  },
];
const catalog = new AlertCatalog([{ pack: 'test', entries: ENTRIES }], {
  categoryRules: [{ labels: { team: ['payments'] }, exclude_labels: {}, category: 'provider' }],
});

let db: TestDb;
let ingest: IngestService;
let engine: IncidentEngine;
let app: FastifyInstance;

function raw(labels: Record<string, string>, startsAt: number): RawAlert {
  return {
    source: 'alertmanager',
    labels,
    annotations: {},
    severity: 'warning',
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

/** 直接写入的事件：categories 为 null 时模拟之前版本写下的行（body 与列都没有类别） */
async function seed(
  n: number,
  components: string[],
  members: Array<{ alertname: string; category?: IncidentCategory; fingerprint?: string }>,
  categories: IncidentCategory[] | null,
): Promise<string> {
  const id = `5c0a7e10-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(T - n * MIN).toISOString();
  const root = components[0] ?? null;
  const body = {
    incident_id: id,
    cluster_id: CLUSTER,
    label: `${root ?? 'unlabelled'}:${at.slice(0, 15)}0:00Z~${n}`,
    incident_version: 1,
    state: 'firing',
    severity: 'warning',
    first_firing_at: at,
    ended_at: null,
    root: { component: root, entity: null, ambiguous: false, margin: null, silent_root: false },
    candidates: [],
    members: members.map((m, i) => ({
      alert_id: `${m.fingerprint ?? `${String(n).padStart(8, '0')}${String(i).padStart(8, '0')}`}@${Math.floor((T - n * MIN) / 1000)}`,
      alertname: m.alertname,
      role: 'symptom',
      component: root,
      severity: 'warning',
      ...(m.category ? { category: m.category } : {}),
      status: 'firing',
      starts_at: at,
      ends_at: null,
      joined_version: 1,
      left_version: null,
    })),
    components,
    ...(categories ? { categories, primary_category: categories[0] } : {}),
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
     VALUES ($1, $2, $3, 1, 'firing', 'warning', $4, $5, $6, $7, $8)`,
    [id, CLUSTER, body.label, at, root, JSON.stringify(body), categories, categories?.[0] ?? null],
  );
  return id;
}

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
    feedback: { latest: async () => new Map() } as unknown as FeedbackService,
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

type Item = { incident_id: string; categories: IncidentCategory[]; primary_category: IncidentCategory };

const list = async (query: string) => {
  const r = await app.inject({ method: 'GET', url: `/v1/incidents?state=all&cluster_id=${CLUSTER}${query}` });
  return { status: r.statusCode, items: r.statusCode === 200 ? (r.json() as { items: Item[] }).items : [] };
};

describe('告警类别（ADR 0183）', () => {
  let engineIncident = '';
  const ids: Record<string, string> = {};

  it('事件引擎写入类别列、body 的 categories 与成员的 category', async () => {
    await ingest.write(
      CLUSTER,
      'alertmanager',
      'alertmanager',
      [
        raw(
          { alertname: 'KubeHpaMaxedOut', namespace: 'shop', horizontalpodautoscaler: 'api', severity: 'warning' },
          T,
        ),
      ],
      {},
    );
    const r = await engine.recompute(CLUSTER);
    expect(r.changes.map((c) => c.type)).toEqual(['incident.created']);
    const row = (
      await db.server.query<{ incident_id: string; categories: string[]; primary_category: string; body: Incident }>(
        'SELECT incident_id, categories, primary_category, body FROM server.incidents WHERE cluster_id = $1',
        [CLUSTER],
      )
    ).rows[0]!;
    engineIncident = row.incident_id;
    expect(row.categories).toEqual(['performance']);
    expect(row.primary_category).toBe('performance');
    expect(row.body).toMatchObject({ categories: ['performance'], primary_category: 'performance' });
    expect(row.body.members.map((m) => m.category)).toEqual(['performance']);
  });

  it('GET /v1/incidents：包含按交集，排除只去掉类别全部被排除的事件；unclassified 与之前版本的行保留', async () => {
    ids.provider = await seed(
      1,
      ['component:provider'],
      [{ alertname: 'UpstreamErrors', category: 'provider' }],
      ['provider'],
    );
    ids.mixed = await seed(
      2,
      ['component:provider', 'Deployment:shop/web'],
      [
        { alertname: 'UpstreamErrors', category: 'provider' },
        { alertname: 'WebErrors', category: 'availability' },
      ],
      ['availability', 'provider'],
    );
    ids.unclassified = await seed(
      3,
      ['Namespace:batch'],
      [{ alertname: 'Unknown', category: 'unclassified' }],
      ['unclassified'],
    );
    // 之前版本写下的行：列与 body 都没有类别；一个成员的告警还在 alert_state（带规则匹配的标签），一个已经不在
    const legacyLabels = { alertname: 'PaymentsGatewaySlow', team: 'payments', namespace: 'pay', severity: 'warning' };
    await ingest.write(CLUSTER, 'alertmanager', 'alertmanager', [raw(legacyLabels, T - 4 * MIN)], {});
    ids.legacy = await seed(
      4,
      ['Namespace:pay'],
      [
        { alertname: 'PaymentsGatewaySlow', fingerprint: labelsFingerprint(legacyLabels) },
        { alertname: 'KubePodCrashLooping' },
      ],
      null,
    );

    const all = await list('');
    expect(all.status).toBe(200);
    const byId = new Map(all.items.map((x) => [x.incident_id, x]));
    expect(byId.get(engineIncident)).toMatchObject({ categories: ['performance'], primary_category: 'performance' });
    // 没有补上的行按 body 的成员算：没有类别的成员为 unclassified
    expect(byId.get(ids.legacy!)).toMatchObject({ categories: ['unclassified'], primary_category: 'unclassified' });

    const of = (r: { items: Item[] }) => r.items.map((x) => x.incident_id).sort();
    expect(of(await list('&exclude_category=provider'))).toEqual(
      [engineIncident, ids.mixed!, ids.unclassified!, ids.legacy!].sort(),
    );
    expect(
      of(await list('&exclude_category=provider&exclude_category=availability&exclude_category=performance')),
    ).toEqual([ids.unclassified!, ids.legacy!].sort());
    expect(of(await list('&category=provider'))).toEqual([ids.provider!, ids.mixed!].sort());
    expect(of(await list('&category=unclassified'))).toEqual([ids.unclassified!]);
    expect(of(await list('&category=availability&category=performance'))).toEqual([engineIncident, ids.mixed!].sort());
    // 组件全部被排除的事件去掉；还有别的组件的事件保留
    expect(of(await list('&exclude_component=component:provider'))).toEqual(
      [engineIncident, ids.mixed!, ids.unclassified!, ids.legacy!].sort(),
    );
    expect(
      of(
        await list(
          '&exclude_component=component:provider&exclude_component=Deployment:shop/web&exclude_category=performance',
        ),
      ),
    ).toEqual([ids.unclassified!, ids.legacy!].sort());

    expect((await list('&exclude_category=unclassified')).status).toBe(400);
    expect((await list('&category=latency')).status).toBe(400);
  });

  it('数据修正 incident/categories 只补写之前版本的行：成员按完整标签或告警名重算，只执行一次', async () => {
    const before = (
      await db.server.query<{ incident_id: string; body: Incident }>(
        'SELECT incident_id, body FROM server.incidents WHERE incident_id <> $1',
        [ids.legacy],
      )
    ).rows;
    expect(await runCorrections(db.server, incidentCorrections(catalog), 'server-test')).toEqual([
      { name: 'incident/categories', rows: 1 },
    ]);
    const row = (
      await db.server.query<{ categories: string[]; primary_category: string; body: Incident }>(
        'SELECT categories, primary_category, body FROM server.incidents WHERE incident_id = $1',
        [ids.legacy],
      )
    ).rows[0]!;
    // PaymentsGatewaySlow 的告警还在 alert_state，带 team=payments 命中规则；KubePodCrashLooping 的告警已经不在，按告警名查目录
    expect(Object.fromEntries(row.body.members.map((m) => [m.alertname, m.category]))).toEqual({
      PaymentsGatewaySlow: 'provider',
      KubePodCrashLooping: 'availability',
    });
    expect(row.categories).toEqual(['availability', 'provider']);
    expect(row.body.categories).toEqual(['availability', 'provider']);
    expect(row.primary_category).toBe(row.body.primary_category);
    // 本版本写下的行不动
    const after = (
      await db.server.query<{ incident_id: string; body: Incident }>(
        'SELECT incident_id, body FROM server.incidents WHERE incident_id <> $1',
        [ids.legacy],
      )
    ).rows;
    expect(new Map(after.map((r) => [r.incident_id, r.body]))).toEqual(
      new Map(before.map((r) => [r.incident_id, r.body])),
    );
    expect(await runCorrections(db.server, incidentCorrections(catalog), 'server-test')).toEqual([]);
    expect((await list('&category=provider')).items.map((x) => x.incident_id)).toContain(ids.legacy);
  });
});
