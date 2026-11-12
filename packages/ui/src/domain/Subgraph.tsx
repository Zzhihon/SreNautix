// 根因子图（DESIGN §12.2、§12.5、ADR 0191、ADR 0197）：只画根因加不超过 2 跳的邻居，用 elkjs 的分层布局，每条边标注来源与置信度。
// 缩放、全屏、突出、查找与侧栏的交互在 GraphCanvas；这里是组件节点、同类合并（subgraph-fold.ts）与组件侧栏。
// 双击组件交给宿主打开以它为中心的邻域（onOpenComponent），双击合并的组在图上展开它。

import { Handle, Position, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IncidentSubgraph } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Loading, Mono } from '../primitives/basic';
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
import styles from './Subgraph.module.css';
import { useComponentNames } from './names';
import { foldSubgraph, type FoldGroup } from './subgraph-fold';

type SubNode = IncidentSubgraph['nodes'][number];
type SubData =
  | { n: SubNode; group?: undefined; roleText: string; alertsText: string }
  | { group: FoldGroup; n?: undefined; countText: string };

// 节点的外框尺寸，与 Subgraph.module.css 的 .node 相同；布局、小地图与查找定位都用它
const NODE_W = 204;
const NODE_H = 68;
export { MINIMAP_MIN_NODES };

