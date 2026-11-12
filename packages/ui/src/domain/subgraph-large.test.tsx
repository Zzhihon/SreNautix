import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { IncidentSubgraph } from '../contract';
import { renderUi } from '../test/render';
import { Subgraph } from './Subgraph';
import { FOLD_MIN, foldSubgraph } from './subgraph-fold';

const ROOT = 'Deployment:app/gateway';
const NODE = 'Node:worker-1';
const pod = (i: number) => `Pod:batch/job-${i}`;
const svc = (i: number) => `Service:app/svc-${i}`;
const PODS = 6;
const SVCS = 11;

// 根因 gateway 在 worker-1 上；同一个节点上还有 6 个别的 Pod（2 跳邻居），11 个 Service 是事件成员
const graph: IncidentSubgraph = {
  topology_version: 7,
  root: ROOT,
  nodes: [
    { component: ROOT, kind: 'Deployment', namespace: 'app', name: 'gateway', role: 'root', alerts: ['a1@1'], hops: 0 },
    { component: NODE, kind: 'Node', namespace: null, name: 'worker-1', role: 'neighbor', alerts: [], hops: 1 },
    ...Array.from({ length: PODS }, (_, i) => ({
      component: pod(i),
      kind: 'Pod',
      namespace: 'batch',
      name: `job-${i}`,
      role: 'neighbor' as const,
      alerts: [],
      hops: 2,
    })),
    ...Array.from({ length: SVCS }, (_, i) => ({
      component: svc(i),
      kind: 'Service',
      namespace: 'app',
      name: `svc-${i}`,
      role: 'member' as const,
      alerts: [],
      hops: 1,
    })),
  ],
  edges: [
    { from: ROOT, to: NODE, relation: 'runs_on', provenance: 'structural', confidence: 1, scope: 'instance' },
    ...Array.from({ length: PODS }, (_, i) => ({
      from: pod(i),
      to: NODE,
      relation: 'runs_on',
      provenance: 'structural' as const,
      confidence: i === 2 ? 0.5 : 0.9,
      scope: 'instance' as const,
    })),
    ...Array.from({ length: SVCS }, (_, i) => ({
      from: svc(i),
      to: ROOT,
      relation: 'routes_to',
      provenance: 'structural' as const,
      confidence: 1,
      scope: 'service' as const,
    })),
  ],
};
const GROUP = `fold:${pod(0)}`;

describe('同类合并（ADR 0197）', () => {
  it('类型、命名空间、跳数与连接都相同的邻居合并成一组，边改接到组上并取最低的置信度', () => {
    const f = foldSubgraph(graph, new Set());
    expect(f.foldable).toBe(1);
    expect(f.groups).toEqual([
      { id: GROUP, kind: 'Pod', namespace: 'batch', hops: 2, members: graph.nodes.slice(2, 2 + PODS) },
    ]);
    expect(f.nodes.map((n) => n.component)).toEqual([ROOT, NODE, ...Array.from({ length: SVCS }, (_, i) => svc(i))]);
    expect(f.edges.filter((e) => e.from === GROUP)).toEqual([
      { from: GROUP, to: NODE, relation: 'runs_on', provenance: 'structural', confidence: 0.5, scope: 'instance' },
    ]);
    expect(f.edges).toHaveLength(1 + 1 + SVCS);
  });

  it('根因、成员、带告警的组件不合并；不到阈值或连接不同的邻居不合并；展开的组照常画出', () => {
    // 11 个 Service 是事件成员，连接完全相同也不合并
    expect(foldSubgraph(graph, new Set()).groups.flatMap((g) => g.members.map((m) => m.kind))).not.toContain('Service');
    const alerting = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.component === pod(1) ? { ...n, alerts: ['a2@1'] } : n)),
    };
    expect(foldSubgraph(alerting, new Set()).groups[0]?.members.map((m) => m.component)).not.toContain(pod(1));
    const few = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.kind !== 'Pod' || Number(n.name.slice(4)) < FOLD_MIN - 1),
    };
    expect(foldSubgraph(few, new Set()).groups).toEqual([]);
    const split = {
      ...graph,
      edges: graph.edges.map((e) => (e.from === pod(0) || e.from === pod(1) ? { ...e, relation: 'mounts' } : e)),
    };
    expect(foldSubgraph(split, new Set()).groups.map((g) => g.members.length)).toEqual([PODS - 2]);
    const open = foldSubgraph(graph, new Set([GROUP]));
    expect(open.groups).toEqual([]);
    expect(open.foldable).toBe(1);
    expect(open.nodes).toHaveLength(graph.nodes.length);
    expect(open.edges).toEqual(graph.edges);
  });
});

