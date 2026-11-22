import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentSubgraph, OntologyGlossary } from '../contract';
import { ApiError, type PromoteKnowledgeRequest } from '../port';
import { evidence, incident } from '../test/fixtures';
import { renderUi } from '../test/render';
import { EvidenceCard } from './EvidenceCard';
import { lookupConcept, lookupNodeOntology } from './ontology';
import { defaultKnowledgeDraft, PromoteCaseButton } from './PromoteCaseButton';
import { Subgraph } from './Subgraph';
import { classifySwimlane, computeCriticalCausalPath, criticalEdgeKey, layoutSwimlanes } from './subgraph-model';

const GLOSSARY: OntologyGlossary = {
  pack_lock: 'sha256:test',
  component_types: {
    'kubernetes.node': {
      title: 'Kubernetes Node',
      description: '集群宿主机节点',
      layer: 'L3',
      external: false,
      hub: false,
      match: { kind: 'Node' },
    },
    'generic.gateway': {
      title: 'Generic StatefulSet',
      description: '通用有状态服务',
      layer: 'L1',
      external: false,
      hub: false,
      match: { kind: 'StatefulSet' },
    },
    'cchp.gateway': {
      title: 'CCHP Gateway',
      description: 'CCHP 核心流量网关',
      layer: 'L1',
      external: false,
      hub: false,
      match: { kind: 'StatefulSet', namespaces: ['cchp-prod'], name_pattern: '^gateway$' },
    },
    'cchp.archive-exporter': {
      title: 'Archive Exporter',
      description: '从 gateway 本地卷拉取归档块并上传至对象存储的守护进程',
      layer: 'L1',
      external: false,
      hub: false,
      match: { kind: 'Deployment', namespaces: ['cchp-prod'], name_pattern: '^archive-exporter$' },
    },
    'cchp.cchp-postgres': {
      title: 'CCHP PostgreSQL',
      description: '主业务关系型数据库（CNPG 托管）',
      layer: 'L2',
      external: false,
      hub: false,
      match: { kind: 'Cluster', api_group: 'postgresql.cnpg.io', namespaces: ['db'] },
    },
    'labeled.pod': {
      title: 'Labeled Pod',
      description: '带标签约束的特定 Pod',
      layer: 'L2',
      external: false,
      hub: false,
      match: { kind: 'Pod', has_labels: true },
    },
  },
  cards: {
    'cchp/archive/disk-budget': {
      title: '归档卷可用空间接近预算上限',
      description: '比较归档卷已用字节与扣除保留字节后的有效预算',
      unit: 'bytes',
      category: 'storage',
    },
  },
  concepts: {
    volume_reserve_bytes: {
      title: '卷预留安全字节 (volume_reserve_bytes)',
      description: '节点文件系统为操作系统和 kubelet 预留的安全缓冲字节数，不计入业务归档可用预算。',
    },
    'archive-exporter': {
      title: '归档导出组件 (archive-exporter)',
      description: '将网关本地卷的请求归档批量写入对象存储并触发本地清理。',
    },
  },
};

const EDGE = 'Ingress:edge/ccx-route';
const GW = 'StatefulSet:cchp-prod/gateway';
const EXP = 'Deployment:cchp-prod/archive-exporter';
const PG = 'Cluster:db/cchp-postgres';
const HOST = 'Node:storage-01';
const SIDE = 'Deployment:cchp-prod/metrics-helper';

const GRAPH: IncidentSubgraph = {
  topology_version: 12,
  root: PG,
  nodes: [
    {
      component: EDGE,
      kind: 'Ingress',
      namespace: 'edge',
      name: 'ccx-route',
      role: 'member',
      alerts: ['a-5xx'],
      hops: 2,
    },
    {
      component: GW,
      kind: 'StatefulSet',
      namespace: 'cchp-prod',
      name: 'gateway',
      role: 'member',
      alerts: ['a-gw'],
      hops: 1,
    },
    {
      component: EXP,
      kind: 'Deployment',
      namespace: 'cchp-prod',
      name: 'archive-exporter',
      role: 'neighbor',
      alerts: [],
      hops: 2,
    },
    { component: PG, kind: 'Cluster', namespace: 'db', name: 'cchp-postgres', role: 'root', alerts: ['a-pg'], hops: 0 },
    { component: HOST, kind: 'Node', namespace: null, name: 'storage-01', role: 'neighbor', alerts: [], hops: 1 },
    {
      component: SIDE,
      kind: 'Deployment',
      namespace: 'cchp-prod',
      name: 'metrics-helper',
      role: 'neighbor',
      alerts: [],
      hops: 2,
    },
  ],
  edges: [
    { from: EDGE, to: GW, relation: 'routes_to', provenance: 'structural', confidence: 1, scope: 'service' },
    { from: GW, to: PG, relation: 'depends_on', provenance: 'declared', confidence: 1, scope: 'service' },
    { from: GW, to: EXP, relation: 'depends_on', provenance: 'declared', confidence: 0.9, scope: 'service' },
    { from: PG, to: HOST, relation: 'runs_on', provenance: 'structural', confidence: 1, scope: 'instance' },
    { from: SIDE, to: EXP, relation: 'depends_on', provenance: 'declared', confidence: 0.8, scope: 'service' },
  ],
};

