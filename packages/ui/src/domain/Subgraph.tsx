// 根因子图（DESIGN §12.2、§12.5、ADR 0191、ADR 0197、ADR 0208）：
// 支持五层垂直语义因果泳道（L0 入口/边缘 → L1 业务负载 → L2 数据与存储 → L3 节点与底座 → external 外部依赖，默认）
// 与自动 ELK 布局切换；突出症状到最高怀疑根因的关键因果路径，在节点内展示状态胶囊，并在悬停/聚焦时呈现运维本体说明。

import { Handle, Position, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';
import { Tooltip } from 'radix-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IncidentSubgraph, OntologyGlossary } from '../contract';
import { AppLink, useOntologyGlossary, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Mono } from '../primitives/basic';
import { usePortalContainer } from '../theme/ThemeRoot';
import { componentLabel, displayComponent } from './model';
import {
  canvasStyles,
  GraphCanvas,
  loadElk,
  MINIMAP_MIN_NODES,
  SidePanel,
  useCanvasView,
  viewAttrs,
  type CanvasEdge,
} from './GraphCanvas';
import { lookupNodeOntology } from './ontology';
import styles from './Subgraph.module.css';
import { useComponentNames } from './names';
import { foldSubgraph, type FoldGroup } from './subgraph-fold';
import {
  classifySwimlane,
  computeCriticalCausalPath,
  criticalEdgeKey,
  defaultSubgraphLevel,
  filterSubgraph,
  layoutSwimlanes,
  SUBGRAPH_EDGE_LEVELS,
  subgraphEdgeKind,
  SWIMLANE_METRICS,
  type SubgraphEdgeKind,
  type SubgraphEdgeLevel,
  type SubgraphLayoutMode,
  type SwimlaneId,
} from './subgraph-model';

type SubNode = IncidentSubgraph['nodes'][number];

interface NeighborSummary {
  upstream: string[];
  downstream: string[];
}

type LaneNodeData = {
  lane: SwimlaneId;
  code: string;
  title: string;
  count: number;
};

type SubData =
  | {
      n: SubNode;
      group?: undefined;
      lane: SwimlaneId;
      laneCode: string;
      laneTitle: string;
      roleText: string;
      alertsText: string;
      onCriticalPath: boolean;
      hasCriticalPath: boolean;
      changed: boolean;
      ontologyTitle: string;
      ontologyDesc: string;
      neighbors: NeighborSummary;
    }
  | {
      group: FoldGroup;
      n?: undefined;
      lane: SwimlaneId;
      laneCode: string;
      laneTitle: string;
      countText: string;
      onCriticalPath: boolean;
      hasCriticalPath: boolean;
      changed: boolean;
      ontologyTitle: string;
      ontologyDesc: string;
      neighbors: NeighborSummary;
    };

type SubgraphFlowNode = Node<SubData, 'component'> | Node<LaneNodeData, 'lane'>;

const EDGE_CLASS: Partial<Record<SubgraphEdgeKind, string>> = {
  declared: styles.edgeDeclared,
  route: styles.edgeRoute,
  substrate: styles.edgeSubstrate,
  runtime: styles.edgeRuntime,
  allowed: styles.edgeAllowed,
};

const LEGEND_EDGE_KINDS: readonly SubgraphEdgeKind[] = ['declared', 'route', 'substrate', 'runtime', 'allowed'];
const SIDES = [Position.Top, Position.Bottom, Position.Left, Position.Right] as const;

const LANE_CODE: Record<SwimlaneId, string> = {
  L0: 'L0',
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  external: 'EXT',
};

// 节点的外框尺寸，与 Subgraph.module.css 的 .node 及 SWIMLANE_METRICS 一致
const NODE_W = SWIMLANE_METRICS.nodeW;
const NODE_H = SWIMLANE_METRICS.nodeH;
export { MINIMAP_MIN_NODES };

function LaneBandNode({ data }: NodeProps<Node<LaneNodeData, 'lane'>>) {
  return (
    <div className={styles.lane} data-lane={data.lane} aria-hidden="true">
      <div className={styles.laneHeader}>
        <div className={styles.laneCode}>
          <span>{data.code}</span>
          <span className={styles.laneCount}>{data.count}</span>
        </div>
        <div className={styles.laneTitle}>{data.title}</div>
      </div>
    </div>
  );
}

function summarizeList(items: readonly string[]): string {
  if (items.length <= 3) {
    return items.join('、');
  }
  return `${items.slice(0, 3).join('、')} +${items.length - 3}`;
}

function ComponentNode({ id, data }: NodeProps<Node<SubData, 'component'>>) {
  const { t } = useI18n();
  const names = useComponentNames();
  const view = useCanvasView();
  const container = usePortalContainer();
  const l = data.group
    ? { name: data.group.kind, sub: [data.countText, data.group.namespace].filter(Boolean).join(' · '), title: '' }
    : { ...componentLabel(data.n.component, names), title: displayComponent(data.n.component) };

  const pathDim = data.hasCriticalPath && !data.onCriticalPath && view.lit === null;
  const roleTone = data.group
    ? undefined
    : data.n.role === 'root'
      ? 'bad'
      : data.n.role === 'candidate'
        ? 'warn'
        : data.n.role === 'member'
          ? 'info'
          : data.n.alerts.length === 0
            ? 'ok'
            : 'bad';

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div
          className={styles.node}
          data-role={data.group ? 'neighbor' : data.n.role}
          data-lane={data.lane}
          data-substrate={!data.group && data.n.kind === 'Node' ? '' : undefined}
          data-fold={data.group ? '' : undefined}
          data-critical-path={data.onCriticalPath ? '' : undefined}
          data-path-dim={pathDim ? '' : undefined}
          {...viewAttrs(view, id)}
        >
          {SIDES.map((side) => (
            <Handle key={`t${side}`} id={`t${side}`} type="target" position={side} className={styles.handle} />
          ))}
          <div className={styles.headRow}>
            <div className={styles.name} title={l.title || undefined}>
              {l.name}
            </div>
            <span className={styles.layerTag}>{data.laneCode}</span>
          </div>
          <div className={styles.capsules}>
            {data.group ? (
              <span className={styles.capsule}>{data.countText}</span>
            ) : (
              <>
                <span className={styles.capsule} data-tone={roleTone}>
                  {data.n.role === 'neighbor' && data.n.alerts.length === 0
                    ? t('subgraph.capsule.healthy')
                    : data.roleText}
                </span>
                {data.n.alerts.length > 0 && (
                  <span className={styles.capsule} data-tone="bad">
                    {data.alertsText}
                  </span>
                )}
                {data.changed && (
                  <span className={styles.capsule} data-tone="warn">
                    ◆ {t('subgraph.capsule.changed')}
                  </span>
                )}
              </>
            )}
          </div>
          <div className={styles.sub}>{l.sub}</div>
          {SIDES.map((side) => (
            <Handle key={`s${side}`} id={`s${side}`} type="source" position={side} className={styles.handle} />
          ))}
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Content className={styles.ontologyTip} side="right" sideOffset={10} collisionPadding={12}>
          <div className={styles.tipHead}>
            <span className={styles.tipTitle}>{data.ontologyTitle}</span>
            <span className={styles.tipBadge}>
              {data.laneCode} · {data.laneTitle}
            </span>
            {!data.group && <span className={styles.tipBadge}>{data.roleText}</span>}
          </div>
          <p className={styles.tipDesc}>{data.ontologyDesc}</p>
          {(data.neighbors.upstream.length > 0 || data.neighbors.downstream.length > 0) && (
            <div className={styles.tipRel}>
              {data.neighbors.upstream.length > 0 && (
                <span>
                  {t('subgraph.tooltip.upstream')}: {summarizeList(data.neighbors.upstream)}
                </span>
              )}
              {data.neighbors.downstream.length > 0 && (
                <span>
                  {t('subgraph.tooltip.downstream')}: {summarizeList(data.neighbors.downstream)}
                </span>
              )}
            </div>
          )}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const nodeTypes = { component: ComponentNode, lane: LaneBandNode };

/** elkjs 分层布局，返回每个节点的左上角坐标。 */
export async function layoutSubgraph(g: {
  ids: readonly string[];
  edges: readonly { from: string; to: string }[];
}): Promise<Map<string, { x: number; y: number }>> {
  const elk = await loadElk();
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '16',
      'elk.layered.spacing.nodeNodeBetweenLayers': '48',
    },
    children: g.ids.map((id) => ({ id, width: NODE_W, height: NODE_H })),
    edges: g.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  });
  const out = new Map<string, { x: number; y: number }>();
  for (const c of res.children ?? []) {
    out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }
  return out;
}

