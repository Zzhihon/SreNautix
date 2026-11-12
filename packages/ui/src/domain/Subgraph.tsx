// 根因子图（DESIGN §12.2、§12.5、ADR 0191、ADR 0197）：只画根因加不超过 2 跳的邻居，用 elkjs 的分层布局，每条边标注来源与置信度。
// 节点位置固定不能拖动；画布可以拖动平移，用按钮、触控板双指捏合或 Ctrl/⌘ + 滚轮缩放，可以全屏。
// 画布是页面主要内容（primary）或全屏时普通滚轮直接缩放；嵌在长页面里时普通滚轮滚动页面，并提示按住 Ctrl/⌘。
// 单击节点或在节点上按 Enter 打开组件侧栏，Esc 关闭；双击节点交给宿主打开以它为中心的邻域（onOpenComponent）。
// 组件多时：同类邻居合并成一个节点（subgraph-fold.ts），指向或选中一个节点只突出它和直接相连的组件，可以按名称查找。

import {
  Background,
  ControlButton,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useKeyPress,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ELK as ElkApi } from 'elkjs/lib/elk-api.js';
import { Maximize, Minimize, X } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent,
} from 'react';
import type { IncidentSubgraph } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Loading, Mono } from '../primitives/basic';
import { componentLabel, displayComponent } from './model';
import styles from './Subgraph.module.css';
import { useComponentNames } from './names';
import { foldSubgraph, type FoldGroup } from './subgraph-fold';

type SubNode = IncidentSubgraph['nodes'][number];
type SubData =
  | { n: SubNode; group?: undefined; roleText: string; alertsText: string }
  | { group: FoldGroup; n?: undefined; countText: string };
type SubEdge = Edge<{ text: string; weak: boolean }>;

