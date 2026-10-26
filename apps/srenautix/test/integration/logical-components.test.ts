import { randomUUID } from 'node:crypto';
import type { Alert, Incident } from '@srenautix/contract';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerResearchRoutes, type ResearchRouteDeps } from '../../src/api/routes-research.js';
import type { Auth } from '../../src/identity/auth.js';
import { alertsById, upsertAlert } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { parseCardCheckId } from '../../src/stage-a/card-checks.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { tx } from '../../src/store/pool.js';
import { ComponentExpander, hintOf } from '../../src/topology/expand.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { PACKS } from '../support/packs.js';
import { incident as baseIncident } from '../support/scenario.js';

/**
 * 逻辑组件映射到候选工作负载（ADR 0130），对应 Kind 的 unmapped-alert（kind-e2e 39620204509）：只带 service="catalog"
 * 标签的 ShopCatalogStale 归入 component:catalog，之前事件没有任何证据卡，阶段 B 的组件枚举里也没有提供商品目录的 api。
 * 拓扑：Service shop/catalog 选中 api 的 Pod（经 ReplicaSet 归 Deployment shop/api 所有）；另有 shop/worker 与
 * 另一个命名空间里的 Service ops/catalog-cache。真实 PostgreSQL、Prometheus 与内置领域包。
 */
const C = 'test';
const T = Date.now();
const metrics = new ServerMetrics('server', false);

let db: TestDb;
let store: TopologyStore;
let expander: ComponentExpander;
let prom: TsdbInstance;
let rt: PackRuntime;
let source: EvidenceSource;
let app: FastifyInstance;

const node = (kind: string, ns: string, name: string) => ({
  key: `${kind}:${ns}/${name}`,
  kind,
  namespace: ns,
  name,
  uid: `uid-${ns}-${name}`,
  labels: {},
  component_type: null,
  hub: false,
});
const edge = (from: string, relation: 'selects' | 'owned_by', to: string) => ({
  from,
  to,
  relation,
  provenance: 'structural' as const,
  confidence: 1,
  scope: 'service' as const,
  evidence: relation === 'selects' ? 'spec.selector' : 'ownerReference',
});

/** ShopCatalogStale：没有对象标签，只有 service 标签，组件为逻辑组件 component:catalog */
async function catalogAlert(): Promise<Alert> {
  const startsAt = new Date(T - 10 * 60_000);
  const u = await tx(db.server, (c) =>
    upsertAlert(
      c,
      C,
      {
        source: 'alertmanager',
        labels: { alertname: 'ShopCatalogStale', service: 'catalog', severity: 'warning' },
        annotations: { summary: '商品目录超过 1 小时没有刷新' },
        severity: 'warning',
        status: 'firing',
        suppressed: 'none',
        startsAt,
        endsAt: null,
        generatorUrl: null,
        fingerprint: 'c0ffee0000000001',
        alertname: 'ShopCatalogStale',
        alertmanagerSeenAt: startsAt,
      },
      {
        classification: { role: 'symptom', source: 'default', confidence: 0.3, catalog_entry: null, chronic: false },
        entity: null,
        entityResolution: 'unresolved',
        component: 'component:catalog',
        chains: [],
      },
    ),
  );
  return (await alertsById(db.server, [u.alertId]))[0]!;
}

function catalogIncident(alert: Alert): Incident {
  const inc = baseIncident();
  return {
    ...inc,
    incident_id: randomUUID(),
    incident_version: 1,
    cluster_id: C,
    label: 'component:catalog',
    first_firing_at: alert.starts_at,
    root: { component: 'component:catalog', entity: null, ambiguous: false, margin: 1, silent_root: false },
    candidates: [
      {
        component: 'component:catalog',
        score: 0.5,
        terms: { coverage: 1, precedence: 1, role_prior: 0.3, recent_change: 0, chronic_penalty: 0 },
        depth: 0,
        explains: [alert.alert_id],
        source: 'alert',
      },
    ],
    members: [
      {
        alert_id: alert.alert_id,
        alertname: 'ShopCatalogStale',
        role: 'symptom',
        component: 'component:catalog',
        severity: 'warning',
        status: 'firing',
        starts_at: alert.starts_at,
        ends_at: null,
        joined_version: 1,
        left_version: null,
      },
    ],
    components: ['component:catalog'],
    changes: [],
    updated_at: new Date(T).toISOString(),
  };
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  store = new TopologyStore(db.server);
  expander = new ComponentExpander(store);
  const at = new Date(T - 3600_000);
  await store.apply(C, [
    ...[
      node('Service', 'shop', 'catalog'),
      node('Service', 'shop', 'api'),
      node('Deployment', 'shop', 'api'),
      node('ReplicaSet', 'shop', 'api-1'),
      node('Pod', 'shop', 'api-1-x'),
      node('Deployment', 'shop', 'worker'),
      node('Service', 'ops', 'catalog-cache'),
    ].map((n) => ({ op: 'node_upsert' as const, at, source: 'informer' as const, node: n })),
    ...[
      edge('Service:shop/catalog', 'selects', 'Pod:shop/api-1-x'),
      edge('Service:shop/api', 'selects', 'Pod:shop/api-1-x'),
      edge('Pod:shop/api-1-x', 'owned_by', 'ReplicaSet:shop/api-1'),
      edge('ReplicaSet:shop/api-1', 'owned_by', 'Deployment:shop/api'),
    ].map((e) => ({ op: 'edge_upsert' as const, at, source: 'informer' as const, edge: e })),
  ]);
  prom = await startPrometheus([]);
  rt = await PackRuntime.load({
    dirs: [PACKS],
    only: ['workload', 'kubernetes-core'],
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
  });
  source = await EvidenceSource.create({
    id: 'prometheus',
    url: prom.url,
    dialect: 'promql',
    bearerTokenFile: null,
    timeoutMs: 5_000,
  });
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerResearchRoutes(app, {
    pool: db.server,
    auth: {
      required: async () => ({ kind: 'service', caller: { kind: 'worker', id: 'worker-0' } }),
    } as unknown as Auth,
    topology: store,
    feedback: new FeedbackService(db.server, metrics),
    catalog: Catalog.load(),
    packs: rt,
    locale: 'zh-CN',
    clusterId: C,
    kube: null,
    expander,
  } as unknown as ResearchRouteDeps);
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prom?.stop();
  await db?.close();
});