function edgeHandles(
  mode: SubgraphLayoutMode,
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number } | undefined,
) {
  if (mode === 'elk' || !a || !b) {
    return { sourceHandle: `s${Position.Right}`, targetHandle: `t${Position.Left}` };
  }
  const dy = b.y - a.y;
  const dx = b.x - a.x;
  if (Math.abs(dy) >= 24) {
    return dy > 0
      ? { sourceHandle: `s${Position.Bottom}`, targetHandle: `t${Position.Top}` }
      : { sourceHandle: `s${Position.Top}`, targetHandle: `t${Position.Bottom}` };
  }
  return dx >= 0
    ? { sourceHandle: `s${Position.Right}`, targetHandle: `t${Position.Left}` }
    : { sourceHandle: `s${Position.Left}`, targetHandle: `t${Position.Right}` };
}

export interface SubgraphProps {
  graph: IncidentSubgraph;
  /** 侧栏链接所属的集群；不提供时侧栏不显示邻域与搜索链接 */
  clusterId?: string;
  /** 侧栏里告警的显示文字（例如告警名）；不提供时显示 alert_id */
  alertLabel?: (alertId: string) => string;
  /** 双击节点：宿主打开以该组件为中心的拓扑邻域 */
  onOpenComponent?: (component: string) => void;
  /** 画布是页面的主要内容（拓扑页的邻域图）：画布占满视口剩余的高度，普通滚轮直接缩放 */
  primary?: boolean;
  /** 可选：最近发生过变更的组件键集合，用于在节点上渲染变更胶囊 */
  changedComponents?: ReadonlySet<string>;
  /** 可选：本体词汇表（不传时自动经 DataPort 拉取，缺省时优雅降级） */
  glossary?: OntologyGlossary | null;
  /** 可选：初始布局模式，默认五层垂直因果泳道（swimlane） */
  defaultLayout?: SubgraphLayoutMode;
}

