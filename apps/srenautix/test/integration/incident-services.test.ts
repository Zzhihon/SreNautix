import type { AlertCatalogEntry, BusinessDomain, Incident } from '@srenautix/contract';
import { AlertCatalog, DEFAULT_RCA_PARAMS, labelsFingerprint } from '@srenautix/core';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerIncidentRoutes } from '../../src/console-bff/routes-incidents.js';
import type { Auth } from '../../src/identity/auth.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import type { EvidenceRunner } from '../../src/stage-a/ports.js';
import { alertService, type ServiceDeps } from '../../src/alerts/service.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { classificationInputsFingerprint, recategorizeIncidents } from '../../src/incident/recategorize.js';
import { IngestService } from '../../src/ingest/service.js';
import type { RawAlert } from '../../src/ingest/normalize.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 事件的服务经真实 PG（ADR 0193）：接入求出告警的服务，事件引擎写入四列；之前版本写下的事件（服务列为空、成员没有服务）
// 由重新归类补上，仍在 alert_state 的告警同时回写，事件引擎之后重算时成员的服务保持；归类输入不变时不再执行。

const CLUSTER = 'shop';
const MIN = 60_000;
const T = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
const OLD = T - 3 * 24 * 60 * MIN;
const metrics = new ServerMetrics('server', false);

const ARCHIVE: AlertCatalogEntry = {
  id: 'archive-dead-letters',
  alertname: 'ArchiveDeadLetters',
  role: 'symptom',
  entity: { kind: 'Deployment', name_labels: ['deployment'] },
  service: 'archive-exporter',
};
const catalog = new AlertCatalog([{ pack: 'shop', entries: [ARCHIVE] }]);

const DOMAINS: BusinessDomain[] = [
  {
    id: 'forwarding',
    title: { 'zh-CN': '请求转发' },
    tier: 'core',
    services: [
      {
        id: 'gateway',
        title: { 'zh-CN': '网关' },
        members: [{ match: { kind: 'Deployment', name_pattern: '^gateway$' } }],
        namespaces: ['shop'],
      },
    ],
  },
  {
    id: 'archive',
    title: { 'zh-CN': '请求归档' },
    tier: 'supporting',
    services: [{ id: 'archive-exporter', title: { 'zh-CN': '归档导出' }, members: [] }],
  },
];

let db: TestDb;
let topology: TopologyStore;
let engine: IncidentEngine;
let service: ServiceDeps;

