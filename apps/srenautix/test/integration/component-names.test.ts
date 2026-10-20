import { appendFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Incident } from '@srenautix/contract';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerIncidentRoutes } from '../../src/console-bff/routes-incidents.js';
import type { Auth } from '../../src/identity/auth.js';
import { upsertAlert } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import type { ProposalService } from '../../src/proposals/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { PackEvidence, PackRules } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { StageAService } from '../../src/stage-a/service.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { tx } from '../../src/store/pool.js';
import type { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { PACKS } from '../support/packs.js';

/**
 * 组件的可读名称（ADR 0101）经真实路径：cchp 风格的 provider 组件类型声明 display_name（告警注解 provider_name，
 * 再取 provider_info 指标的 provider_name 标签）→ 阶段 A（真实 PackEvidence、真实 Prometheus）→ server.component_names
 * → GET /v1/incidents 与 /v1/incidents/{ref}。名称求不出时保留上一次的名称。
 */
const REPO = resolve(import.meta.dirname, '../../../..');
const SCRATCH = join(REPO, '.scratch', `component-names-${process.pid}`);
const CAPS = new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const);
const MIN = 60_000;
const T = Math.floor(Date.now() / MIN) * MIN;
const CLUSTER = 'cchp';
// 一个告警带名称注解；一个只有指标里有名称；一个哪里都没有名称
const NAMED = '01a134f4-437f-75d9-8731-697393b9f30f';
const METRIC = '0b7d1c2e-1111-4a2b-8c3d-4e5f60718293';
const key = (id: string) => `provider:${id}`;

let db: TestDb;
let prom: TsdbInstance;
let stageA: StageAService;
let app: FastifyInstance;

function incident(id: string, n: number): Incident {
  const component = key(id);
  return {
    incident_id: `7a1b2c3d-0000-4000-8000-00000000000${n}`,
    cluster_id: CLUSTER,
    label: `${component}:${new Date(T - 10 * MIN).toISOString()}`,
    incident_version: 1,
    state: 'firing',
    severity: 'critical',
    first_firing_at: new Date(T - 10 * MIN).toISOString(),
    ended_at: null,
    root: {
      component,
      entity: { cluster_id: CLUSTER, kind: 'provider', namespace: null, name: id, uid: null },
      ambiguous: false,
      margin: null,
      silent_root: false,
    },
    candidates: [],
    members: [
      {
        alert_id: `${n}000000000000000@${(T - 10 * MIN) / 1000}`,
        alertname: 'CchpProviderErrorRateHigh',
        role: 'cause',
        component,
        severity: 'critical',
        status: 'firing',
        starts_at: new Date(T - 10 * MIN).toISOString(),
        ends_at: null,
        joined_version: 1,
        left_version: null,
      },
    ],
    components: [component],
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 1,
    created_at: new Date(T - 10 * MIN).toISOString(),
    updated_at: new Date(T - 10 * MIN).toISOString(),
  } as Incident;
}