export function Subgraph(props: SubgraphProps) {
  const { graph, changedComponents, defaultLayout = 'swimlane' } = props;
  const { t, fmt, locale } = useI18n();
  const names = useComponentNames();
  const glossaryQuery = useOntologyGlossary(props.glossary === undefined);
  const glossary = props.glossary !== undefined ? props.glossary : (glossaryQuery.data ?? null);
  const lang = locale === 'en' ? 'en' : 'zh-CN';

  const graphKey = `${graph.root ?? ''}\0${graph.topology_version}`;
  const defaultLevel = useMemo(() => defaultSubgraphLevel(graph), [graph]);
  const [prevKey, setPrevKey] = useState(graphKey);
  const [pickedLevel, setPickedLevel] = useState<SubgraphEdgeLevel | null>(null);
  const [layoutMode, setLayoutMode] = useState<SubgraphLayoutMode>(defaultLayout);
  const [fold, setFold] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (prevKey !== graphKey) {
    setPrevKey(graphKey);
    setPickedLevel(null);
    setExpanded(new Set());
  }
  const level = pickedLevel ?? defaultLevel;
  const filtered = useMemo(() => filterSubgraph(graph, level), [graph, level]);
  const folded = useMemo(() => foldSubgraph(filtered.graph, expanded), [filtered.graph, expanded]);
  const drawn = useMemo(
    () => (fold ? folded : { nodes: filtered.graph.nodes, groups: [], edges: filtered.graph.edges }),
    [fold, folded, filtered.graph],
  );
  const critical = useMemo(() => computeCriticalCausalPath(filtered.graph), [filtered.graph]);

  // 合并组映射到画布节点 id，确保折叠后的关键路径与上下游摘要一致
  const displayNameOf = useCallback(
    (id: string) => {
      const grp = drawn.groups.find((g) => g.id === id);
      if (grp) {
        return `${grp.kind} × ${grp.members.length}`;
      }
      return componentLabel(id, names).name;
    },
    [drawn.groups, names],
  );

  const items = useMemo(() => {
    const up = new Map<string, Set<string>>();
    const down = new Map<string, Set<string>>();
    for (const e of drawn.edges) {
      down.set(e.from, (down.get(e.from) ?? new Set()).add(displayNameOf(e.to)));
      up.set(e.to, (up.get(e.to) ?? new Set()).add(displayNameOf(e.from)));
    }
    const nodeItems = drawn.nodes.map((n) => {
      const lane = classifySwimlane(n, glossary);
      const onto = lookupNodeOntology(n, glossary, lang);
      const onCriticalPath = critical.hasPath && critical.nodes.has(n.component);
      const priority = n.role === 'root' ? 0 : onCriticalPath || n.role !== 'neighbor' ? 1 : 2;
      return {
        id: n.component,
        lane,
        priority,
        label: componentLabel(n.component, names).name,
        data: {
          n,
          lane,
          laneCode: LANE_CODE[lane],
          laneTitle: t(`subgraph.lane.${lane}`),
          roleText: t(`subgraph.role.${n.role}`),
          alertsText: t('subgraph.alerts', { n: n.alerts.length }),
          onCriticalPath,
          hasCriticalPath: critical.hasPath,
          changed: Boolean(changedComponents?.has(n.component)),
          ontologyTitle: onto.title,
          ontologyDesc: onto.description,
          neighbors: {
            upstream: [...(up.get(n.component) ?? [])],
            downstream: [...(down.get(n.component) ?? [])],
          },
        } satisfies SubData,
      };
    });
    const groupItems = drawn.groups.map((group) => {
      const first = group.members[0]!;
      const lane = classifySwimlane(first, glossary);
      const onto = lookupNodeOntology(first, glossary, lang);
      const onCriticalPath = critical.hasPath && group.members.some((m) => critical.nodes.has(m.component));
      return {
        id: group.id,
        lane,
        priority: 2,
        label: group.kind,
        data: {
          group,
          lane,
          laneCode: LANE_CODE[lane],
          laneTitle: t(`subgraph.lane.${lane}`),
          countText: t('subgraph.fold_count', { n: group.members.length }),
          onCriticalPath,
          hasCriticalPath: critical.hasPath,
          changed: group.members.some((m) => Boolean(changedComponents?.has(m.component))),
          ontologyTitle: `${group.kind} × ${group.members.length}`,
          ontologyDesc: onto.description,
          neighbors: {
            upstream: [...(up.get(group.id) ?? [])],
            downstream: [...(down.get(group.id) ?? [])],
          },
        } satisfies SubData,
      };
    });
    return [...nodeItems, ...groupItems];
  }, [drawn, glossary, lang, critical, names, t, changedComponents, displayNameOf]);

  const buildEdges = useCallback(
    (positions: ReadonlyMap<string, { x: number; y: number }>, mode: SubgraphLayoutMode): CanvasEdge[] => {
      const groupMembers = new Map<string, readonly string[]>(
        drawn.groups.map((g) => [g.id, g.members.map((m) => m.component)]),
      );
      return drawn.edges.map((e, i) => {
        const kind = subgraphEdgeKind(e);
        const fromIds = groupMembers.get(e.from) ?? [e.from];
        const toIds = groupMembers.get(e.to) ?? [e.to];
        const isCrit =
          critical.hasPath &&
          fromIds.some((from) =>
            toIds.some((to) => critical.edges.has(criticalEdgeKey({ from, to, relation: e.relation }))),
          );
        const handles = edgeHandles(mode, positions.get(e.from), positions.get(e.to));
        return {
          id: `e${i}`,
          source: e.from,
          target: e.to,
          ...handles,
          className: [
            EDGE_CLASS[kind],
            isCrit ? styles.edgeCritical : critical.hasPath ? styles.edgeSecondary : undefined,
          ]
            .filter(Boolean)
            .join(' '),
          zIndex: isCrit ? 2 : 0,
          data: {
            text: `${e.relation} · ${t(`subgraph.source.${e.provenance}`)} ${fmt.number(e.confidence, 1)}`,
            weak: !isCrit && e.confidence < 0.6 && kind !== 'allowed',
          },
        };
      });
    },
    [drawn.edges, drawn.groups, critical, t, fmt],
  );

  // 泳道布局是纯同步确定的，首帧即可渲染（零闪烁）；ELK 布局保持异步计算，计算期间复用泳道帧避免画布卸载闪烁
  const swimlaneLaid = useMemo<{ nodes: SubgraphFlowNode[]; edges: CanvasEdge[] }>(() => {
    const { positions, lanes } = layoutSwimlanes(
      items.map((it) => ({ id: it.id, lane: it.lane, priority: it.priority, label: it.label })),
      drawn.edges,
    );
    const laneNodes: SubgraphFlowNode[] = lanes.map((band) => ({
      id: `lane:${band.id}`,
      type: 'lane',
      position: { x: band.x, y: band.y },
      width: band.w,
      height: band.h,
      draggable: false,
      selectable: false,
      style: { width: band.w, height: band.h, pointerEvents: 'none' },
      zIndex: -2,
      data: {
        lane: band.id,
        code: LANE_CODE[band.id],
        title: t(`subgraph.lane.${band.id}`),
        count: band.count,
      },
    }));
    const compNodes: SubgraphFlowNode[] = items.map(({ id, data }) => {
      const p = positions.get(id)!;
      return { id, type: 'component', position: p, width: NODE_W, height: NODE_H, data, draggable: false };
    });
    return {
      nodes: [...laneNodes, ...compNodes],
      edges: buildEdges(positions, 'swimlane'),
    };
  }, [items, drawn.edges, t, buildEdges]);

  const [elkLaid, setElkLaid] = useState<{ nodes: SubgraphFlowNode[]; edges: CanvasEdge[] } | null>(null);
  useEffect(() => {
    if (layoutMode !== 'elk') {
      return;
    }
    let live = true;
    layoutSubgraph({ ids: items.map((i) => i.id), edges: drawn.edges }).then((pos) => {
      if (!live) {
        return;
      }
      setElkLaid({
        nodes: items.map(({ id, data }) => {
          const p = pos.get(id);
          if (!p) {
            throw new Error(`布局缺少节点 ${id}`);
          }
          return { id, type: 'component', position: p, width: NODE_W, height: NODE_H, data, draggable: false };
        }),
        edges: buildEdges(pos, 'elk'),
      });
    });
    return () => {
      live = false;
    };
  }, [layoutMode, items, drawn.edges, buildEdges]);

  const laid = layoutMode === 'elk' ? (elkLaid ?? swimlaneLaid) : swimlaneLaid;

  if (!graph.nodes.length) {
    return <EmptyState kind="none" title={t('subgraph.empty_title')} because={t('subgraph.empty_because')} />;
  }
  return (
    <Tooltip.Provider delayDuration={180}>
      <div className={layoutMode === 'swimlane' && !props.primary ? styles.swimlaneWrap : undefined}>
        <ReactFlowProvider>
          <SubgraphCanvas
            {...props}
            nodes={laid.nodes}
            edges={laid.edges}
            layoutMode={layoutMode}
            onLayoutMode={setLayoutMode}
            hasCriticalPath={critical.hasPath}
            level={level}
            onLevel={(next) => {
              setPickedLevel(next);
              setExpanded(new Set());
            }}
            hiddenEdges={filtered.hiddenEdges}
            visibleKinds={filtered.kinds}
            fold={folded.foldable > 0 ? fold : null}
            onFold={() => {
              setFold(!fold);
              setExpanded(new Set());
            }}
            onExpand={(id) => setExpanded(new Set([...expanded, id]))}
          />
        </ReactFlowProvider>
      </div>
    </Tooltip.Provider>
  );
}

