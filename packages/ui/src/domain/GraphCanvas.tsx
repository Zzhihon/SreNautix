// 图画布（ADR 0191、ADR 0197、ADR 0199）：根因子图、拓扑邻域与全集群地图共用的交互层。
// 节点位置由调用方的布局给出，不能拖动；画布可以拖动平移，用按钮、触控板双指捏合或 Ctrl/⌘ + 滚轮缩放，可以全屏。
// 画布是页面主要内容（primary）或全屏时普通滚轮直接缩放；嵌在长页面里时普通滚轮滚动页面，并提示按住 Ctrl/⌘。
// 单击节点或在节点上按 Enter 打开侧栏，Esc 关闭；双击交给调用方（onOpen）。指向或选中一个节点只突出它和直接相连的节点；
// 节点多时可以按名称查找，边的标注只在被突出的节点上显示。节点组件经 useCanvasView 读取选中、突出与查找命中。

import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useKeyPress,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeTypes,
  type FitViewOptions,
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
import { useI18n } from '../i18n';
import styles from './GraphCanvas.module.css';

/** 画布上的节点数超过这个值时显示小地图与查找框，边的标注只在被突出的节点上显示 */
export const MINIMAP_MIN_NODES = 10;
/** 适配视图时最多放大到 2 倍：只有两三个节点的图不会被撑满画布 */
export const FIT = { padding: 0.1, maxZoom: 2 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
// 小地图的尺寸：320 像素高的嵌入画布里不占掉半个高度
const MINIMAP_W = 150;
const MINIMAP_H = 100;

// elkjs 打包后约 1.5 MB，只有打开图时才加载
let elkPromise: Promise<ElkApi> | null = null;
export function loadElk(): Promise<ElkApi> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

export interface CanvasView {
  /** 侧栏正在显示的节点 id */
  selectedId: string | null;
  /** 被突出的节点：鼠标指向的节点，没有时为侧栏里的节点 */
  focusId: string | null;
  /** 要突出的节点；null 表示全部正常显示，不在其中的节点变淡 */
  lit: ReadonlySet<string> | null;
  /** 查找命中的节点 */
  hits: ReadonlySet<string> | null;
}
const ViewContext = createContext<CanvasView>({ selectedId: null, focusId: null, lit: null, hits: null });

/** 节点组件读取选中、突出与查找命中；它们经 context 传入，节点对象保持不变（ADR 0191 §7） */
export function useCanvasView(): CanvasView {
  return useContext(ViewContext);
}

/** 节点外壳上的状态属性：选中、变淡、查找命中 */
export function viewAttrs(view: CanvasView, id: string) {
  return {
    'data-selected': view.selectedId === id ? '' : undefined,
    'data-dim': view.lit && !view.lit.has(id) ? '' : undefined,
    'data-hit': view.hits?.has(id) ? '' : undefined,
  };
}

/** text：标注；weak：弱边（虚线）；quiet：只在两端之一被突出时画出 */
export type CanvasEdge = Edge<{ text?: string; weak?: boolean; quiet?: boolean }>;

export interface GraphCanvasProps<N extends Node> {
  /** 画布的可访问名称 */
  label: string;
  /** 只给屏幕阅读器的操作说明 */
  hint: string;
  /** 节点数组只在布局变化时换新：xyflow 收到新对象会重新测量，测量前隐藏节点，聚焦的节点因此失去焦点 */
  nodes: N[];
  edges: CanvasEdge[];
  nodeTypes: NodeTypes;
  /** 节点的可访问名称 */
  ariaLabel: (n: N) => string;
  /** 查找用的文字；返回 null 的节点不参加查找。不提供时没有查找框 */
  findText?: (n: N) => string | null;
  /** 是否显示查找框；默认画布上可操作的节点超过 MINIMAP_MIN_NODES 时显示 */
  showFind?: boolean;
  /** 能单击打开侧栏、指向时突出的节点；默认全部（全集群地图的领域框与服务框不能） */
  interactive?: (n: N) => boolean;
  /** 双击节点 */
  onOpen?: (n: N) => void;
  /** 画布是页面的主要内容：画布占满视口剩余的高度，普通滚轮直接缩放 */
  primary?: boolean;
  /** 查找框旁边的工具按钮 */
  tools?: ReactNode;
  /** 选中节点的侧栏 */
  panel?: (n: N, close: () => void) => ReactNode;
  /** 画布下方、全屏范围内的内容（全集群地图的节点条） */
  footer?: ReactNode;
  /** 外部指定要突出的节点（例如指向节点条上的节点），优先于画布内的指向与选中 */
  highlight?: ReadonlySet<string> | null;
  /** 初次显示与布局变化后适配到这些节点；不提供时适配全图 */
  fitTo?: readonly string[];
}

export function GraphCanvas<N extends Node>({
  label,
  hint,
  nodes,
  edges,
  nodeTypes,
  ariaLabel,
  findText,
  showFind,
  interactive = () => true,
  onOpen,
  primary = false,
  tools,
  panel,
  footer,
  highlight = null,
  fitTo,
}: GraphCanvasProps<N>) {
  const { t } = useI18n();
  const { fitView, setCenter, getZoom, getInternalNode } = useReactFlow();
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
  const items = useMemo(() => nodes.filter(interactive), [nodes, interactive]);
  const dense = items.length > MINIMAP_MIN_NODES;
  const finding = Boolean(findText) && (showFind ?? dense);
  // 侧栏关闭后焦点回到打开它的节点
  const opener = useRef<HTMLElement | null>(null);
  // 按住 ⌘ 时由画布接管滚轮做缩放；其余时候普通滚轮滚动页面，Ctrl + 滚轮与触控板捏合照常缩放
  const metaHeld = useKeyPress('Meta');
  // 布局变了之后选中的节点可能已经不在画布上，这时侧栏收起
  const selected = items.find((n) => n.id === selectedId) ?? null;
  const shown = useMemo(
    () => nodes.map((n) => ({ ...n, ariaLabel: ariaLabel(n), focusable: interactive(n) })),
    [nodes, ariaLabel, interactive],
  );
  // 布局变了之后重新适配视图；xyflow 等新节点量出尺寸后才执行
  // 适配后的图不被左上角的工具条和右下角的小地图盖住：上边留出工具条的高度，右边留出小地图的宽度
  const toolbar = finding || Boolean(tools);
  const fitOptions = useMemo<FitViewOptions>(
    () => ({
      ...FIT,
      ...(toolbar || dense
        ? {
            padding: {
              top: toolbar ? '52px' : '4%',
              right: dense ? `${MINIMAP_W + 24}px` : '4%',
              bottom: '4%',
              left: '4%',
            },
          }
        : {}),
      ...(fitTo?.length ? { nodes: fitTo.map((id) => ({ id })) } : {}),
    }),
    [fitTo, toolbar, dense],
  );
  const fitted = useRef(nodes);
  useEffect(() => {
    if (fitted.current !== nodes) {
      fitted.current = nodes;
      void fitView(fitOptions);
    }
  }, [nodes, fitView, fitOptions]);

  const q = query.trim().toLowerCase();
  const hitList = useMemo(
    () => (q && findText ? items.filter((n) => findText(n)?.toLowerCase().includes(q)) : null),
    [q, items, findText],
  );
  const hits = useMemo(() => hitList && new Set(hitList.map((n) => n.id)), [hitList]);
  const nextHit = () => {
    if (!hitList?.length) {
      return;
    }
    const at = (hitAt + 1) % hitList.length;
    const n = hitList[at] as N;
    // 子节点的 position 相对父节点（全集群地图的服务框），定位用绝对坐标
    const p = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
    setHitAt(at);
    void setCenter(p.x + (n.width ?? 0) / 2, p.y + (n.height ?? 0) / 2, {
      zoom: Math.max(getZoom(), 1),
      duration: 200,
    });
  };

  // 突出：外部指定的优先，其次是鼠标指向的节点，再其次是查找命中，最后是侧栏里的节点
  const focusId = highlight ? null : (hoverId ?? (hits || !selected ? null : selectedId));
  const view = useMemo<CanvasView>(() => {
    if (highlight) {
      return { selectedId, focusId, lit: highlight, hits };
    }
    if (focusId === null) {
      return { selectedId, focusId, lit: hits, hits };
    }
    const lit = new Set([focusId]);
    for (const e of edges) {
      if (e.source === focusId) {
        lit.add(e.target);
      } else if (e.target === focusId) {
        lit.add(e.source);
      }
    }
    return { selectedId, focusId, lit, hits };
  }, [selectedId, focusId, hits, edges, highlight]);
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const on = e.source === focusId || e.target === focusId;
        const lit = view.lit;
        const dim = focusId !== null ? !on : lit !== null && !(lit.has(e.source) && lit.has(e.target));
        return {
          ...e,
          // 节点多时边的标注互相遮挡：只标出被突出的节点上的边
          label: !dense || on ? e.data?.text : undefined,
          className: [e.className, e.data?.weak && styles.weak, on && styles.on, dim && styles.dim]
            .filter(Boolean)
            .join(' '),
          hidden: Boolean(e.data?.quiet) && !on,
          zIndex: on ? 1 : 0,
        };
      }),
    [edges, focusId, view.lit, dense],
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
    if (el && id && items.some((n) => n.id === id)) {
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
  const usable = (n: Node) => items.some((x) => x.id === n.id);

  return (
    <ViewContext.Provider value={view}>
      <div
        className={styles.frame}
        ref={frame}
        data-open={selected && panel ? '' : undefined}
        data-primary={primary ? '' : undefined}
        onKeyDown={onKeyDown}
      >
        <div className={styles.wrap} role="group" aria-label={label} aria-describedby={hintId} onWheel={onWheel}>
          <span id={hintId} className={styles.srOnly}>
            {hint}
          </span>
          <ReactFlow
            nodes={shown}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={fitOptions}
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
            onNodeClick={(e: MouseEvent, n) => usable(n) && open(n.id, e.target)}
            onNodeDoubleClick={(_e: MouseEvent, n) => usable(n) && onOpen?.(n as N)}
            onNodeMouseEnter={(_e: MouseEvent, n) => usable(n) && setHoverId(n.id)}
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
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={fitOptions}>
              <FullscreenButton frame={frame} on={fullscreen} onChange={setFullscreen} fit={fitOptions} />
            </Controls>
            {dense && (
              <MiniMap pannable zoomable position="bottom-right" style={{ width: MINIMAP_W, height: MINIMAP_H }} />
            )}
            {(finding || tools) && (
              <Panel position="top-left" className={styles.tools}>
                {finding && (
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
                {tools}
              </Panel>
            )}
          </ReactFlow>
          {wheelHint && (
            <div className={styles.wheelHint} aria-hidden="true">
              {t('subgraph.wheel_hint')}
            </div>
          )}
        </div>
        {selected && panel?.(selected, close)}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </ViewContext.Provider>
  );
}

/** 全屏切换（Fullscreen API）：进入时适配视口，退出时恢复进入前的缩放与位置 */
function FullscreenButton({
  frame,
  on,
  onChange,
  fit,
}: {
  frame: RefObject<HTMLDivElement | null>;
  on: boolean;
  onChange: (on: boolean) => void;
  fit: FitViewOptions;
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
      void fitView(fit);
    }
  }, [on, size, fitView, fit]);
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
export function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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

/** 侧栏与工具条共用的样式（事实列表、链接、按钮） */
export { styles as canvasStyles };
