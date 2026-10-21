import type { Incident } from '@srenautix/contract';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '@srenautix/core';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestService } from '../../src/ingest/service.js';
import { activeAlerts } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import type { ProposalService } from '../../src/proposals/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { PackEvidence, PackRules } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { StageAService } from '../../src/stage-a/service.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { PACKS } from '../support/packs.js';

/**
 * kind 的规范化（ADR 0097、0107）经真实 PostgreSQL、内置领域包与接入路径：
 * - 告警标签里的 kind 不区分大小写、不带 API 组（cluster、application），拓扑键带组：解析到同一个拓扑对象；
 *   规则聚合掉了 namespace 的告警按名称唯一地找到命名空间级对象；CNPG 的三种告警（没有命名空间的集群级告警、
 *   带命名空间的集群级告警、Pod 告警沿 owned_by）都落在同一个组件上，收敛成一个事件；
 * - 升级前接入、按旧规则存储的告警（kind 是标签原样的 node、application，没有目录条目，组件是旧格式）在重算阶段 A
 *   之前按当前的解析规则重新解析并回写，Node 与 Argo Application 的证据卡随之执行（之前都是 0 张）。
 */
const C = 'acme';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const CLUSTER_KEY = 'Cluster.postgresql.cnpg.io:acme-data/acme-postgres';
const metrics = new ServerMetrics('server', false);

let db: TestDb;
let prom: TsdbInstance;
let ingest: IngestService;
let stageA: StageAService;

const node = (key: string) => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { key, kind, namespace: ns, name, uid: `uid-${name}`, labels: {}, component_type: null, hub: false };
};
const owned = (from: string, to: string) => ({
  from,
  to,
  relation: 'owned_by' as const,
  confidence: 1,
  provenance: 'structural' as const,
  scope: 'instance' as const,
  evidence: 'ownerReferences',
});
const raw = (alertname: string, labels: Record<string, string>, fp: string) => ({
  source: 'alertmanager' as const,
  labels: { alertname, severity: 'warning', ...labels },
  annotations: {},
  severity: 'warning' as const,
  status: 'firing' as const,
  suppressed: 'none' as const,
  startsAt: new Date(NOW - 10 * MIN),
  endsAt: null,
  generatorUrl: null,
  fingerprint: fp,
  alertname,
});

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const at = new Date(NOW - 60 * MIN);
  await topo.apply(C, [
    ...[
      'Node:storage-03',
      'Application.argoproj.io:argocd/rke2-cilium',
      CLUSTER_KEY,
      'Pod:acme-data/acme-postgres-2',
    ].map((k) => ({ op: 'node_upsert' as const, at, source: 'informer' as const, node: node(k) })),
    { op: 'edge_upsert', at, source: 'informer', edge: owned('Pod:acme-data/acme-postgres-2', CLUSTER_KEY) },
  ] as Parameters<TopologyStore['apply']>[1]);
  prom = await startPrometheus([]);
  const rt = await PackRuntime.load({
    dirs: [PACKS],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
  });
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: C, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: rt.alertCatalog(), nodes: topo, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  const evidence = new PackEvidence(
    rt,
    await EvidenceSource.create({
      id: 'prometheus',
      url: prom.url,
      dialect: 'promql',
      bearerTokenFile: null,
      timeoutMs: 5_000,
    }),
    (cl, key) => topo.componentType(cl, key),
    { locale: 'zh-CN', concurrency: 2, queryTimeoutMs: 5_000 },
    metrics,
  );
  stageA = new StageAService(
    db.server,
    evidence,
    new PackRules(rt, metrics),
    {} as ProposalService,
    metrics,
    () => rt.set.lockDigest,
    (cl, ids) => ingest.reresolve(cl, ids),
  );
}, 180_000);

afterAll(async () => {
  await prom?.stop();
  await db?.close();
});