function ComponentNode({ id, data }: NodeProps<Node<SubData>>) {
  const names = useComponentNames();
  const view = useCanvasView();
  const l = data.group
    ? { name: data.group.kind, sub: [data.countText, data.group.namespace].filter(Boolean).join(' · '), title: '' }
    : { ...componentLabel(data.n.component, names), title: displayComponent(data.n.component) };
  return (
    <div
      className={styles.node}
      data-role={data.group ? 'neighbor' : data.n.role}
      data-fold={data.group ? '' : undefined}
      {...viewAttrs(view, id)}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.name} title={l.title || undefined}>
        {l.name}
      </div>
      <div className={styles.sub}>
        {data.group ? (
          l.sub
        ) : (
          <>
            {data.roleText} · {l.sub}
            {data.n.alerts.length > 0 && ` · ${data.alertsText}`}
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
}

const nodeTypes = { component: ComponentNode };

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
}

export function Subgraph(props: SubgraphProps) {
  const { graph } = props;
  const { t, fmt } = useI18n();
  const [fold, setFold] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const folded = useMemo(() => foldSubgraph(graph, expanded), [graph, expanded]);
  const drawn = useMemo(
    () => (fold ? folded : { nodes: graph.nodes, groups: [], edges: graph.edges }),
    [fold, folded, graph],
  );
  const [laid, setLaid] = useState<{ nodes: Node<SubData>[]; edges: CanvasEdge[] } | null>(null);
  useEffect(() => {
    let live = true;
    const items: { id: string; data: SubData }[] = [
      ...drawn.nodes.map((n) => ({
        id: n.component,
        data: { n, roleText: t(`subgraph.role.${n.role}`), alertsText: t('subgraph.alerts', { n: n.alerts.length }) },
      })),
      ...drawn.groups.map((group) => ({
        id: group.id,
        data: { group, countText: t('subgraph.fold_count', { n: group.members.length }) },
      })),
    ];
    layoutSubgraph({ ids: items.map((i) => i.id), edges: drawn.edges }).then((pos) => {
      if (!live) {
        return;
      }
      setLaid({
        nodes: items.map(({ id, data }) => {
          const p = pos.get(id);
          if (!p) {
            throw new Error(`布局缺少节点 ${id}`);
          }
          // 写明宽高：小地图只画有尺寸的节点，而这里的节点不经 onNodesChange 回写测量结果
          return { id, type: 'component', position: p, width: NODE_W, height: NODE_H, data, draggable: false };
        }),
        edges: drawn.edges.map((e, i) => ({
          id: `e${i}`,
          source: e.from,
          target: e.to,
          data: {
            text: `${e.relation} · ${t(`subgraph.source.${e.provenance}`)} ${fmt.number(e.confidence, 1)}`,
            weak: e.confidence < 0.6,
          },
        })),
      });
    });
    return () => {
      live = false;
    };
  }, [drawn, t, fmt]);
  if (!graph.nodes.length) {
    return <EmptyState kind="none" title={t('subgraph.empty_title')} because={t('subgraph.empty_because')} />;
  }
  if (!laid) {
    return <Loading />;
  }
  return (
    <ReactFlowProvider>
      <SubgraphCanvas
        {...props}
        nodes={laid.nodes}
        edges={laid.edges}
        fold={folded.foldable > 0 ? fold : null}
        onFold={() => {
          setFold(!fold);
          setExpanded(new Set());
        }}
        onExpand={(id) => setExpanded(new Set([...expanded, id]))}
      />
    </ReactFlowProvider>
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
  fold,
  onFold,
  onExpand,
}: SubgraphProps & {
  nodes: Node<SubData>[];
  edges: CanvasEdge[];
  /** 同类合并是否打开；null 表示这张图没有可以合并的组件，不显示开关 */
  fold: boolean | null;
  onFold: () => void;
  onExpand: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const names = useComponentNames();
  // 节点的可访问名称与查找文字随可读名称变化，按取值比较，节点数组本身不换新（ADR 0191 §7）
  const nameKey = nodes.map((n) => (n.data.group ? '' : componentLabel(n.id, names).name)).join('\0');
  const ariaLabel = useCallback(
    (n: Node<SubData>) =>
      n.data.group
        ? t('subgraph.fold_label', { kind: n.data.group.kind, n: n.data.group.members.length })
        : t('subgraph.node_label', {
            name: componentLabel(n.id, names).name,
            role: n.data.roleText,
            alerts: n.data.alertsText,
          }),
    // names 每次渲染都是新对象，按取值 nameKey 比较
    [t, nameKey],
  );
  // 查找：按显示名与组件键匹配，合并的组按成员匹配
  const findText = useCallback(
    (n: Node<SubData>) =>
      (n.data.group
        ? [n.data.group.kind, ...n.data.group.members.map((m) => m.component)]
        : [componentLabel(n.id, names).name, n.id]
      ).join('\n'),
    [nameKey],
  );
  return (
    <GraphCanvas
      label={t('subgraph.label', { n: graph.nodes.length, e: graph.edges.length })}
      hint={t('subgraph.hint')}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      ariaLabel={ariaLabel}
      findText={findText}
      showFind={graph.nodes.length > MINIMAP_MIN_NODES}
      primary={primary}
      onOpen={(n) => (n.data.group ? onExpand(n.id) : onOpenComponent?.(n.id))}
      tools={
        fold !== null && (
          <button type="button" className={canvasStyles.tool} aria-pressed={fold} onClick={onFold}>
            {t('subgraph.fold')}
          </button>
        )
      }
      panel={(n, close) =>
        n.data.group ? (
          <GroupPanel key={n.id} group={n.data.group} clusterId={clusterId} onExpand={onExpand} onClose={close} />
        ) : (
          <ComponentPanel key={n.id} n={n.data.n} clusterId={clusterId} alertLabel={alertLabel} onClose={close} />
        )
      }
    />
  );
}

/** 组件侧栏：显示名与键、角色、成员告警，以及打开邻域、搜索事件的链接 */
function ComponentPanel({
  n,
  clusterId,
  alertLabel,
  onClose,
}: {
  n: SubNode;
  clusterId?: string;
  alertLabel?: (alertId: string) => string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { links } = useUiEnv();
  const names = useComponentNames();
  const l = componentLabel(n.component, names);
  const topologyHref = clusterId && links.topology ? links.topology(clusterId, n.component) : null;
  const searchHref = clusterId && links.search ? links.search(n.component, clusterId) : null;
  return (
    <SidePanel title={l.name} onClose={onClose}>
      <Mono className={canvasStyles.key}>{n.component}</Mono>
      <dl className={canvasStyles.facts}>
        <dt>{t('subgraph.panel.role')}</dt>
        <dd data-role={n.role}>{t(`subgraph.role.${n.role}`)}</dd>
        <dt>{t('subgraph.panel.kind')}</dt>
        <dd>{l.sub}</dd>
        <dt>{t('subgraph.panel.hops')}</dt>
        <dd>{t('subgraph.panel.hops_n', { n: n.hops })}</dd>
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