function SubgraphCanvas({
  graph,
  clusterId,
  alertLabel,
  onOpenComponent,
  primary = false,
  nodes,
  edges,
  layoutMode,
  onLayoutMode,
  hasCriticalPath,
  level,
  onLevel,
  hiddenEdges,
  visibleKinds,
  fold,
  onFold,
  onExpand,
}: SubgraphProps & {
  nodes: SubgraphFlowNode[];
  edges: CanvasEdge[];
  layoutMode: SubgraphLayoutMode;
  onLayoutMode: (m: SubgraphLayoutMode) => void;
  hasCriticalPath: boolean;
  level: SubgraphEdgeLevel;
  onLevel: (level: SubgraphEdgeLevel) => void;
  hiddenEdges: number;
  visibleKinds: ReadonlySet<SubgraphEdgeKind>;
  /** 同类合并是否打开；null 表示这张图没有可以合并的组件，不显示开关 */
  fold: boolean | null;
  onFold: () => void;
  onExpand: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const names = useComponentNames();
  const interactive = useCallback((n: SubgraphFlowNode) => n.type === 'component', []);
  const nameKey = nodes
    .filter((n): n is Node<SubData, 'component'> => n.type === 'component')
    .map((n) => (n.data.group ? '' : componentLabel(n.id, names).name))
    .join('\0');
  const ariaLabel = useCallback(
    (n: SubgraphFlowNode) => {
      if (n.type === 'lane') {
        return `${n.data.code} ${n.data.title}`;
      }
      return n.data.group
        ? t('subgraph.fold_label', { kind: n.data.group.kind, n: n.data.group.members.length })
        : t('subgraph.node_label', {
            name: componentLabel(n.id, names).name,
            role: n.data.roleText,
            alerts: n.data.alertsText,
          });
    },
    [t, nameKey],
  );
  const findText = useCallback(
    (n: SubgraphFlowNode) => {
      if (n.type === 'lane') {
        return null;
      }
      return (
        n.data.group
          ? [n.data.group.kind, ...n.data.group.members.map((m) => m.component)]
          : [componentLabel(n.id, names).name, n.id]
      ).join('\n');
    },
    [nameKey],
  );
  const legendKinds = LEGEND_EDGE_KINDS.filter((k) => visibleKinds.has(k));
  const hasSubstrateNode = nodes.some((n) => n.type === 'component' && !n.data.group && n.data.n.kind === 'Node');
  return (
    <GraphCanvas
      label={t('subgraph.label', { n: graph.nodes.length, e: graph.edges.length })}
      hint={t('subgraph.hint')}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      interactive={interactive}
      ariaLabel={ariaLabel}
      findText={findText}
      showFind={graph.nodes.length > MINIMAP_MIN_NODES}
      primary={primary}
      onOpen={(n) => {
        if (n.type !== 'component') {
          return;
        }
        if (n.data.group) {
          onExpand(n.id);
        } else {
          onOpenComponent?.(n.id);
        }
      }}
      tools={
        <>
          <span role="group" aria-label={t('subgraph.layout_mode')} className={styles.levels}>
            {(['swimlane', 'elk'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={canvasStyles.tool}
                aria-pressed={layoutMode === m}
                onClick={() => onLayoutMode(m)}
              >
                {t(`subgraph.layout.${m}`)}
              </button>
            ))}
          </span>
          {graph.edges.length > 0 && (
            <span role="group" aria-label={t('subgraph.edges_level')} className={styles.levels}>
              {SUBGRAPH_EDGE_LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={canvasStyles.tool}
                  aria-pressed={level === l}
                  title={t(`subgraph.level_hint.${l}`)}
                  onClick={() => onLevel(l)}
                >
                  {t(`subgraph.level.${l}`)}
                </button>
              ))}
            </span>
          )}
          {hiddenEdges > 0 && (
            <button
              type="button"
              className={styles.hiddenBadge}
              title={t('subgraph.hidden_edges_hint')}
              onClick={() => onLevel('allowed')}
            >
              {t('subgraph.hidden_edges', { n: hiddenEdges })}
            </button>
          )}
          {fold !== null && (
            <button type="button" className={canvasStyles.tool} aria-pressed={fold} onClick={onFold}>
              {t('subgraph.fold')}
            </button>
          )}
        </>
      }
      footer={
        (legendKinds.length > 0 || hasSubstrateNode || hasCriticalPath) && (
          <div className={styles.legend} aria-hidden="true">
            {hasCriticalPath && (
              <span>
                <svg className={styles.legendEdge} data-kind="critical" viewBox="0 0 22 6" width="22" height="6">
                  <line x1="0" y1="3" x2="22" y2="3" />
                </svg>
                {t('subgraph.critical_path')}
              </span>
            )}
            {legendKinds.map((k) => (
              <span key={k}>
                <svg className={styles.legendEdge} data-kind={k} viewBox="0 0 22 6" width="22" height="6">
                  <line x1="0" y1="3" x2="22" y2="3" />
                </svg>
                {t(`subgraph.edge_kind.${k}`)}
              </span>
            ))}
            {hasSubstrateNode && (
              <span>
                <i className={styles.legendSubstrate} />
                {t('subgraph.substrate_host')}
              </span>
            )}
          </div>
        )
      }
      panel={(n, close) =>
        n.type !== 'component' ? null : n.data.group ? (
          <GroupPanel key={n.id} group={n.data.group} clusterId={clusterId} onExpand={onExpand} onClose={close} />
        ) : (
          <ComponentPanel key={n.id} data={n.data} clusterId={clusterId} alertLabel={alertLabel} onClose={close} />
        )
      }
    />
  );
}

