// 根因子图（DESIGN §12.2、§12.5、ADR 0191）：只画根因加不超过 2 跳的邻居，用 elkjs 的分层布局，每条边标注来源与置信度。
// 节点位置固定不能拖动；画布可以拖动平移，用按钮、触控板双指捏合或 Ctrl/⌘ + 滚轮缩放（普通滚轮仍然滚动页面），可以全屏。
// 单击节点或在节点上按 Enter 打开组件侧栏，Esc 关闭；双击节点交给宿主打开以它为中心的邻域（onOpenComponent）。

import {
  Background,
  ControlButton,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
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
  type RefObject,
} from 'react';
import type { IncidentSubgraph } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Loading, Mono } from '../primitives/basic';
import { componentLabel, displayComponent } from './model';
import styles from './Subgraph.module.css';
import { useComponentNames } from './names';

type SubNode = IncidentSubgraph['nodes'][number];
type SubData = { n: SubNode; roleText: string; alertsText: string };

const NODE_W = 180;
const NODE_H = 52;
/** 节点数超过这个值时显示小地图 */
export const MINIMAP_MIN_NODES = 10;

// elkjs 打包后约 1.5 MB，只有打开事件详情时才加载
let elkPromise: Promise<ElkApi> | null = null;
function loadElk(): Promise<ElkApi> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

/** 侧栏正在显示的组件键 */
const SelectedContext = createContext<string | null>(null);

function ComponentNode({ data }: NodeProps<Node<SubData>>) {
  const names = useComponentNames();
  const selected = useContext(SelectedContext) === data.n.component;
  const l = componentLabel(data.n.component, names);
  return (
    <div className={styles.node} data-role={data.n.role} data-selected={selected ? '' : undefined}>
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.name} title={displayComponent(data.n.component)}>
        {l.name}
      </div>
      <div className={styles.sub}>
        {data.roleText} · {l.sub}
        {data.n.alerts.length > 0 && ` · ${data.alertsText}`}
      </div>
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
}

const nodeTypes = { component: ComponentNode };

/** elkjs 分层布局，返回每个节点的左上角坐标。 */
export async function layoutSubgraph(g: IncidentSubgraph): Promise<Map<string, { x: number; y: number }>> {
  const elk = await loadElk();
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
    },
    children: g.nodes.map((n) => ({ id: n.component, width: NODE_W, height: NODE_H })),
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
}

export function Subgraph(props: SubgraphProps) {
  const { graph } = props;
  const { t, fmt } = useI18n();
  const [laid, setLaid] = useState<{ nodes: Node<SubData>[]; edges: Edge[] } | null>(null);
  useEffect(() => {
    let live = true;
    layoutSubgraph(graph).then((pos) => {
      if (!live) {
        return;
      }
      setLaid({
        nodes: graph.nodes.map((n) => {
          const p = pos.get(n.component);
          if (!p) {
            throw new Error(`布局缺少节点 ${n.component}`);
          }
          const roleText = t(`subgraph.role.${n.role}`);
          const alertsText = t('subgraph.alerts', { n: n.alerts.length });
          return {
            id: n.component,
            type: 'component',
            position: p,
            data: { n, roleText, alertsText },
            draggable: false,
          };
        }),
        edges: graph.edges.map((e, i) => ({
          id: `e${i}`,
          source: e.from,
          target: e.to,
          label: `${e.relation} · ${t(`subgraph.source.${e.provenance}`)} ${fmt.number(e.confidence, 1)}`,
          className: e.confidence < 0.6 ? styles.weak : undefined,
        })),
      });
    });
    return () => {
      live = false;
    };
  }, [graph, t, fmt]);
  if (!graph.nodes.length) {
    return <EmptyState kind="none" title={t('subgraph.empty_title')} because={t('subgraph.empty_because')} />;
  }
  if (!laid) {
    return <Loading />;
  }
  return <SubgraphCanvas {...props} nodes={laid.nodes} edges={laid.edges} />;
}