describe('kind 的规范化', () => {
  it('CNPG：没有命名空间的 cluster 告警、带命名空间的 cluster 告警与 Pod 告警落在同一个组件，收敛成一个事件', async () => {
    await ingest.write(
      C,
      'am',
      'alertmanager',
      [
        raw(
          'PGNoWritablePrimary',
          { entity_kind: 'cluster', entity: 'acme-postgres', component: 'pg' },
          'c000000000000001',
        ),
        raw(
          'PGWALArchiveFailures',
          { entity_kind: 'cluster', entity: 'acme-postgres', namespace: 'acme-data' },
          'c000000000000002',
        ),
        raw('PGPostmasterRestarted', { namespace: 'acme-data', pod: 'acme-postgres-2' }, 'c000000000000003'),
      ],
      {},
    );
    const rows = await db.server.query<{ alertname: string; component: string }>(
      "SELECT alertname, component FROM server.alert_state WHERE alertname LIKE 'PG%' ORDER BY alertname",
    );
    expect(rows.rows.map((r) => r.component)).toEqual([CLUSTER_KEY, CLUSTER_KEY, CLUSTER_KEY]);
    const t = await new TopologyStore(db.server).at(C, new Date(NOW));
    const incs = computeIncidents({
      alerts: (await activeAlerts(db.server, C, 30 * MIN)).filter((a) => a.alertname.startsWith('PG')),
      changes: [],
      graph: new TopologyGraph(t.nodes, t.edges, t.version),
      params: DEFAULT_RCA_PARAMS,
      now: NOW,
    });
    expect(incs.map((i) => i.ranking.root.component)).toEqual([CLUSTER_KEY]);
  });

  it('同名对象在多个命名空间时，没有命名空间的告警不解析到其中任何一个', async () => {
    await new TopologyStore(db.server).apply(C, [
      {
        op: 'node_upsert',
        at: new Date(NOW - 60 * MIN),
        source: 'informer',
        node: node('Cluster.postgresql.cnpg.io:other/acme-postgres'),
      },
    ] as Parameters<TopologyStore['apply']>[1]);
    expect(await new TopologyStore(db.server).find(C, 'cluster', null, 'acme-postgres', new Date(NOW))).toBeNull();
    expect(
      await new TopologyStore(db.server).find(C, 'cluster', 'acme-data', 'acme-postgres', new Date(NOW)),
    ).toMatchObject({
      key: CLUSTER_KEY,
    });
  });

  it('升级前按旧规则存储的 Node 与 Application 告警：重算阶段 A 时重新解析并回写，证据卡随之执行', async () => {
    const old = [
      {
        id: 'd000000000000001@1',
        alertname: 'NodeMemoryRequestsNearAllocatable',
        labels: { alertname: 'NodeMemoryRequestsNearAllocatable', entity_kind: 'node', entity: 'storage-03' },
        entity: { cluster_id: C, kind: 'node', namespace: null, name: 'storage-03', uid: null },
        component: 'node:storage-03',
      },
      {
        id: 'd000000000000002@1',
        alertname: 'ArgoCDAppDrift',
        labels: { alertname: 'ArgoCDAppDrift', entity_kind: 'application', entity: 'rke2-cilium', namespace: 'argocd' },
        entity: { cluster_id: C, kind: 'application', namespace: 'argocd', name: 'rke2-cilium', uid: null },
        component: 'application:argocd/rke2-cilium',
      },
    ];
    const reports: Array<{ cards: number }> = [];
    for (const [n, a] of old.entries()) {
      await db.server.query(
        `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status, suppressed,
           starts_at, classification, entity, entity_resolution, component, received_at, last_seen_at, updated_at)
         VALUES ($1, $2, $3, 'alertmanager', $4, $5, '{}', 'warning', 'firing', 'none', $6,
           '{"role":"cause","source":"label","confidence":1,"catalog_entry":null,"chronic":false}', $7, 'labels', $8, now(), now(), now())`,
        [
          a.id,
          C,
          a.id.slice(0, 16),
          a.alertname,
          JSON.stringify(a.labels),
          new Date(NOW - 10 * MIN),
          JSON.stringify(a.entity),
          a.component,
        ],
      );
      const inc = {
        incident_id: `7a1b2c3d-0000-4000-8000-00000000010${n}`,
        cluster_id: C,
        label: `${a.component}:${new Date(NOW - 10 * MIN).toISOString()}`,
        incident_version: 1,
        state: 'firing',
        severity: 'warning',
        first_firing_at: new Date(NOW - 10 * MIN).toISOString(),
        ended_at: null,
        root: { component: a.component, entity: a.entity, ambiguous: false, margin: null, silent_root: false },
        candidates: [],
        members: [
          {
            alert_id: a.id,
            alertname: a.alertname,
            role: 'cause',
            component: a.component,
            severity: 'warning',
            status: 'firing',
            starts_at: new Date(NOW - 10 * MIN).toISOString(),
            ends_at: null,
            joined_version: 1,
            left_version: null,
          },
        ],
        components: [a.component],
        changes: [],
        aliases: [],
        split_from: null,
        merged_into: null,
        suppressed: false,
        observability_blind: false,
        topology_version: 1,
        created_at: new Date(NOW - 10 * MIN).toISOString(),
        updated_at: new Date(NOW - 10 * MIN).toISOString(),
      } as unknown as Incident;
      await db.server.query(
        `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
         VALUES ($1, $2, $3, 1, 'firing', 'warning', $4, $5, $6)`,
        [inc.incident_id, C, inc.label, inc.first_firing_at, a.component, JSON.stringify(inc)],
      );
      const out = await stageA.recompute(inc.incident_id, 'manual');
      reports.push({ cards: out.report.cards.length });
    }
    const rows = await db.server.query<{ alertname: string; kind: string; component: string }>(
      "SELECT alertname, entity->>'kind' AS kind, component FROM server.alert_state WHERE alert_id LIKE 'd%' ORDER BY alertname",
    );
    expect(rows.rows).toEqual([
      {
        alertname: 'ArgoCDAppDrift',
        kind: 'Application.argoproj.io',
        component: 'Application.argoproj.io:argocd/rke2-cilium',
      },
      { alertname: 'NodeMemoryRequestsNearAllocatable', kind: 'Node', component: 'Node:storage-03' },
    ]);
    // Node 与 Argo Application（卡片按 Application 声明，实体是 Application.argoproj.io）都执行了证据卡
    expect(reports.every((r) => r.cards > 0)).toBe(true);
    // 再重算一次没有需要回写的告警
    expect(
      await ingest.reresolve(
        C,
        old.map((a) => a.id),
      ),
    ).toEqual([]);
  });
});
