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

  it('仅经 network_policy（含 0.6）到达的 1 跳节点在第 2 跳不扩散，第 2 跳不穿越任何策略边；同时有强边时仍照常展开', () => {
    const snap = {
      version: 90,
      nodes: [...SNAPSHOT.nodes, n('Deployment', 'observability', 'alloy'), n('Pod', 'observability', 'alloy-0')],
      edges: [
        // 故意把 0.6 的 network_policy 边放在前面，验证 PG 同时有 declared 边时仍能进入 strong 集合
        e(GW, 'egress_to', PG, 'network_policy', 0.6, 'service'),
        e(GW, 'egress_to', 'Deployment:observability/alloy', 'network_policy', 0.6, 'service'),
        e('Pod:observability/alloy-0', 'owned_by', 'Deployment:observability/alloy'),
        e('Deployment:observability/alloy', 'egress_to', DISTANT, 'network_policy', 0.6, 'service'),
        e(PG, 'primary', PG_POD),
        e(PG, 'egress_to', DISTANT, 'network_policy', 0.6, 'service'),
        ...SNAPSHOT.edges,
      ],
    };

    const g = buildIncidentSubgraph(
      snap,
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

    const keys = g.nodes.map((x) => x.component);
    // 1 跳策略邻居保留为叶子，但绝不向第 2 跳扩散其 Pod 或远端节点
    expect(keys).toContain('Deployment:observability/alloy');
    expect(keys).not.toContain('Pod:observability/alloy-0');
    expect(keys).not.toContain(SCRAPER_POD);
    expect(keys).not.toContain(DISTANT);
    // PG 同时通过 declared 到达，因此第 2 跳照常沿 primary 展开到 PG_POD，但不沿 0.6 network_policy 去往 DISTANT
    expect(keys).toContain(PG);
    expect(keys).toContain(PG_POD);
    expect(g.edges.some((x) => x.from === PG && x.to === PG_POD && x.relation === 'primary')).toBe(true);
  });

  it('非根因共享叶子（ConfigMap、Secret、Application、PDB、HPA、Service、ReplicaSet）保留为 1 跳上下文，不在第 2 跳扩散成蛛网', () => {
    const CM = 'ConfigMap:cchp-prod/cchp-runtime';
    const SEC = 'Secret:cchp-prod/cchp-db';
    const APP = 'Application.argoproj.io:argocd/cchp-prod';
    const PDB = 'PodDisruptionBudget:cchp-prod/exp-pdb';
    const HPA = 'HorizontalPodAutoscaler:cchp-prod/exp-hpa';
    const SVC = 'Service:cchp-prod/exp-svc';
    const OLD_RS = 'ReplicaSet:cchp-prod/archive-exporter-old';
    const OLD_POD = 'Pod:cchp-prod/archive-exporter-old-xyz';
    const WF = 'Workflow.argoproj.io:cchp-prod/release-old-1';
    const SEC_PEER = 'Deployment:cchp-prod/secret-peer';
    const APP_PEER = 'Deployment:cchp-prod/app-peer';
    const PDB_PEER = 'Deployment:cchp-prod/pdb-peer';
    const KEDA = 'ScaledObject.keda.sh:cchp-prod/exp-keda';
    const SVC_CLIENT = 'Deployment:cchp-prod/svc-client';

    const snap = {
      version: 91,
      nodes: [
        ...SNAPSHOT.nodes,
        n('ConfigMap', 'cchp-prod', 'cchp-runtime'),
        n('Secret', 'cchp-prod', 'cchp-db'),
        n('Application.argoproj.io', 'argocd', 'cchp-prod'),
        n('PodDisruptionBudget', 'cchp-prod', 'exp-pdb'),
        n('HorizontalPodAutoscaler', 'cchp-prod', 'exp-hpa'),
        n('Service', 'cchp-prod', 'exp-svc'),
        n('ReplicaSet', 'cchp-prod', 'archive-exporter-old'),
        n('Pod', 'cchp-prod', 'archive-exporter-old-xyz'),
        n('Workflow.argoproj.io', 'cchp-prod', 'release-old-1'),
        n('Deployment', 'cchp-prod', 'secret-peer'),
        n('Deployment', 'cchp-prod', 'app-peer'),
        n('Deployment', 'cchp-prod', 'pdb-peer'),
        n('ScaledObject.keda.sh', 'cchp-prod', 'exp-keda'),
        n('Deployment', 'cchp-prod', 'svc-client'),
      ],
      edges: [
        ...SNAPSHOT.edges,
        e(EXP, 'references', CM, 'config_ref', 0.7, 'service'),
        e(WF, 'references', CM, 'config_ref', 0.7, 'service'),
        e(EXP, 'references', SEC, 'config_ref', 0.7, 'service'),
        e(SEC_PEER, 'references', SEC, 'config_ref', 0.7, 'service'),
        e(EXP, 'managed_by', APP),
        e(APP_PEER, 'managed_by', APP),
        e(PDB, 'protects', EXP),
        e(PDB, 'protects', PDB_PEER),
        e(HPA, 'scales', EXP),
        e(HPA, 'owned_by', KEDA),
        e(SVC, 'selects', EXP),
        e(SVC_CLIENT, 'references', SVC, 'config_ref', 0.7, 'service'),
        e(OLD_RS, 'owned_by', EXP),
        e(OLD_POD, 'owned_by', OLD_RS),
      ],
    };

    const g = buildIncidentSubgraph(
      snap,
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

    const byComp = new Map(g.nodes.map((x) => [x.component, x]));
    // 所有共享叶子都在第 1 跳保留为上下文
    for (const leaf of [CM, SEC, APP, PDB, HPA, SVC, OLD_RS, NODE_OBS]) {
      expect(byComp.get(leaf)?.hops, leaf).toBe(1);
    }
    // 第 2 跳绝不穿过这些共享叶子拉入无关对象或历史 Pod/Workflow
    for (const blocked of [WF, SEC_PEER, APP_PEER, PDB_PEER, KEDA, SVC_CLIENT, OLD_POD, EXP_POD, UNRELATED_POD]) {
      expect(byComp.has(blocked), blocked).toBe(false);
    }
  });

  it('Pod 根因保留 Pod -> ReplicaSet -> Deployment 向上归属及存储链路，不拉入同 ReplicaSet 兄弟 Pod', () => {
    const SIBLING_POD = 'Pod:cchp-prod/archive-exporter-rs1-def';
    const PVC = 'PersistentVolumeClaim:cchp-prod/archive-spool';
    const PV = 'PersistentVolume:pvc-123';
    const snap = {
      version: 92,
      nodes: [
        ...SNAPSHOT.nodes,
        n('Pod', 'cchp-prod', 'archive-exporter-rs1-def'),
        n('PersistentVolumeClaim', 'cchp-prod', 'archive-spool'),
        n('PersistentVolume', null, 'pvc-123'),
      ],
      edges: [...SNAPSHOT.edges, e(SIBLING_POD, 'owned_by', EXP_RS), e(EXP_POD, 'mounts', PVC), e(PVC, 'bound_to', PV)],
    };

    const g = buildIncidentSubgraph(
      snap,
      {
        root: { component: EXP_POD },
        candidates: [],
        members: [{ component: EXP_POD, alert_id: 'a-pod@1', left_version: null }],
        components: [EXP_POD],
        primary_service: 'archive-exporter',
      },
      2,
      { services: CATALOG, componentTypes: TYPES },
    );

    const byComp = new Map(g.nodes.map((x) => [x.component, x]));
    expect(byComp.get(EXP_POD)?.hops).toBe(0);
    expect(byComp.get(EXP_RS)?.hops).toBe(1);
    expect(byComp.get(EXP)?.hops).toBe(2);
    expect(byComp.get(PVC)?.hops).toBe(1);
    expect(byComp.get(PV)?.hops).toBe(2);
    expect(byComp.get(NODE_OBS)?.hops).toBe(1);
    expect(byComp.has(SIBLING_POD)).toBe(false);
    expect(byComp.has(UNRELATED_POD)).toBe(false);
  });
});