describe('五层因果泳道模型、本体 match 规则与关键路径算法', () => {
  it('lookupNodeOntology 按 match 规则（kind + namespaces + name_pattern）取最具体匹配，且防止原型链键污染', () => {
    // 通用 kind 匹配命中 kubernetes.node
    const hostInfo = lookupNodeOntology(
      { component: HOST, kind: 'Node', namespace: null, name: 'storage-01' },
      GLOSSARY,
    );
    expect(hostInfo.source).toBe('pack');
    expect(hostInfo.title).toBe('Kubernetes Node');
    expect(hostInfo.layer).toBe('L3');

    // cchp.gateway（具体度 2）胜过声明在前的 generic.gateway（具体度 0）
    const gwInfo = lookupNodeOntology(
      { component: GW, kind: 'StatefulSet', namespace: 'cchp-prod', name: 'gateway' },
      GLOSSARY,
    );
    expect(gwInfo.title).toBe('CCHP Gateway');
    expect(gwInfo.description).toContain('核心流量网关');

    // 不同命名空间的同名 StatefulSet 命中通用匹配而非 cchp.gateway
    const otherGw = lookupNodeOntology(
      { component: 'StatefulSet:other/gateway', kind: 'StatefulSet', namespace: 'other', name: 'gateway' },
      GLOSSARY,
    );
    expect(otherGw.title).toBe('Generic StatefulSet');

    // 带 labels 约束的 component_type 不劫持普通 Pod
    const plainPod = lookupNodeOntology(
      { component: 'Pod:app/worker-1', kind: 'Pod', namespace: 'app', name: 'worker-1' },
      GLOSSARY,
    );
    expect(plainPod.title).not.toBe('Labeled Pod');

    // 原型链键名（constructor / toString / __proto__）安全返回兜底或 null，绝不抛异常
    const protoNode = lookupNodeOntology(
      { component: 'Deployment:app/constructor', kind: 'Deployment', namespace: 'app', name: 'constructor' },
      GLOSSARY,
    );
    expect(protoNode.source).toBe('fallback');
    expect(lookupConcept('toString', GLOSSARY)).toBeNull();
    expect(lookupConcept('constructor', GLOSSARY)).toBeNull();
  });

  it('按语义层级将节点归入 L0 / L1 / L2 / L3 / external，并优先遵循本体 glossary 声明', () => {
    expect(classifySwimlane({ component: EDGE, kind: 'Ingress', namespace: 'edge', name: 'ccx-route' }, GLOSSARY)).toBe(
      'L0',
    );
    expect(
      classifySwimlane({
        component: 'Deployment:edge/cloudflared',
        kind: 'Deployment',
        namespace: 'edge',
        name: 'cloudflared',
      }),
    ).toBe('L0');
    expect(
      classifySwimlane({ component: GW, kind: 'StatefulSet', namespace: 'cchp-prod', name: 'gateway' }, GLOSSARY),
    ).toBe('L1');
    expect(
      classifySwimlane(
        { component: EXP, kind: 'Deployment', namespace: 'cchp-prod', name: 'archive-exporter' },
        GLOSSARY,
      ),
    ).toBe('L1');
    expect(classifySwimlane({ component: PG, kind: 'Cluster', namespace: 'db', name: 'cchp-postgres' }, GLOSSARY)).toBe(
      'L2',
    );
    expect(
      classifySwimlane({
        component: 'PersistentVolumeClaim:db/pg-data',
        kind: 'PersistentVolumeClaim',
        namespace: 'db',
        name: 'pg-data',
      }),
    ).toBe('L2');
    expect(classifySwimlane({ component: HOST, kind: 'Node', namespace: null, name: 'storage-01' }, GLOSSARY)).toBe(
      'L3',
    );
    expect(
      classifySwimlane({
        component: 'provider:ext/openai-api',
        kind: 'provider',
        namespace: 'ext',
        name: 'openai-api',
      }),
    ).toBe('external');

    // glossary 中显式指定 layer 覆盖默认启发式
    const customGlossary: OntologyGlossary = {
      ...GLOSSARY,
      component_types: {
        'cchp.custom-edge': {
          title: 'Custom Edge',
          description: 'test',
          layer: 'L0',
          external: false,
          hub: false,
          match: { kind: 'Deployment', namespaces: ['cchp'], name_pattern: '^custom-edge$' },
        },
      },
    };
    expect(
      classifySwimlane(
        { component: 'Deployment:cchp/custom-edge', kind: 'Deployment', namespace: 'cchp', name: 'custom-edge' },
        customGlossary,
      ),
    ).toBe('L0');
  });

  it('精确提取告警症状节点到根因的最短关键因果路径，排除无关分支', () => {
    const crit = computeCriticalCausalPath(GRAPH);
    expect(crit.hasPath).toBe(true);
    expect(crit.root).toBe(PG);
    expect([...crit.nodes].sort()).toEqual([EDGE, GW, PG].sort());
    expect(crit.edges.has(criticalEdgeKey({ from: EDGE, to: GW, relation: 'routes_to' }))).toBe(true);
    expect(crit.edges.has(criticalEdgeKey({ from: GW, to: PG, relation: 'depends_on' }))).toBe(true);
    expect(crit.edges.has(criticalEdgeKey({ from: GW, to: EXP, relation: 'depends_on' }))).toBe(false);
    expect(crit.nodes.has(HOST)).toBe(false);
    expect(crit.nodes.has(SIDE)).toBe(false);
  });

  it('垂直泳道布局按 L0 < L1 < L2 < L3 递增排列且同层节点互不重叠', () => {
    const items = GRAPH.nodes.map((n) => ({
      id: n.component,
      lane: classifySwimlane(n, GLOSSARY),
      priority: n.role === 'root' ? 0 : 1,
      label: n.name,
    }));
    const res = layoutSwimlanes(items, GRAPH.edges);
    expect(res.lanes.map((l) => l.id)).toEqual(['L0', 'L1', 'L2', 'L3']);
    const yEdge = res.positions.get(EDGE)!.y;
    const yGw = res.positions.get(GW)!.y;
    const yPg = res.positions.get(PG)!.y;
    const yHost = res.positions.get(HOST)!.y;
    expect(yEdge).toBeLessThan(yGw);
    expect(yGw).toBeLessThan(yPg);
    expect(yPg).toBeLessThan(yHost);

    const l1Xs = [GW, EXP, SIDE].map((id) => res.positions.get(id)!.x).sort((a, b) => a - b);
    expect(l1Xs[1]! - l1Xs[0]!).toBeGreaterThanOrEqual(200);
    expect(l1Xs[2]! - l1Xs[1]!).toBeGreaterThanOrEqual(200);
  });
});