// 节点的外框尺寸，与 Subgraph.module.css 的 .node 相同；布局、小地图与查找定位都用它
const NODE_W = 204;
const NODE_H = 68;
/** 画布上的节点数超过这个值时显示小地图，边的标注只在指向或选中的节点上显示 */
export const MINIMAP_MIN_NODES = 10;
/** 适配视图时最多放大到 2 倍：只有两三个节点的子图不会被撑满画布 */
const FIT = { padding: 0.1, maxZoom: 2 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

// elkjs 打包后约 1.5 MB，只有打开事件详情时才加载
let elkPromise: Promise<ElkApi> | null = null;
function loadElk(): Promise<ElkApi> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

interface View {
  /** 侧栏正在显示的节点 id */
  selectedId: string | null;
  /** 要突出的节点；null 表示全部正常显示，不在其中的节点变淡 */
  lit: ReadonlySet<string> | null;
  /** 查找命中的节点 */
  hits: ReadonlySet<string> | null;
}
const ViewContext = createContext<View>({ selectedId: null, lit: null, hits: null });

function ComponentNode({ id, data }: NodeProps<Node<SubData>>) {
  const names = useComponentNames();
  const view = useContext(ViewContext);
  const l = data.group
    ? { name: data.group.kind, sub: [data.countText, data.group.namespace].filter(Boolean).join(' · '), title: '' }
    : { ...componentLabel(data.n.component, names), title: displayComponent(data.n.component) };
  return (
    <div
      className={styles.node}
      data-role={data.group ? 'neighbor' : data.n.role}
      data-fold={data.group ? '' : undefined}
      data-selected={view.selectedId === id ? '' : undefined}
      data-dim={view.lit && !view.lit.has(id) ? '' : undefined}
      data-hit={view.hits?.has(id) ? '' : undefined}
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
  const [laid, setLaid] = useState<{ nodes: Node<SubData>[]; edges: SubEdge[] } | null>(null);
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
  edges: SubEdge[];
  /** 同类合并是否打开；null 表示这张图没有可以合并的组件，不显示开关 */
  fold: boolean | null;
  onFold: () => void;
  onExpand: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const { fitView, setCenter, getZoom } = useReactFlow();
  const frame = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hitAt, setHitAt] = useState(-1);
  const [fullscreen, setFullscreen] = useState(false);
  const [wheelHint, setWheelHint] = useState(false);
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(wheelTimer.current), []);
  // 没有页面可滚（全屏）或画布就是页面主要内容时，普通滚轮直接缩放
  const wheelZoom = primary || fullscreen;
  const dense = nodes.length > MINIMAP_MIN_NODES;
  // 侧栏关闭后焦点回到打开它的节点
  const opener = useRef<HTMLElement | null>(null);
  // 按住 ⌘ 时由画布接管滚轮做缩放；其余时候普通滚轮滚动页面，Ctrl + 滚轮与触控板捏合照常缩放
  const metaHeld = useKeyPress('Meta');
  const names = useComponentNames();
  // 合并或展开之后选中的节点可能已经不在画布上，这时侧栏收起
  const selected = nodes.find((n) => n.id === selectedId)?.data ?? null;
  // 节点对象换新时 xyflow 会重新测量并在测量前隐藏节点，聚焦的节点因此失去焦点：
  // 节点数组只随布局与可读名称的取值变化，选中、突出与查找命中经 context 传给节点
  const nameText = nodes.map((n) => (n.data.group ? n.data.group.kind : componentLabel(n.id, names).name));
  const nameKey = nameText.join('\0');
  const shown = useMemo(
    () =>
      nodes.map((n, i) => ({
        ...n,
        ariaLabel: n.data.group
          ? t('subgraph.fold_label', { kind: n.data.group.kind, n: n.data.group.members.length })
          : t('subgraph.node_label', { name: nameText[i], role: n.data.roleText, alerts: n.data.alertsText }),
      })),
    // nameText 每次渲染都是新数组，按取值 nameKey 比较
    [nodes, nameKey, t],
  );
  // 布局变了（合并、展开）之后重新适配视图；xyflow 等新节点量出尺寸后才执行
  const fitted = useRef(nodes);
  useEffect(() => {
    if (fitted.current !== nodes) {
      fitted.current = nodes;
      void fitView(FIT);
    }
  }, [nodes, fitView]);

  // 查找：按显示名与组件键匹配，合并的组按成员匹配
  const q = query.trim().toLowerCase();
  const hitList = useMemo(
    () =>
      q
        ? nodes.filter((n, i) =>
            (n.data.group ? [n.data.group.kind, ...n.data.group.members.map((m) => m.component)] : [nameText[i], n.id])
              .join('\n')
              .toLowerCase()
              .includes(q),
          )
        : null,
    [q, nodes, nameKey],
  );
  const hits = useMemo(() => hitList && new Set(hitList.map((n) => n.id)), [hitList]);
  const nextHit = () => {
    if (!hitList?.length) {
      return;
    }
    const at = (hitAt + 1) % hitList.length;
    const p = (hitList[at] as Node<SubData>).position;
    setHitAt(at);
    void setCenter(p.x + NODE_W / 2, p.y + NODE_H / 2, { zoom: Math.max(getZoom(), 1), duration: 200 });
  };

  // 突出：鼠标指向的节点优先，其次是查找命中，最后是侧栏里的节点
  const focusId = hoverId ?? (hits || !selected ? null : selectedId);
  const view = useMemo<View>(() => {
    if (focusId === null) {
      return { selectedId, lit: hits, hits };
    }
    const lit = new Set([focusId]);
    for (const e of edges) {
      if (e.source === focusId) {
        lit.add(e.target);
      } else if (e.target === focusId) {
        lit.add(e.source);
      }
    }
    return { selectedId, lit, hits };
  }, [selectedId, focusId, hits, edges]);
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const on = e.source === focusId || e.target === focusId;
        const dim = focusId !== null ? !on : hits !== null && !(hits.has(e.source) && hits.has(e.target));
        return {
          ...e,
          // 组件多时边的标注互相遮挡：只标出指向或选中的节点上的边
          label: !dense || on ? e.data?.text : undefined,
          className: [e.data?.weak && styles.weak, on && styles.on, dim && styles.dim].filter(Boolean).join(' '),
          zIndex: on ? 1 : 0,
        };
      }),
    [edges, focusId, hits, dense],
  );

  const open = (id: string, from: EventTarget | null) => {
    opener.current = from instanceof Element ? from.closest<HTMLElement>('.react-flow__node') : null;
    setSelectedId(id);
  };
  const close = () => {
    setSelectedId(null);
    opener.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && selectedId !== null) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Enter') {
      return;
    }
    const el = e.target instanceof Element ? e.target : null;
    const id = el?.classList.contains('react-flow__node') ? el.getAttribute('data-id') : null;
    if (el && id) {
      e.preventDefault();
      open(id, el);
    }
  };
  const onWheel = (e: WheelEvent) => {
    if (wheelZoom || e.ctrlKey || e.metaKey) {
      return;
    }
    setWheelHint(true);
    clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => setWheelHint(false), 1600);
  };

  return (
    <div
      className={styles.frame}
      ref={frame}
      data-open={selected ? '' : undefined}
      data-primary={primary ? '' : undefined}
      onKeyDown={onKeyDown}
    >
      <div
        className={styles.wrap}
        role="group"
        aria-label={t('subgraph.label', { n: graph.nodes.length, e: graph.edges.length })}
        aria-describedby={hintId}
        onWheel={onWheel}
      >
        <span id={hintId} className={styles.srOnly}>
          {t('subgraph.hint')}
        </span>
        <ViewContext.Provider value={view}>
          <ReactFlow
            nodes={shown}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={FIT}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            panOnScroll={false}
            zoomOnScroll={wheelZoom}
            zoomOnPinch
            zoomOnDoubleClick={false}
            zoomActivationKeyCode={['Meta', 'Control']}
            preventScrolling={wheelZoom || metaHeld}
            onNodeClick={(e: MouseEvent, n) => open(n.id, e.target)}
            onNodeDoubleClick={(_e: MouseEvent, n) => (n.data.group ? onExpand(n.id) : onOpenComponent?.(n.id))}
            onNodeMouseEnter={(_e: MouseEvent, n) => setHoverId(n.id)}
            onNodeMouseLeave={() => setHoverId(null)}
            ariaLabelConfig={{
              'node.a11yDescription.default': t('subgraph.node_hint'),
              'node.a11yDescription.keyboardDisabled': t('subgraph.node_hint'),
              'controls.ariaLabel': t('subgraph.controls'),
              'controls.zoomIn.ariaLabel': t('subgraph.zoom_in'),
              'controls.zoomOut.ariaLabel': t('subgraph.zoom_out'),
              'controls.fitView.ariaLabel': t('subgraph.fit_view'),
              'minimap.ariaLabel': t('subgraph.minimap'),
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT}>
              <FullscreenButton frame={frame} on={fullscreen} onChange={setFullscreen} />
            </Controls>
            {dense && <MiniMap pannable zoomable position="bottom-right" />}
            {(graph.nodes.length > MINIMAP_MIN_NODES || fold !== null) && (
              <Panel position="top-left" className={styles.tools}>
                {graph.nodes.length > MINIMAP_MIN_NODES && (
                  <>
                    <input
                      type="search"
                      className={styles.find}
                      value={query}
                      placeholder={t('subgraph.find')}
                      aria-label={t('subgraph.find')}
                      onChange={(e) => {
                        setQuery(e.currentTarget.value);
                        setHitAt(-1);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          nextHit();
                        } else if (e.key === 'Escape' && query) {
                          // 先清空查找；侧栏留到下一次 Esc 再关
                          e.stopPropagation();
                          setQuery('');
                        }
                      }}
                    />
                    {hitList && (
                      <span className={styles.findCount} role="status">
                        {hitList.length === 0
                          ? t('subgraph.find_none')
                          : hitAt < 0
                            ? t('subgraph.find_count', { n: hitList.length })
                            : `${hitAt + 1} / ${hitList.length}`}
                      </span>
                    )}
                  </>
                )}
                {fold !== null && (
                  <button type="button" className={styles.tool} aria-pressed={fold} onClick={onFold}>
                    {t('subgraph.fold')}
                  </button>
                )}
              </Panel>
            )}
          </ReactFlow>
        </ViewContext.Provider>
        {wheelHint && (
          <div className={styles.wheelHint} aria-hidden="true">
            {t('subgraph.wheel_hint')}
          </div>
        )}
      </div>
      {selected?.n && (
        <ComponentPanel
          key={selected.n.component}
          n={selected.n}
          clusterId={clusterId}
          alertLabel={alertLabel}
          onClose={close}
        />
      )}
      {selected?.group && (
        <GroupPanel
          key={selected.group.id}
          group={selected.group}
          clusterId={clusterId}
          onExpand={onExpand}
          onClose={close}
        />
      )}
    </div>
  );
}

