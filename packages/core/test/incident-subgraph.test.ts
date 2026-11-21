import type { ComponentType, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import { describe, expect, it } from 'vitest';
import { buildIncidentSubgraph } from '../src/topology/subgraph.js';

const n = (kind: string, ns: string | null, name: string, extra: Partial<TopologyNode> = {}): TopologyNode => ({
  key: ns ? `${kind}:${ns}/${name}` : `${kind}:${name}`,
  kind,
  namespace: ns,
  name,
  uid: `uid-${kind}-${name}`,
  labels: {},
  component_type: null,
  hub: false,
  ...extra,
});

const e = (
  from: string,
  relation: string,
  to: string,
  provenance: TopologyEdge['provenance'] = 'structural',
  confidence = 1,
  scope: TopologyEdge['scope'] = 'instance',
): TopologyEdge => ({
  from,
  to,
  relation,
  provenance,
  confidence,
  scope,
  evidence: 'test',
});

const TYPES: ComponentType[] = [];

const CATALOG = new ServiceCatalog(
  [
    {
      pack: 'cchp',
      domains: [
        {
          id: 'forwarding',
          title: { 'zh-CN': '请求转发', en: 'Forwarding' },
          tier: 'core',
          services: [
            {
              id: 'gateway',
              title: { 'zh-CN': '网关', en: 'Gateway' },
              members: [
                { match: { kind: 'StatefulSet', namespaces: ['cchp-prod'], name_pattern: '^gateway$' } },
                { match: { kind: 'component', name_pattern: '^gateway$' } },
              ],
            },
          ],
        },
        {
          id: 'archive',
          title: { 'zh-CN': '请求归档', en: 'Archive' },
          tier: 'supporting',
          services: [
            {
              id: 'archive-exporter',
              title: { 'zh-CN': '归档导出', en: 'Archive exporter' },
              members: [
                { match: { kind: 'Deployment', namespaces: ['cchp-prod'], name_pattern: '^archive-exporter$' } },
                { match: { kind: 'component', name_pattern: '^archive-exporter$' } },
              ],
            },
          ],
        },
        {
          id: 'data',
          title: { 'zh-CN': '数据存储', en: 'Data' },
          tier: 'core',
          services: [
            {
              id: 'postgres',
              title: { 'zh-CN': 'PostgreSQL', en: 'PostgreSQL' },
              members: [
                {
                  match: {
                    kind: 'Cluster',
                    api_group: 'postgresql.cnpg.io',
                    namespaces: ['cchp-data'],
                    name_pattern: '^cchp-postgres$',
                  },
                },
                { match: { kind: 'component', name_pattern: '^pg$' } },
              ],
            },
            {
              id: 'nats',
              title: { 'zh-CN': 'NATS', en: 'NATS' },
              members: [
                { match: { kind: 'StatefulSet', namespaces: ['cchp-data'], name_pattern: '^cchp-nats$' } },
                { match: { kind: 'component', name_pattern: '^nats$' } },
              ],
            },
          ],
        },
      ],
      dependencies: [
        {
          from: [
            { kind: 'StatefulSet', namespaces: ['cchp-prod'], name_pattern: '^gateway$' },
            { kind: 'Deployment', namespaces: ['cchp-prod'], name_pattern: '^archive-exporter$' },
          ],
          to: [
            {
              kind: 'Cluster',
              api_group: 'postgresql.cnpg.io',
              namespaces: ['cchp-data'],
              name_pattern: '^cchp-postgres$',
            },
            { kind: 'StatefulSet', namespaces: ['cchp-data'], name_pattern: '^cchp-nats$' },
          ],
          reason: '从 cchp-runtime 读取数据库连接串',
        },
        {
          from: [{ kind: 'Deployment', namespaces: ['cchp-prod'], name_pattern: '^archive-exporter$' }],
          to: [{ kind: 'StatefulSet', namespaces: ['cchp-prod'], name_pattern: '^gateway$' }],
          reason: 'archive-exporter 回退读取 gateway:8091',
        },
      ],
    },
  ],
  TYPES,
);

const GW = 'StatefulSet:cchp-prod/gateway';
const GW_POD = 'Pod:cchp-prod/gateway-0';
const EXP = 'Deployment:cchp-prod/archive-exporter';
const EXP_RS = 'ReplicaSet:cchp-prod/archive-exporter-rs1';
const EXP_POD = 'Pod:cchp-prod/archive-exporter-rs1-abc';
const PG = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';
const PG_POD = 'Pod:cchp-data/cchp-postgres-3';
const NATS = 'StatefulSet:cchp-data/cchp-nats';
const NATS_POD = 'Pod:cchp-data/cchp-nats-0';
const NODE_APP = 'Node:appservice-01';
const NODE_OBS = 'Node:observability';
const UNRELATED_POD = 'Pod:observability/unrelated-daemon-0';
const SCRAPER = 'StatefulSet:observability/vmsingle';
const SCRAPER_POD = 'Pod:observability/vmsingle-0';
const DISTANT = 'Deployment:other/distant-app';
const DISTANT_POD = 'Pod:other/distant-app-0';

const SNAPSHOT = {
  version: 88,
  nodes: [
    n('StatefulSet', 'cchp-prod', 'gateway'),
    n('Pod', 'cchp-prod', 'gateway-0'),
    n('Deployment', 'cchp-prod', 'archive-exporter'),
    n('ReplicaSet', 'cchp-prod', 'archive-exporter-rs1'),
    n('Pod', 'cchp-prod', 'archive-exporter-rs1-abc'),
    n('Cluster.postgresql.cnpg.io', 'cchp-data', 'cchp-postgres'),
    n('Pod', 'cchp-data', 'cchp-postgres-3'),
    n('StatefulSet', 'cchp-data', 'cchp-nats'),
    n('Pod', 'cchp-data', 'cchp-nats-0'),
    n('Node', null, 'appservice-01'),
    n('Node', null, 'observability'),
    n('Pod', 'observability', 'unrelated-daemon-0'),
    n('StatefulSet', 'observability', 'vmsingle'),
    n('Pod', 'observability', 'vmsingle-0'),
    n('Deployment', 'other', 'distant-app'),
    n('Pod', 'other', 'distant-app-0'),
  ],
  edges: [
    e(GW_POD, 'owned_by', GW),
    e(GW_POD, 'runs_on', NODE_APP),
    e(EXP_RS, 'owned_by', EXP),
    e(EXP_POD, 'owned_by', EXP_RS),
    e(EXP_POD, 'runs_on', NODE_OBS),
    e(PG_POD, 'owned_by', PG),
    e(PG_POD, 'runs_on', NODE_OBS),
    e(NATS_POD, 'owned_by', NATS),
    e(UNRELATED_POD, 'runs_on', NODE_OBS),
    e(SCRAPER_POD, 'owned_by', SCRAPER),
    e(DISTANT_POD, 'owned_by', DISTANT),
    // 0.5 的网络策略放行链：gateway -> vmsingle -> distant-app
    e(GW, 'egress_to', SCRAPER, 'network_policy', 0.5, 'service'),
    e(SCRAPER, 'egress_to', DISTANT, 'network_policy', 0.5, 'service'),
  ],
};

describe('事件根因子图富化（ADR 0208）', () => {
  it('逻辑伪组件根因（component:gateway）展开为真实工作负载，转移告警并注入 business.yaml 声明依赖', () => {
    const g = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: 'component:gateway' },
        candidates: [],
        members: [{ component: 'component:gateway', alert_id: 'a-gw@1', left_version: null }],
        components: ['component:gateway'],
        primary_service: 'gateway',
      },
      2,
      { services: CATALOG, componentTypes: TYPES },
    );

    expect(g.topology_version).toBe(88);
    expect(g.root).toBe(GW);
    const rootNode = g.nodes.find((x) => x.component === GW);
    expect(rootNode).toMatchObject({ role: 'root', hops: 0, alerts: ['a-gw@1'] });

    // business.yaml 声明的出边（gateway -> PG/NATS）与入边（archive-exporter -> gateway）都进入子图
    expect(g.edges).toContainEqual({
      from: GW,
      to: PG,
      relation: 'depends_on',
      provenance: 'declared',
      confidence: 1,
      scope: 'service',
    });
    expect(g.edges).toContainEqual({
      from: GW,
      to: NATS,
      relation: 'depends_on',
      provenance: 'declared',
      confidence: 1,
      scope: 'service',
    });
    expect(g.edges).toContainEqual({
      from: EXP,
      to: GW,
      relation: 'depends_on',
      provenance: 'declared',
      confidence: 1,
      scope: 'service',
    });
  });

  it('逻辑伪组件按服务名与词干兜底展开（component:pg -> cchp-postgres、component:nats -> cchp-nats）', () => {
    const pgGraph = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: 'component:pg' },
        candidates: [],
        members: [{ component: 'component:pg', alert_id: 'a-pg@1', left_version: null }],
        components: ['component:pg'],
        primary_service: 'postgres',
      },
      1,
      { services: CATALOG, componentTypes: TYPES },
    );
    expect(pgGraph.root).toBe(PG);
    expect(pgGraph.nodes.find((x) => x.component === PG)).toMatchObject({ role: 'root', alerts: ['a-pg@1'] });
    expect(pgGraph.nodes.map((x) => x.component)).toEqual(expect.arrayContaining([GW, EXP, NODE_OBS]));

    const natsGraph = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: 'component:nats' },
        candidates: [],
        members: [],
        components: ['component:nats'],
        primary_service: 'nats',
      },
      1,
      { services: CATALOG, componentTypes: TYPES },
    );
    expect(natsGraph.root).toBe(NATS);
    expect(natsGraph.edges.some((x) => x.from === GW && x.to === NATS && x.provenance === 'declared')).toBe(true);
  });

  it('Deployment 补上直连宿主机 runs_on 边，展示与同机依赖的共享底座，同时不拉入同机无关 Pod', () => {
    const g = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: EXP },
        candidates: [],
        members: [{ component: EXP, alert_id: 'a-exp@1', left_version: null }],
        components: [EXP],
        primary_service: 'archive-exporter',
      },
      2,
      { services: CATALOG, componentTypes: TYPES },
    );

    // archive-exporter (Deployment) 1 跳直连 observability，同机依赖 cchp-postgres 也连到 observability
    expect(g.nodes.find((x) => x.component === NODE_OBS)).toMatchObject({ hops: 1 });
    expect(g.edges).toContainEqual({
      from: EXP,
      to: NODE_OBS,
      relation: 'runs_on',
      provenance: 'structural',
      confidence: 1,
      scope: 'instance',
    });
    expect(g.edges).toContainEqual({
      from: PG,
      to: NODE_OBS,
      relation: 'runs_on',
      provenance: 'structural',
      confidence: 1,
      scope: 'instance',
    });
    // 非根因 Node 不反向拉入同机无关 Pod
    expect(g.nodes.map((x) => x.component)).not.toContain(UNRELATED_POD);
  });

  it('Node 本身是根因时，照常展开运行在该节点上的工作负载与 Pod', () => {
    const g = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: NODE_OBS },
        candidates: [],
        members: [{ component: NODE_OBS, alert_id: 'a-disk@1', left_version: null }],
        components: [NODE_OBS],
      },
      1,
      { services: CATALOG, componentTypes: TYPES },
    );
    expect(g.root).toBe(NODE_OBS);
    expect(g.nodes.map((x) => x.component)).toEqual(expect.arrayContaining([EXP, PG, UNRELATED_POD]));
  });

  it('低于 0.6 的网络策略放行边保留在 1 跳，不在第 2 跳扩散成蛛网；无法解析的外部逻辑组件保留为单点', () => {
    const g = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: GW },
        candidates: [],
        members: [],
        components: [GW],
        primary_service: 'gateway',
      },
      2,
      { services: CATALOG, componentTypes: TYPES },
    );
    // 1 跳的 0.5 策略邻居保留（供前端切换“网络放行”查看）
    expect(g.nodes.map((x) => x.component)).toContain(SCRAPER);
    // 2 跳沿 0.5 策略链扩散的 distant-app 被截断
    expect(g.nodes.map((x) => x.component)).not.toContain(DISTANT);
    expect(g.nodes.every((x) => x.hops >= 0 && x.hops <= 2)).toBe(true);

    const ext = buildIncidentSubgraph(
      SNAPSHOT,
      {
        root: { component: 'component:provider' },
        candidates: [],
        members: [{ component: 'component:provider', alert_id: 'a-ext@1', left_version: null }],
        components: ['component:provider'],
      },
      2,
      { services: CATALOG, componentTypes: TYPES },
    );
    expect(ext.root).toBe('component:provider');
    expect(ext.nodes).toEqual([
      {
        component: 'component:provider',
        kind: 'component',
        namespace: null,
        name: 'provider',
        role: 'root',
        alerts: ['a-ext@1'],
        hops: 0,
      },
    ]);
  });
});