describe('Subgraph 泳道渲染、状态胶囊、关键路径与本体提示', () => {
  it('默认渲染五层泳道与关键路径样式、变更胶囊，并可切换至自动布局', async () => {
    const { container } = renderUi(<Subgraph graph={GRAPH} glossary={GLOSSARY} changedComponents={new Set([GW])} />);

    await waitFor(() => {
      expect(container.querySelector('[data-lane="L0"]')).toBeTruthy();
      expect(container.querySelector('[data-lane="L1"]')).toBeTruthy();
      expect(container.querySelector('[data-lane="L2"]')).toBeTruthy();
      expect(container.querySelector('[data-lane="L3"]')).toBeTruthy();
    });

    const gwGroup = await screen.findByRole('group', { name: /^gateway，/ });
    const gwCard = gwGroup.querySelector('[data-role]') as HTMLElement;
    expect(gwCard.hasAttribute('data-critical-path')).toBe(true);
    expect(gwCard.hasAttribute('data-path-dim')).toBe(false);
    expect(gwCard.textContent).toContain('近期变更');

    const hostGroup = await screen.findByRole('group', { name: /^storage-01，/ });
    const hostCard = hostGroup.querySelector('[data-role]') as HTMLElement;
    expect(hostCard.hasAttribute('data-critical-path')).toBe(false);
    expect(hostCard.hasAttribute('data-path-dim')).toBe(true);
    expect(hostCard.hasAttribute('data-dim')).toBe(false);
    expect(hostCard.textContent).toContain('健康');

    fireEvent.click(gwGroup);
    const panel = await screen.findByRole('complementary');
    expect(panel.textContent).toContain('L1 · 业务负载');
    expect(panel.textContent).toContain('上游调用');
    expect(panel.textContent).toContain('下游依赖');

    fireEvent.click(screen.getByRole('button', { name: '自动布局' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '自动布局' }).getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('.react-flow__node-lane')).toBeNull();
      expect(screen.getByRole('group', { name: /^gateway，/ })).toBeTruthy();
    });
  });

  it('同类邻居被折叠时，穿透折叠组的关键因果路径边依然保持高亮而不被淡化', async () => {
    const proxies = Array.from({ length: 4 }, (_, i) => `Pod:app/proxy-${i}`);
    const foldedCritGraph: IncidentSubgraph = {
      topology_version: 13,
      root: PG,
      nodes: [
        {
          component: EDGE,
          kind: 'Ingress',
          namespace: 'edge',
          name: 'ccx-route',
          role: 'member',
          alerts: ['a-edge'],
          hops: 2,
        },
        ...proxies.map((p, i) => ({
          component: p,
          kind: 'Pod',
          namespace: 'app',
          name: `proxy-${i}`,
          role: 'neighbor' as const,
          alerts: [],
          hops: 1,
        })),
        {
          component: PG,
          kind: 'Cluster',
          namespace: 'db',
          name: 'cchp-postgres',
          role: 'root',
          alerts: ['a-pg'],
          hops: 0,
        },
      ],
      edges: [
        ...proxies.map((p) => ({
          from: EDGE,
          to: p,
          relation: 'routes_to',
          provenance: 'structural' as const,
          confidence: 1,
          scope: 'service' as const,
        })),
        ...proxies.map((p) => ({
          from: p,
          to: PG,
          relation: 'depends_on',
          provenance: 'declared' as const,
          confidence: 1,
          scope: 'service' as const,
        })),
      ],
    };
    const { container } = renderUi(<Subgraph graph={foldedCritGraph} glossary={GLOSSARY} />);
    await waitFor(() => {
      expect(container.querySelector('[data-fold]')).toBeTruthy();
      const edges = [...container.querySelectorAll('.react-flow__edge')];
      expect(edges.length).toBe(2);
      // 两条通向/来自折叠组的关键路径边均包含 edgeCritical 类名而非 edgeSecondary
      expect(edges.every((e) => (e.getAttribute('class') ?? '').includes('edgeCritical'))).toBe(true);
    });
  });

  it('证据卡展示卡片与观测指标的本体术语说明入口', () => {
    const card = evidence({
      ref: 'card:1',
      card_id: 'cchp/archive/disk-budget',
      display_state: 'abnormal',
      observations: { volume_reserve_bytes: 1073741824, toString: 42 },
    });
    renderUi(<EvidenceCard r={card} glossary={GLOSSARY} />);
    expect(screen.getByRole('button', { name: '查看指标与组件术语说明' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /判定依据/ }));
    expect(screen.getByText('volume_reserve_bytes')).toBeTruthy();
  });
});