/** 全屏切换（Fullscreen API）：进入时适配视口，退出时恢复进入前的缩放与位置 */
function FullscreenButton({
  frame,
  on,
  onChange,
}: {
  frame: RefObject<HTMLDivElement | null>;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const { fitView, getViewport, setViewport } = useReactFlow();
  const saved = useRef<Viewport | null>(null);
  const fitPending = useRef(false);
  const size = useStore((s) => `${s.width}x${s.height}`);
  const sizeAtEnter = useRef(size);
  useEffect(() => {
    const sync = () => {
      const now = frame.current !== null && document.fullscreenElement === frame.current;
      onChange(now);
      if (!now && saved.current) {
        void setViewport(saved.current);
        saved.current = null;
        fitPending.current = false;
      }
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [frame, setViewport, onChange]);
  // 画布尺寸在全屏切换之后才更新：等尺寸变了再适配一次，之后用户的缩放不再被打断
  useEffect(() => {
    if (on && fitPending.current && size !== sizeAtEnter.current) {
      fitPending.current = false;
      void fitView(FIT);
    }
  }, [on, size, fitView]);
  if (!document.fullscreenEnabled) {
    return null;
  }
  const toggle = () => {
    if (on) {
      void document.exitFullscreen();
      return;
    }
    const el = frame.current;
    if (!el) {
      return;
    }
    saved.current = getViewport();
    sizeAtEnter.current = size;
    fitPending.current = true;
    // 浏览器拒绝进入全屏（例如宿主 iframe 没有授权全屏）时页面保持原样，撤销待恢复的状态
    el.requestFullscreen().catch(() => {
      saved.current = null;
      fitPending.current = false;
    });
  };
  const label = on ? t('subgraph.exit_fullscreen') : t('subgraph.fullscreen');
  return (
    <ControlButton onClick={toggle} title={label} aria-label={label} aria-pressed={on}>
      {on ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
    </ControlButton>
  );
}

/** 侧栏的外框：标题与关闭按钮；打开时焦点移到标题 */
function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <aside className={styles.panel} aria-labelledby={headingId} data-testid="subgraph-panel">
      <header className={styles.panelHead}>
        <h3 id={headingId} ref={heading} tabIndex={-1} className={styles.panelTitle}>
          {title}
        </h3>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t('common.close')}>
          <X aria-hidden="true" />
        </button>
      </header>
      {children}
    </aside>
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
      <Mono className={styles.key}>{n.component}</Mono>
      <dl className={styles.facts}>
        <dt>{t('subgraph.panel.role')}</dt>
        <dd data-role={n.role}>{t(`subgraph.role.${n.role}`)}</dd>
        <dt>{t('subgraph.panel.kind')}</dt>
        <dd>{l.sub}</dd>
        <dt>{t('subgraph.panel.hops')}</dt>
        <dd>{t('subgraph.panel.hops_n', { n: n.hops })}</dd>
      </dl>
      <h4 className={styles.panelSub}>{t('subgraph.alerts', { n: n.alerts.length })}</h4>
      {n.alerts.length ? (
        <ul className={styles.alerts}>
          {n.alerts.map((a) => (
            <li key={a} title={a}>
              {alertLabel ? alertLabel(a) : a}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>{t('subgraph.panel.no_alerts')}</p>
      )}
      {(topologyHref || searchHref) && (
        <nav className={styles.panelLinks} aria-label={t('subgraph.panel.links')}>
          {topologyHref && (
            <AppLink href={topologyHref} className={styles.link}>
              {t('subgraph.panel.open_neighborhood')}
            </AppLink>
          )}
          {searchHref && (
            <AppLink href={searchHref} className={styles.link}>
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
      <p className={styles.none}>{t('subgraph.fold_because')}</p>
      <dl className={styles.facts}>
        {group.namespace && (
          <>
            <dt>{t('subgraph.panel.namespace')}</dt>
            <dd>{group.namespace}</dd>
          </>
        )}
        <dt>{t('subgraph.panel.hops')}</dt>
        <dd>{t('subgraph.panel.hops_n', { n: group.hops })}</dd>
      </dl>
      <button type="button" className={styles.tool} onClick={() => onExpand(group.id)}>
        {t('subgraph.fold_expand')}
      </button>
      <ul className={styles.alerts}>
        {group.members.map((m) => {
          const name = componentLabel(m.component, names).name;
          return (
            <li key={m.component} title={m.component}>
              {topology && clusterId ? (
                <AppLink href={topology(clusterId, m.component)} className={styles.link}>
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