/** 组件侧栏：显示名与键、泳道层级、本体说明、角色、上下游、成员告警，以及打开邻域、搜索事件的链接 */
function ComponentPanel({
  data,
  clusterId,
  alertLabel,
  onClose,
}: {
  data: Extract<SubData, { n: SubNode }>;
  clusterId?: string;
  alertLabel?: (alertId: string) => string;
  onClose: () => void;
}) {
  const { n } = data;
  const { t } = useI18n();
  const { links } = useUiEnv();
  const names = useComponentNames();
  const l = componentLabel(n.component, names);
  const topologyHref = clusterId && links.topology ? links.topology(clusterId, n.component) : null;
  const searchHref = clusterId && links.search ? links.search(n.component, clusterId) : null;
  return (
    <SidePanel title={l.name} onClose={onClose}>
      <Mono className={canvasStyles.key}>{n.component}</Mono>
      <p className={styles.panelOntology}>{data.ontologyDesc}</p>
      <dl className={canvasStyles.facts}>
        <dt>{t('subgraph.panel.layer')}</dt>
        <dd>
          {data.laneCode} · {data.laneTitle}
        </dd>
        <dt>{t('subgraph.panel.role')}</dt>
        <dd data-role={n.role}>{t(`subgraph.role.${n.role}`)}</dd>
        <dt>{t('subgraph.panel.kind')}</dt>
        <dd>{l.sub}</dd>
        <dt>{t('subgraph.panel.hops')}</dt>
        <dd>{t('subgraph.panel.hops_n', { n: n.hops })}</dd>
        {data.neighbors.upstream.length > 0 && (
          <>
            <dt>{t('subgraph.tooltip.upstream')}</dt>
            <dd>{data.neighbors.upstream.join('、')}</dd>
          </>
        )}
        {data.neighbors.downstream.length > 0 && (
          <>
            <dt>{t('subgraph.tooltip.downstream')}</dt>
            <dd>{data.neighbors.downstream.join('、')}</dd>
          </>
        )}
      </dl>
      <h4 className={canvasStyles.panelSub}>{t('subgraph.alerts', { n: n.alerts.length })}</h4>
      {n.alerts.length ? (
        <ul className={canvasStyles.alerts}>
          {n.alerts.map((a) => (
            <li key={a} title={a}>
              {alertLabel ? alertLabel(a) : a}
            </li>
          ))}
        </ul>
      ) : (
        <p className={canvasStyles.none}>{t('subgraph.panel.no_alerts')}</p>
      )}
      {(topologyHref || searchHref) && (
        <nav className={canvasStyles.panelLinks} aria-label={t('subgraph.panel.links')}>
          {topologyHref && (
            <AppLink href={topologyHref} className={canvasStyles.link}>
              {t('subgraph.panel.open_neighborhood')}
            </AppLink>
          )}
          {searchHref && (
            <AppLink href={searchHref} className={canvasStyles.link}>
              {t('subgraph.panel.search_incidents')}
            </AppLink>
          )}
        </nav>
      )}
    </SidePanel>
  );
}