/** 写入事件与它的告警；annotations 为告警注解（第二次运行时可以换掉） */
async function seed(inc: Incident, annotations: Record<string, string>): Promise<void> {
  const id = inc.root.entity!.name;
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (incident_id) DO NOTHING`,
    [
      inc.incident_id,
      inc.cluster_id,
      inc.label,
      inc.incident_version,
      inc.state,
      inc.severity,
      inc.first_firing_at,
      inc.root.component,
      JSON.stringify(inc),
    ],
  );
  const fp = inc.members[0]!.alert_id.split('@')[0]!;
  await tx(db.server, (c) =>
    upsertAlert(
      c,
      CLUSTER,
      {
        source: 'alertmanager',
        labels: { alertname: 'CchpProviderErrorRateHigh', provider_id: id, severity: 'critical' },
        annotations,
        severity: 'critical',
        status: 'firing',
        suppressed: 'none',
        startsAt: new Date(T - 10 * MIN),
        endsAt: null,
        generatorUrl: null,
        fingerprint: fp,
        alertname: 'CchpProviderErrorRateHigh',
      },
      {
        classification: { role: 'cause', source: 'label', confidence: 1, catalog_entry: null, chronic: false },
        entity: { cluster_id: CLUSTER, kind: 'provider', namespace: null, name: id, uid: null },
        entityResolution: 'labels',
        component: key(id),
        chains: [],
      },
    ),
  );
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const range = (v: number) => Array.from({ length: 61 }, (_, i) => ({ t: T - (60 - i) * MIN, v }));
  prom = await startPrometheus([
    {
      labels: { __name__: 'cchp_gateway_provider_info', provider_id: METRIC, provider_name: '北洛' },
      points: range(1),
    },
  ]);
  // _example 的副本加上 cchp 风格的 provider 组件类型与 provider_info 信号
  const dir = join(SCRATCH, 'packs');
  mkdirSync(dir, { recursive: true });
  cpSync(join(PACKS, '_example'), join(dir, '_example'), { recursive: true });
  appendFileSync(
    join(dir, '_example', 'components.yaml'),
    `  - id: example.provider
    match:
      kind: provider
    display_name:
      - alert_annotation: provider_name
      - signal: provider_info
        label: provider_name
`,
  );
  appendFileSync(
    join(dir, '_example', 'signals.yaml'),
    `  - id: provider_info
    kind: metrics
    alternatives:
      - expr: max by (provider_id, provider_name) (cchp_gateway_provider_info{provider_id="$name"})
`,
  );
  const rt = await PackRuntime.load({
    dirs: [dir],
    only: ['_example'],
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: CAPS,
  });
  const metrics = new ServerMetrics('server', false);
  const source = await EvidenceSource.create({
    id: 'prometheus',
    url: prom.url,
    dialect: 'promql',
    bearerTokenFile: null,
    timeoutMs: 10_000,
  });
  const evidence = new PackEvidence(
    rt,
    source,
    async () => null,
    { locale: 'zh-CN', concurrency: 2, queryTimeoutMs: 10_000 },
    metrics,
  );
  stageA = new StageAService(db.server, evidence, new PackRules(rt, metrics), {} as ProposalService, metrics);
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerIncidentRoutes(app, {
    pool: db.server,
    auth: { reader: async () => ({ scopes: 'all' }) } as unknown as Auth,
    feedback: { latest: async () => new Map() } as unknown as FeedbackService,
    topology: {} as TopologyStore,
    evidence,
    worker: null,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prom?.stop();
  await db?.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

const stored = async () =>
  Object.fromEntries(
    (
      await db.server.query<{ component: string; display_name: string }>(
        'SELECT component, display_name FROM server.component_names WHERE cluster_id = $1',
        [CLUSTER],
      )
    ).rows.map((r) => [r.component, r.display_name]),
  );

describe('provider 组件的可读名称：阶段 A → server.component_names → 读取接口', () => {
  it('告警注解与 provider_info 指标给出的名称写入 server.component_names', async () => {
    const a = incident(NAMED, 1);
    const b = incident(METRIC, 2);
    await seed(a, { provider_name: '智元 API' });
    await seed(b, {});
    await stageA.run(a);
    await stageA.run(b);
    expect(await stored()).toEqual({ [key(NAMED)]: '智元 API', [key(METRIC)]: '北洛' });
  });

  it('再跑一次时求不出名称（注解没了、指标里没有这个 provider）：保留上一次的名称', async () => {
    const a = incident(NAMED, 1);
    await seed(a, {});
    await stageA.run(a);
    expect((await stored())[key(NAMED)]).toBe('智元 API');
  });

  it('GET /v1/incidents/{ref} 与 GET /v1/incidents 返回名称；组件键不变', async () => {
    const a = incident(NAMED, 1);
    const detail = await app.inject({ method: 'GET', url: `/v1/incidents/${a.incident_id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as Incident;
    expect(body.root.component).toBe(key(NAMED));
    expect(body.component_names).toEqual({ [key(NAMED)]: '智元 API' });

    const list = await app.inject({ method: 'GET', url: `/v1/incidents?state=firing&cluster_id=${CLUSTER}` });
    expect(list.statusCode).toBe(200);
    const items = (
      list.json() as { items: Array<{ incident_id: string; root_component: string; component_names: object }> }
    ).items;
    expect(Object.fromEntries(items.map((x) => [x.root_component, x.component_names]))).toEqual({
      [key(NAMED)]: { [key(NAMED)]: '智元 API' },
      [key(METRIC)]: { [key(METRIC)]: '北洛' },
    });
  });
});