describe('组件多的子图（ADR 0197）', () => {
  const node = (name: string) => screen.findByRole('group', { name });
  const links = { topology: (c: string, k: string) => `/topology?cluster=${c}&component=${encodeURIComponent(k)}` };
  const card = (el: HTMLElement) => el.querySelector('[data-role]') as HTMLElement;
  const scale = () =>
    Number(
      /scale\(([\d.]+)\)/.exec(
        document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '',
      )?.[1],
    );

  it('合并的组是一个节点：侧栏列出成员并链接到各自的邻域；展开后成员单独画出，开关把它们合并回去', async () => {
    renderUi(<Subgraph graph={graph} clusterId="prod" />, { links });
    const group = await node('Pod，6 个同类组件已合并');
    expect(group.textContent).toContain('6 个同类组件 · batch');
    expect(screen.queryByRole('group', { name: 'job-0，邻居，0 条告警' })).toBeNull();
    fireEvent.click(group);
    const panel = await screen.findByTestId('subgraph-panel');
    expect(within(panel).getByRole('heading', { name: 'Pod × 6' })).toBeTruthy();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(PODS);
    expect(within(panel).getByRole('link', { name: 'job-3' }).getAttribute('href')).toBe(
      links.topology('prod', pod(3)),
    );
    fireEvent.click(within(panel).getByRole('button', { name: '在图上展开这一组' }));
    await node('job-0，邻居，0 条告警');
    await node('job-5，邻居，0 条告警');
    expect(screen.queryByRole('group', { name: 'Pod，6 个同类组件已合并' })).toBeNull();
    expect(screen.queryByTestId('subgraph-panel')).toBeNull();
    const toggle = screen.getByRole('button', { name: '合并同类组件' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await node('job-0，邻居，0 条告警');
    fireEvent.click(toggle);
    await node('Pod，6 个同类组件已合并');
    await waitFor(() => expect(screen.queryByRole('group', { name: 'job-0，邻居，0 条告警' })).toBeNull());
  });

  it('双击合并的组在图上展开它，不交给宿主', async () => {
    const opened: string[] = [];
    renderUi(<Subgraph graph={graph} onOpenComponent={(c) => opened.push(c)} />);
    fireEvent.doubleClick(await node('Pod，6 个同类组件已合并'));
    await node('job-0，邻居，0 条告警');
    expect(opened).toEqual([]);
  });

  it('指向一个节点只突出它和直接相连的组件；组件多时边的标注只出现在这个节点的边上', async () => {
    renderUi(<Subgraph graph={graph} />);
    const worker = await node('worker-1，邻居，0 条告警');
    const root = await node('gateway，根因，1 条告警');
    const group = await node('Pod，6 个同类组件已合并');
    const svc0 = await node('svc-0，成员，0 条告警');
    expect(document.querySelectorAll('.react-flow__edge-text')).toHaveLength(0);
    await userEvent.hover(worker);
    await waitFor(() => expect(card(svc0).hasAttribute('data-dim')).toBe(true));
    for (const el of [worker, root, group]) {
      expect(card(el).hasAttribute('data-dim')).toBe(false);
    }
    const labels = [...document.querySelectorAll('.react-flow__edge-text')].map((e) => e.textContent);
    expect(labels.sort()).toEqual(['runs_on · 结构 0.5', 'runs_on · 结构 1']);
    await userEvent.unhover(worker);
    await waitFor(() => expect(card(svc0).hasAttribute('data-dim')).toBe(false));
  });

  it('查找：按名称与组件键匹配，合并的组按成员匹配；回车依次定位，Esc 清空', async () => {
    renderUi(<Subgraph graph={graph} />);
    const group = await node('Pod，6 个同类组件已合并');
    const svc3 = await node('svc-3，成员，0 条告警');
    const find = screen.getByRole('searchbox', { name: '查找组件' });
    await userEvent.fill(find, 'job-4');
    await waitFor(() => expect(card(group).hasAttribute('data-hit')).toBe(true));
    expect(card(svc3).hasAttribute('data-dim')).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('1 个匹配，回车定位');
    await userEvent.fill(find, 'SVC-1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('2 个匹配，回车定位'));
    const before = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByRole('status').textContent).toBe('1 / 2');
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform).not.toBe(before),
    );
    await waitFor(() => expect(scale()).toBeGreaterThanOrEqual(1));
    // 定位移动了画布：把鼠标留在查找框上，不让它落在某个节点上触发突出
    await userEvent.hover(find);
    await userEvent.fill(find, 'nothing-like-this');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('没有匹配的组件'));
    fireEvent.keyDown(find, { key: 'Escape' });
    await waitFor(() => expect(card(svc3).hasAttribute('data-dim')).toBe(false));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('组件少的子图没有查找框与合并开关', async () => {
    renderUi(<Subgraph graph={{ ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1) }} />);
    await node('gateway，根因，1 条告警');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '合并同类组件' })).toBeNull();
  });

  it('嵌在页面里时普通滚轮不缩放画布，并提示按住 Ctrl 或 ⌘；画布是页面主要内容时滚轮直接缩放', async () => {
    const wheel = () =>
      fireEvent.wheel(document.querySelector('.react-flow__pane') as Element, {
        deltaY: -240,
        clientX: 200,
        clientY: 100,
      });
    const inline = renderUi(<Subgraph graph={graph} />);
    await node('gateway，根因，1 条告警');
    await waitFor(() => expect(scale()).toBeGreaterThan(0));
    const before = scale();
    wheel();
    expect(await screen.findByText('按住 Ctrl 或 ⌘ 再滚动，可以缩放画布')).toBeTruthy();
    expect(scale()).toBe(before);
    inline.unmount();

    renderUi(<Subgraph graph={graph} primary />);
    await node('gateway，根因，1 条告警');
    await waitFor(() => expect(scale()).toBeGreaterThan(0));
    const fitted = scale();
    wheel();
    await waitFor(() => expect(scale()).toBeGreaterThan(fitted));
    expect(screen.queryByText('按住 Ctrl 或 ⌘ 再滚动，可以缩放画布')).toBeNull();
  });

  it('可以放大到 4 倍、缩小到能看到整张图', async () => {
    renderUi(<Subgraph graph={graph} primary />);
    await node('gateway，根因，1 条告警');
    const zoomIn = screen.getByRole('button', { name: '放大' });
    for (let i = 0; i < 12 && !(zoomIn as HTMLButtonElement).disabled; i++) {
      await userEvent.click(zoomIn);
    }
    await waitFor(() => expect(scale()).toBe(4));
    const zoomOut = screen.getByRole('button', { name: '缩小' });
    for (let i = 0; i < 40 && !(zoomOut as HTMLButtonElement).disabled; i++) {
      await userEvent.click(zoomOut);
    }
    await waitFor(() => expect(scale()).toBe(0.1));
  });
});