/** 合并组的侧栏：成员列表（宿主有拓扑页时每个成员链接到它的邻域）与展开按钮 */
function GroupPanel({
  group,
  clusterId,
  onExpand,
  onClose,
}: {
  group: FoldGroup;
  clusterId?: string;
  onExpand: (groupId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { links } = useUiEnv();
  const names = useComponentNames();
  const { topology } = links;
  return (
    <SidePanel title={`${group.kind} × ${group.members.length}`} onClose={onClose}>
      <p className={canvasStyles.none}>{t('subgraph.fold_because')}</p>
      <dl className={canvasStyles.facts}>
        {group.namespace && (
          <>
            <dt>{t('subgraph.panel.namespace')}</dt>
            <dd>{group.namespace}</dd>
          </>
        )}
        <dt>{t('subgraph.panel.hops')}</dt>
        <dd>{t('subgraph.panel.hops_n', { n: group.hops })}</dd>
      </dl>
      <button type="button" className={canvasStyles.tool} onClick={() => onExpand(group.id)}>
        {t('subgraph.fold_expand')}
      </button>
      <ul className={canvasStyles.alerts}>
        {group.members.map((m) => {
          const name = componentLabel(m.component, names).name;
          return (
            <li key={m.component} title={m.component}>
              {topology && clusterId ? (
                <AppLink href={topology(clusterId, m.component)} className={canvasStyles.link}>
                  {name}
                </AppLink>
              ) : (
                name
              )}
            </li>
          );
        })}
      </ul>
    </SidePanel>
  );
}