const ingestWith = (withService: boolean) =>
  new IngestService(
    db.server,
    [],
    { clusterId: CLUSTER, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    {
      catalog,
      nodes: topology,
      ksm: null,
      ruleExpr: () => undefined,
      chronic: () => false,
      ...(withService
        ? { service: (c: string, s: Parameters<typeof alertService>[2]) => alertService(service, c, s) }
        : {}),
    },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );

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

type Row = {
  services: string[] | null;
  primary_service: string | null;
  primary_service_source: string | null;
  business_domain: string | null;
  version: number;
  body: Incident;
};

async function rowWith(alertname: string): Promise<Row & { incident_id: string }> {
  return (
    await db.server.query<Row & { incident_id: string }>(
      `SELECT incident_id, services, primary_service, primary_service_source, business_domain, version, body
         FROM server.incidents WHERE cluster_id = $1 AND body->'members'->0->>'alertname' = $2`,
      [CLUSTER, alertname],
    )
  ).rows[0]!;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  topology = new TopologyStore(db.server);
  service = {
    services: () => new ServiceCatalog([{ pack: 'shop', domains: DOMAINS }], []),
    componentTypes: () => [],
    componentType: (c, key) => topology.componentType(c, key),
    metrics,
  };
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
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('事件的服务（ADR 0193）', () => {
  const always = () => true;

  it('接入求出服务，事件引擎写入四列：目录条目声明的服务优先于所在对象', async () => {
    await ingestWith(true).write(
      CLUSTER,
      'alertmanager',
      'alertmanager',
      [raw({ alertname: 'ArchiveDeadLetters', namespace: 'shop', deployment: 'gateway', severity: 'warning' }, T)],
      {},
    );
    await engine.recompute(CLUSTER);
    const r = await rowWith('ArchiveDeadLetters');
    expect([r.services, r.primary_service, r.primary_service_source, r.business_domain]).toEqual([
      ['archive-exporter'],
      'archive-exporter',
      'catalog',
      'archive',
    ]);
    expect(r.body).toMatchObject({ services: ['archive-exporter'], business_domain: 'archive' });
  });

  it('之前版本写下的事件与仍在的告警：重新归类补上服务并回写 alert_state，之后引擎重算时服务保持', async () => {
    // 之前版本接入的告警：分类里没有服务；引擎写下的成员服务为 null
    await ingestWith(false).write(
      CLUSTER,
      'alertmanager',
      'alertmanager',
      [raw({ alertname: 'GatewayErrors', namespace: 'shop', severity: 'warning' }, T + MIN)],
      {},
    );
    await engine.recompute(CLUSTER);
    const live = await rowWith('GatewayErrors');
    expect(live.primary_service).toBeNull();
    // 之前版本写下的历史事件：四列为空，成员没有服务字段
    const at = new Date(OLD).toISOString();
    const root = 'Deployment:shop/gateway';
    const old = {
      incident_id: '5c0a7e10-0000-4000-8000-000000000193',
      cluster_id: CLUSTER,
      label: `${root}:old`,
      incident_version: 2,
      state: 'resolved',
      severity: 'critical',
      first_firing_at: at,
      ended_at: at,
      root: { component: root, entity: null, ambiguous: false, margin: null, silent_root: false },
      candidates: [],
      members: [
        {
          alert_id: `00000001@${Math.floor(OLD / 1000)}`,
          alertname: 'GatewayDown',
          role: 'cause',
          component: root,
          severity: 'critical',
          category: 'availability',
          status: 'resolved',
          starts_at: at,
          ends_at: at,
          joined_version: 1,
          left_version: null,
        },
      ],
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
    };
    await db.server.query(
      `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at,
         root_component, body, categories, primary_category, updated_at)
       VALUES ($1, $2, $3, 2, 'resolved', 'critical', $4, $4, $5, $6, $7, 'availability', $4)`,
      [old.incident_id, CLUSTER, old.label, at, root, JSON.stringify(old), ['availability']],
    );

    const r = await recategorizeIncidents(db.server, catalog, { holder: 'server-a', active: always, service });
    expect(r).toMatchObject({ outcome: 'completed' });
    expect(r.incidents).toBeGreaterThanOrEqual(2);
    expect(r.alerts).toBeGreaterThanOrEqual(1);

    // 历史事件：告警已经不在 alert_state，按成员的组件键归属
    const backfilled = await rowWith('GatewayDown');
    expect([backfilled.services, backfilled.primary_service, backfilled.primary_service_source]).toEqual([
      ['gateway'],
      'gateway',
      'component',
    ]);
    expect(backfilled.version).toBe(2);
    expect(backfilled.body.members[0]).toMatchObject({ service: 'gateway', business_domain: 'forwarding' });

    // 仍在的告警：命名空间伪组件按默认命名空间推定；alert_state 同时回写
    const fixed = await rowWith('GatewayErrors');
    expect([fixed.primary_service, fixed.primary_service_source]).toEqual(['gateway', 'namespace']);
    const state = await db.server.query<{ s: string | null }>(
      `SELECT classification->>'service' AS s FROM server.alert_state WHERE alertname = 'GatewayErrors'`,
    );
    expect(state.rows[0]!.s).toBe('gateway');
    await engine.recompute(CLUSTER);
    expect((await rowWith('GatewayErrors')).primary_service).toBe('gateway');

    // 归类输入不变：不再执行
    expect(
      await recategorizeIncidents(db.server, catalog, { holder: 'server-b', active: always, service }),
    ).toMatchObject({
      outcome: 'unchanged',
    });
  });

  it('业务领域的声明与条目的 service 都进入归类输入的指纹', () => {
    const base = classificationInputsFingerprint(catalog, service);
    expect(classificationInputsFingerprint(catalog)).not.toBe(base);
    const more: ServiceDeps = {
      ...service,
      services: () =>
        new ServiceCatalog(
          [
            {
              pack: 'shop',
              domains: [
                ...DOMAINS,
                { id: 'x', title: { 'zh-CN': 'x' }, tier: 'self', services: [] } as unknown as BusinessDomain,
              ],
            },
          ],
          [],
        ),
    };
    expect(classificationInputsFingerprint(catalog, more)).not.toBe(base);
    const renamedService = new AlertCatalog([{ pack: 'shop', entries: [{ ...ARCHIVE, service: 'gateway' }] }]);
    expect(classificationInputsFingerprint(renamedService, service)).not.toBe(base);
  });
});

describe('事件的服务经接口（ADR 0193 §6）', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
    registerIncidentRoutes(app, {
      pool: db.server,
      auth: { reader: async () => ({ scopes: 'all' }) } as unknown as Auth,
      feedback: { latest: async () => new Map() } as unknown as FeedbackService,
      topology,
      evidence: {} as EvidenceRunner,
      worker: null,
      services: () => service.services(),
      businessImpactAlerts: () => [{ labels: { alertname: ['ArchiveDeadLetters'] }, exclude_labels: {} }],
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  type Item = {
    headline: { alertname: string } | null;
    services: string[];
    primary_service: string | null;
    business_domain: string | null;
    business_impact: string[];
  };
  const names = async (query: string) => {
    const r = await app.inject({ method: 'GET', url: `/v1/incidents?state=all&cluster_id=${CLUSTER}${query}` });
    expect(r.statusCode).toBe(200);
    return (r.json() as { items: Item[] }).items;
  };

  it('列表按业务领域与服务筛选，摘要带服务字段', async () => {
    const archive = await names('&business_domain=archive');
    expect(archive.map((i) => [i.primary_service, i.business_domain])).toEqual([['archive-exporter', 'archive']]);
    // 业务影响告警按 notify.business_impact_alerts 求出（ADR 0166）：只有归档事件的成员命中
    expect(archive[0]!.business_impact).toEqual(['ArchiveDeadLetters']);
    expect((await names('&service=gateway')).every((i) => i.business_impact.length === 0)).toBe(true);
    expect((await names('&service=gateway')).every((i) => i.services.includes('gateway'))).toBe(true);
    expect(await names('&service=gateway')).toHaveLength(2);
    const rest = await names('&exclude_business_domain=archive');
    expect(rest.some((i) => i.business_domain === 'archive')).toBe(false);
    expect(rest).toHaveLength(2);
    const bad = await app.inject({ method: 'GET', url: `/v1/incidents?business_domain=Bad%20Id` });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /v1/business-domains：按声明顺序，每个服务带正在触发的事件数', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/business-domains?cluster_id=${CLUSTER}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      items: [
        {
          id: 'forwarding',
          title: { 'zh-CN': '请求转发' },
          tier: 'core',
          services: [{ id: 'gateway', title: { 'zh-CN': '网关' }, firing: 1 }],
        },
        {
          id: 'archive',
          title: { 'zh-CN': '请求归档' },
          tier: 'supporting',
          services: [{ id: 'archive-exporter', title: { 'zh-CN': '归档导出' }, firing: 1 }],
        },
      ],
      unassigned_firing: 0,
    });
  });
});