describe('逻辑组件的候选', () => {
  it('同名的 Service 与它选中的工作负载：工作负载在前', async () => {
    expect(await expander.logicalCandidates(C, 'component:catalog', [], new Date())).toEqual([
      'Deployment:shop/api',
      'Service:shop/catalog',
    ]);
  });

  it('告警的 service 标签指向 Service；告警带 namespace 时只在这个命名空间里找', async () => {
    const hint = hintOf({ alertname: 'X', service: 'catalog' });
    expect(await expander.logicalCandidates(C, 'component:storefront', [hint], new Date())).toEqual([
      'Deployment:shop/api',
      'Service:shop/catalog',
    ]);
    const elsewhere = hintOf({ service: 'catalog', namespace: 'ops' });
    expect(await expander.logicalCandidates(C, 'component:storefront', [elsewhere], new Date())).toEqual([]);
  });

  it('带命名空间的逻辑组件只在这个命名空间里找同名对象；不是逻辑组件时为空', async () => {
    expect(await expander.logicalCandidates(C, 'component:shop/worker', [], new Date())).toEqual([
      'Deployment:shop/worker',
    ]);
    expect(await expander.logicalCandidates(C, 'component:ops/worker', [], new Date())).toEqual([]);
    expect(await expander.logicalCandidates(C, 'Deployment:shop/api', [], new Date())).toEqual([]);
  });

  it('具体对象：逻辑组件只映射出一个工作负载时展开为它（自愈模板的根因，ADR 0126）', async () => {
    expect((await expander.concrete(C, 'component:catalog', new Date())).key).toBe('Deployment:shop/api');
    expect((await expander.concrete(C, 'component:nothing', new Date())).key).toBe('component:nothing');
  });
});

describe('根因是逻辑组件的事件', () => {
  it('阶段 A：候选工作负载按自己的组件类型执行证据链，事件有证据卡；没有映射时一张也没有', async () => {
    const alert = await catalogAlert();
    const inc = catalogIncident(alert);
    const options = { locale: 'zh-CN' as const, concurrency: 4, queryTimeoutMs: 5_000 };
    const typeOf = (clusterId: string, key: string) => store.componentType(clusterId, key);
    const without = await new PackEvidence(rt, source, typeOf, options, metrics).run(
      inc,
      [alert],
      AbortSignal.timeout(30_000),
    );
    expect(without.cards).toEqual([]);
    const mapped = await new PackEvidence(rt, source, typeOf, options, metrics, (clusterId, key, alerts, at) =>
      expander.logicalCandidates(
        clusterId,
        key,
        alerts.map((a) => hintOf(a.labels)),
        at,
      ),
    ).run(inc, [alert], AbortSignal.timeout(30_000));
    expect(mapped.cards.length).toBeGreaterThan(0);
    expect(mapped.cards.some((c) => c.card_id === 'workload/pod-restarts/restarts')).toBe(true);
    expect(new Set(mapped.cards.map((c) => `${c.entity?.kind}:${c.entity?.namespace}/${c.entity?.name}`))).toContain(
      'Deployment:shop/api',
    );
  });

  it('阶段 B 的输入：候选进入拓扑邻域（带 maps_to 边）与卡片检查', async () => {
    const alert = await catalogAlert();
    const inc = catalogIncident(alert);
    await db.server.query(
      `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
       VALUES ($1, $2, $3, 1, 'firing', 'warning', $4, $5, $6)`,
      [inc.incident_id, C, inc.label, inc.first_firing_at, inc.root.component, JSON.stringify(inc)],
    );
    await db.server.query(
      "INSERT INTO server.incident_versions (incident_id, version, body, reason) VALUES ($1, 1, $2, 'created')",
      [inc.incident_id, JSON.stringify(inc)],
    );
    const runId = randomUUID();
    await db.server.query(
      `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state)
       VALUES ($1, $2, 1, 'new_incident', 'warning', true, 'leased')`,
      [runId, inc.incident_id],
    );
    const r = await app.inject({ method: 'GET', url: `/v1/research/tasks/${runId}/context` });
    expect(r.statusCode, r.body).toBe(200);
    const ctx = r.json() as {
      topology: { nodes: Array<{ key: string }>; edges: Array<{ from: string; to: string; relation: string }> };
      templates: Array<{ id: string }>;
    };
    const keys = ctx.topology.nodes.map((n) => n.key);
    expect(keys).toEqual(expect.arrayContaining(['Deployment:shop/api', 'Service:shop/catalog', 'Service:shop/api']));
    expect(keys).not.toContain('Deployment:shop/worker');
    expect(ctx.topology.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'component:catalog', to: 'Deployment:shop/api', relation: 'maps_to' }),
        expect.objectContaining({ from: 'component:catalog', to: 'Service:shop/catalog', relation: 'maps_to' }),
      ]),
    );
    expect(ctx.templates.map((t) => parseCardCheckId(t.id)?.component)).toContain('Deployment:shop/api');
  });
});