function SubgraphCanvas({
  graph,
  clusterId,
  alertLabel,
  onOpenComponent,
  nodes,
  edges,
}: SubgraphProps & { nodes: Node<SubData>[]; edges: Edge[] }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 侧栏关闭后焦点回到打开它的节点
  const opener = useRef<HTMLElement | null>(null);
  // 按住 ⌘ 时由画布接管滚轮做缩放；其余时候普通滚轮滚动页面，Ctrl + 滚轮与触控板捏合照常缩放
  const metaHeld = useKeyPress('Meta');
  const names = useComponentNames();
  const selected = graph.nodes.find((n) => n.component === selectedId) ?? null;
  // 节点对象换新时 xyflow 会重新测量并在测量前隐藏节点，聚焦的节点因此失去焦点：
  // 节点数组只随布局与可读名称的取值变化，选中态经 context 传给节点
  const nameText = nodes.map((n) => componentLabel(n.id, names).name);
  const nameKey = nameText.join('\0');
  const shown = useMemo(
    () =>
      nodes.map((n, i) => ({
        ...n,
        ariaLabel: t('subgraph.node_label', { name: nameText[i], role: n.data.roleText, alerts: n.data.alertsText }),
      })),
    // nameText 每次渲染都是新数组，按取值 nameKey 比较
    [nodes, nameKey, t],
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

  return (
    <div className={styles.frame} ref={frame} data-open={selected ? '' : undefined} onKeyDown={onKeyDown}>
      <div
        className={styles.wrap}
        role="group"
        aria-label={t('subgraph.label', { n: graph.nodes.length, e: graph.edges.length })}
        aria-describedby={hintId}
      >
        <span id={hintId} className={styles.srOnly}>
          {t('subgraph.hint')}
        </span>
        <SelectedContext.Provider value={selectedId}>
          <ReactFlow
            nodes={shown}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            zoomActivationKeyCode={['Meta', 'Control']}
            preventScrolling={metaHeld}
            onNodeClick={(e: MouseEvent, n) => open(n.id, e.target)}
            onNodeDoubleClick={(_e: MouseEvent, n) => onOpenComponent?.(n.id)}
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
            <Controls showInteractive={false} position="bottom-left">
              <FullscreenButton frame={frame} />
            </Controls>
            {graph.nodes.length > MINIMAP_MIN_NODES && <MiniMap pannable zoomable position="bottom-right" />}
          </ReactFlow>
        </SelectedContext.Provider>
      </div>
      {selected && (
        <ComponentPanel
          key={selected.component}
          n={selected}
          clusterId={clusterId}
          alertLabel={alertLabel}
          onClose={close}
        />
      )}
    </div>
  );
}

/** 全屏切换（Fullscreen API）：进入时适配视口，退出时恢复进入前的缩放与位置 */
function FullscreenButton({ frame }: { frame: RefObject<HTMLDivElement | null> }) {
  const { t } = useI18n();
  const { fitView, getViewport, setViewport } = useReactFlow();
  const [on, setOn] = useState(false);
  const saved = useRef<Viewport | null>(null);
  const fitPending = useRef(false);
  const size = useStore((s) => `${s.width}x${s.height}`);
  const sizeAtEnter = useRef(size);
  useEffect(() => {
    const onChange = () => {
      const now = frame.current !== null && document.fullscreenElement === frame.current;
      setOn(now);
      if (!now && saved.current) {
        void setViewport(saved.current);
        saved.current = null;
        fitPending.current = false;
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [frame, setViewport]);
  // 画布尺寸在全屏切换之后才更新：等尺寸变了再适配一次，之后用户的缩放不再被打断
  useEffect(() => {
    if (on && fitPending.current && size !== sizeAtEnter.current) {
      fitPending.current = false;
      void fitView({ padding: 0.1 });
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
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const topologyHref = clusterId && links.topology ? links.topology(clusterId, n.component) : null;
  const searchHref = clusterId && links.search ? links.search(n.component, clusterId) : null;
  return (
    <aside className={styles.panel} aria-labelledby={headingId} data-testid="subgraph-panel">
      <header className={styles.panelHead}>
        <h3 id={headingId} ref={heading} tabIndex={-1} className={styles.panelTitle}>
          {l.name}
        </h3>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t('common.close')}>
          <X aria-hidden="true" />
        </button>
      </header>
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
    </aside>
  );
}