describe('PromoteCaseButton 战情室一键沉淀知识案例', () => {
  it('预填诊断摘要、将告警名数组截断至 20 条上限并提交至 POST /v1/incidents/{ref}/knowledge', async () => {
    const manyMembers = Array.from({ length: 25 }, (_, i) => ({
      alert_id: `a${i}`,
      alertname: `AlertStorm${String(i).padStart(2, '0')}`,
      severity: 'critical' as const,
      component: 'StatefulSet:cchp-prod/gateway',
      role: 'symptom' as const,
      status: 'firing' as const,
      starts_at: '2026-10-19T06:18:00Z',
      ends_at: null,
      joined_version: 1,
      left_version: null,
    }));
    const inc = incident({ members: manyMembers });
    const draft = defaultKnowledgeDraft({
      incident: inc,
      disposition: 'act',
      rootComponent: 'postgres.cluster:db/pg-main',
      run: null,
      latestFeedback: null,
    });
    expect(draft.kind).toBe('incident');
    expect(draft.alertnames).toHaveLength(20);

    const calls: Array<{ ref: string; body: PromoteKnowledgeRequest }> = [];
    renderUi(
      <PromoteCaseButton
        incidentRef={inc.incident_id}
        incident={inc}
        disposition="act"
        rootComponent="postgres.cluster:db/pg-main"
        run={null}
        latestFeedback={null}
      />,
      {
        links: { knowledge: () => '/eval?tab=knowledge' },
        port: {
          actions: {
            approve: vi.fn(),
            reject: vi.fn(),
            undo: vi.fn(),
            requestResearch: vi.fn(),
            rerunEvidence: vi.fn(),
            claim: vi.fn(),
            release: vi.fn(),
            promoteIncidentKnowledge: async (ref, body) => {
              calls.push({ ref, body });
              return {
                case_id: 'learned-001',
                origin: 'learned',
                kind: body.kind ?? 'incident',
                title: body.title ?? 't',
                text: body.text ?? 'x',
                components: body.components ?? [],
                alertnames: body.alertnames ?? [],
                incident_id: inc.incident_id,
                feedback_id: null,
                cluster_id: inc.cluster_id,
                source: 'human',
                created_by: 'alice',
                created_at: '2026-11-22T00:00:00Z',
              };
            },
          },
        },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '沉淀为知识案例' }));
    const textArea = await screen.findByLabelText(/诊断要点与机制说明/);
    fireEvent.change(textArea, { target: { value: '主库内存达到上限导致写入阻塞' } });
    fireEvent.click(screen.getByRole('button', { name: '存入知识库' }));

    await waitFor(() => {
      expect(screen.getByText('已沉淀到知识库')).toBeTruthy();
      expect(screen.getByRole('link', { name: '查看知识库' }).getAttribute('href')).toBe('/eval?tab=knowledge');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe(inc.incident_id);
    expect(calls[0]!.body.alertnames).toHaveLength(20);
  });

  it('区分未部署路由 404（优雅降级提示）与真实业务 404 not_found（正常报错）', async () => {
    const inc = incident();
    // 1. 路由未挂载（Fastify 默认 404，error !== 'not_found'）→ 优雅提示后端未启用
    const first = renderUi(
      <PromoteCaseButton
        incidentRef={inc.incident_id}
        incident={inc}
        disposition="ignore"
        rootComponent={null}
        run={null}
        latestFeedback={null}
      />,
      {
        port: {
          actions: {
            approve: vi.fn(),
            reject: vi.fn(),
            undo: vi.fn(),
            requestResearch: vi.fn(),
            rerunEvidence: vi.fn(),
            claim: vi.fn(),
            release: vi.fn(),
            promoteIncidentKnowledge: async () => {
              throw new ApiError(
                404,
                'Not Found',
                'Route POST:/v1/incidents/.../knowledge not found',
                'promoteIncidentKnowledge',
              );
            },
          },
        },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '沉淀为知识案例' }));
    fireEvent.change(await screen.findByLabelText(/诊断要点与机制说明/), { target: { value: '已知压测噪声，忽略' } });
    fireEvent.click(screen.getByRole('button', { name: '存入知识库' }));
    await waitFor(() => {
      expect(screen.getByText(/当前服务端尚未启用知识沉淀接口/)).toBeTruthy();
    });
    first.unmount();

    // 2. 真实业务 404（code === 'not_found'，例如事件不在作用域或不存在）→ 展示常规 ErrorBox
    renderUi(
      <PromoteCaseButton
        incidentRef={inc.incident_id}
        incident={inc}
        disposition="act"
        rootComponent={null}
        run={null}
        latestFeedback={null}
      />,
      {
        port: {
          actions: {
            approve: vi.fn(),
            reject: vi.fn(),
            undo: vi.fn(),
            requestResearch: vi.fn(),
            rerunEvidence: vi.fn(),
            claim: vi.fn(),
            release: vi.fn(),
            promoteIncidentKnowledge: async () => {
              throw new ApiError(404, 'not_found', '事件不存在或不在读取范围内', 'promoteIncidentKnowledge');
            },
          },
        },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: '沉淀为知识案例' }));
    fireEvent.change(await screen.findByLabelText(/诊断要点与机制说明/), { target: { value: '真实故障记录' } });
    fireEvent.click(screen.getByRole('button', { name: '存入知识库' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('沉淀知识案例失败');
      expect(screen.queryByText(/当前服务端尚未启用知识沉淀接口/)).toBeNull();
    });
  });
});
