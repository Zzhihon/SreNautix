// 全集群地图（ADR 0199）：GET /v1/topology/map 画成 业务领域 → 服务 → 组件 的嵌套框。
// 正在触发的事件叠加在组件上：根因按严重度着色，依赖根因的组件标为受影响，框的标题写事件数。边默认只画核心链路与事件的传播路径，
// "全部依赖""网络放行"两档画出更多（ADR 0205）；组件按角色着色，边按种类着色。排布是确定的（packMap），不用 elkjs。画布交互在 GraphCanvas；
// 下方的节点条列出节点，指向组件时标出它所在的节点，指向节点时只突出上面的组件。双击组件交给宿主打开它的邻域。
// 结构（组件、边、归属）只在拓扑版本或归属变化时重新布局；事件经 context 更新，节点对象不变。

import { Handle, Position, ReactFlowProvider, useStore, type Node, type NodeProps } from '@xyflow/react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ClusterMap as MapData } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { localizedText, useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Mono } from '../primitives/basic';
import styles from './ClusterMap.module.css';
import {
  BLAST_MIN_CONFIDENCE,
  buildMapModel,
  EDGE_LEVELS,
  incidentOverlay,
  MERGE_CONFIDENCE,
  shownAt,
  UNASSIGNED,
  worstTone,
  type ComponentRole,
  type EdgeKind,
  type EdgeLevel,
  type MapModel,
  packMap,
  type MapNodeItem,
  type Placed,
  type Tone,
} from './cluster-map-model';
import { canvasStyles, GraphCanvas, SidePanel, useCanvasView, viewAttrs, type CanvasEdge } from './GraphCanvas';

type MapComponent = MapData['components'][number];
type MapIncident = MapData['incidents'][number];
type BoxData = { box: 'domain' | 'service'; title: string; tier?: string; item?: undefined };
type ItemData = { item: MapNodeItem; box?: undefined };
type MapNode = Node<BoxData | ItemData>;

/** 缩放到这个值以下只显示组件名称（领域层） */
const DETAIL_ZOOM = 0.45;

interface Overlay {
  tone: ReadonlyMap<string, Tone>;
  /** 画布节点（组件、合并的组、服务框、领域框）上的事件 */
  incidents: ReadonlyMap<string, MapIncident[]>;
  /** 画布节点的状态：组取成员中最重的，框取框内最重的根因 */
  nodeTone: ReadonlyMap<string, Tone>;
  /** 节点条上的 Kubernetes 节点（按节点键）的事件与状态 */
  hostIncidents: ReadonlyMap<string, MapIncident[]>;
  hostTone: ReadonlyMap<string, Tone>;
}
const OverlayContext = createContext<Overlay>({
  tone: new Map(),
  incidents: new Map(),
  nodeTone: new Map(),
  hostIncidents: new Map(),
  hostTone: new Map(),
});

function BoxNode({ id, data }: NodeProps<Node<BoxData>>) {
  const { t } = useI18n();
  const o = useContext(OverlayContext);
  const n = o.incidents.get(id)?.length ?? 0;
  // 缩小看全图时领域的标题按缩放放大，屏幕上保持约 13 像素，领域层也读得出领域名
  const zoom = useStore((s) => s.transform[2]);
  const scale = data.box === 'domain' && zoom < 1 ? Math.min(1 / zoom, 4) : 1;
  return (
    <div className={styles.box} data-box={data.box} data-tier={data.tier} data-tone={o.nodeTone.get(id)}>
      <div
        className={styles.boxHead}
        style={scale > 1 ? { fontSize: `${13 * scale}px`, transform: `translateY(${-(scale - 1) * 12}px)` } : undefined}
      >
        <span className={styles.boxTitle}>
          {data.tier && <span className={styles.tier}>{t(`map.tier.${data.tier}`)}</span>}
          {data.title}
        </span>
        {n > 0 && <span className={styles.boxCount}>{t('map.firing', { n })}</span>}
      </div>
    </div>
  );
}

function ItemNode({ id, data }: NodeProps<Node<ItemData>>) {
  const { t } = useI18n();
  const view = useCanvasView();
  const o = useContext(OverlayContext);
  const detail = useStore((s) => s.transform[2] >= DETAIL_ZOOM);
  const it = data.item;
  const tone = o.nodeTone.get(id);
  const folded = it.members.length > 1;
  return (
    <div
      className={styles.item}
      data-tone={tone}
      data-fold={folded ? '' : undefined}
      data-src={!folded && it.members[0]?.service_source === 'namespace' ? 'namespace' : undefined}
      data-role={it.role}
      {...viewAttrs(view, id)}
    >
      {SIDES.map((side) => (
        <Handle key={`t${side}`} id={`t${side}`} type="target" position={side} className={styles.handle} />
      ))}
      <div className={styles.name} title={folded ? undefined : it.members[0]?.key}>
        {folded ? `${it.name} × ${it.members.length}` : it.name}
        {it.sinkServices !== undefined && (
          <span className={styles.sink} title={t('map.sink_title', { n: it.sinkServices })}>
            {t('map.sink', { n: it.sinkServices })}
          </span>
        )}
      </div>
      {detail && (
        <div className={styles.sub}>
          {[t(`map.role.${it.role}`), it.kind.split('.')[0], it.namespace].filter(Boolean).join(' · ')}
          {tone && ` · ${t(`map.tone.${tone}`)}`}
        </div>
      )}
      {SIDES.map((side) => (
        <Handle key={`s${side}`} id={`s${side}`} type="source" position={side} className={styles.handle} />
      ))}
    </div>
  );
}

const nodeTypes = { box: BoxNode, item: ItemNode };
const SIDES = [Position.Left, Position.Right, Position.Top, Position.Bottom] as const;

/**
 * 边从哪一侧出、进哪一侧：按两个组件中心的相对位置，左右错开为主时走左右两侧，上下为主时走上下两侧。
 * 同一列里上下排着的组件之间的边不再绕到右侧再折回左侧（ADR 0205）
 */
export function edgeSides(placed: ReadonlyMap<string, Placed>, from: string, to: string) {
  const center = (id: string) => {
    let p = placed.get(id);
    let x = (p?.w ?? 0) / 2;
    let y = (p?.h ?? 0) / 2;
    while (p) {
      x += p.x;
      y += p.y;
      p = p.parent ? placed.get(p.parent) : undefined;
    }
    return { x, y };
  };
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const [s, t] =
    Math.abs(dx) > Math.abs(dy)
      ? dx > 0
        ? [Position.Right, Position.Left]
        : [Position.Left, Position.Right]
      : dy > 0
        ? [Position.Bottom, Position.Top]
        : [Position.Top, Position.Bottom];
  return { sourceHandle: `s${s}`, targetHandle: `t${t}` };
}
const ROLES: readonly ComponentRole[] = ['entry', 'service', 'data', 'batch', 'node'];
const EDGE_KINDS: readonly EdgeKind[] = ['declared', 'route', 'reference', 'allowed'];
/** 边的种类决定颜色与线型 */
const EDGE_CLASS: Record<EdgeKind, string | undefined> = {
  declared: styles.edgeDeclared,
  route: styles.edgeRoute,
  reference: styles.edgeReference,
  allowed: styles.edgeAllowed,
};

/** 画布节点：领域框、服务框（父节点在前）与组件，位置来自 packMap */
export function mapNodes(
  model: MapModel,
  placed: ReadonlyMap<string, Placed>,
  title: (boxId: string) => string,
  tierOf: (d: string) => string | undefined,
): MapNode[] {
  // 领域框标出档次（核心、支撑、底座、运维自身），核心领域的框底色更深，值班的人先看到业务链路
  const out: MapNode[] = [];
  const at = (id: string) => {
    const p = placed.get(id)!;
    return { position: { x: p.x, y: p.y }, width: p.w, height: p.h, parentId: p.parent, draggable: false };
  };
  for (const d of model.domains) {
    // 框只是背景：不接收指针，拖动框内的空白处照常平移画布
    out.push({
      id: d.id,
      type: 'box',
      ...at(d.id),
      data: { box: 'domain', title: title(d.id), tier: d.domain === UNASSIGNED ? undefined : tierOf(d.domain) },
      style: { pointerEvents: 'none' },
      zIndex: -2,
    });
    for (const s of d.services) {
      out.push({
        id: s.id,
        type: 'box',
        ...at(s.id),
        data: { box: 'service', title: title(s.id) },
        style: { pointerEvents: 'none' },
        zIndex: -1,
      });
      for (const it of s.items) {
        // 写明宽高：小地图只画有尺寸的节点，而这里的节点不经 onNodesChange 回写测量结果
        out.push({ id: it.id, type: 'item', ...at(it.id), data: { item: it } });
      }
    }
  }
  return out;
}

export interface ClusterMapProps {
  map: MapData;
  clusterId: string;
  /** 双击组件：宿主打开以它为中心的拓扑邻域 */
  onOpenComponent?: (component: string) => void;
  /** 初次显示时对准这个业务领域（收件箱领域卡片的链接） */
  focusDomain?: string;
  /** 画布是页面的主要内容：占满视口剩余的高度，普通滚轮直接缩放 */
  primary?: boolean;
}

/** 结构的指纹：拓扑版本、组件与归属、边；事件不在其中 */
const structureKey = (m: MapData) =>
  [m.topology_version, m.components.map((c) => `${c.key}=${c.service ?? ''}`).join(','), m.edges.length].join('|');

export function ClusterMap({ map, clusterId, onOpenComponent, focusDomain, primary }: ClusterMapProps) {
  const { t, locale } = useI18n();
  // 结构只在指纹变化时换新：轮询拿到的新对象不会触发重新布局
  const [structure, setStructure] = useState(map);
  if (structureKey(structure) !== structureKey(map)) {
    setStructure(map);
  }
  const [fold, setFold] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [onlyTroubled, setOnlyTroubled] = useState(false);
  const overlay = useMemo(() => incidentOverlay(structure, map.incidents), [structure, map.incidents]);
  const roots = [...overlay.byComponent.keys()].sort().join('\0');
  const troubled = onlyTroubled ? [...overlay.tone.keys(), '|', ...overlay.byService.keys()].sort().join('\0') : '';
  const model = useMemo(
    () =>
      buildMapModel(structure, {
        fold,
        expanded,
        roots: new Set(roots ? roots.split('\0') : []),
        keep: onlyTroubled
          ? (c: MapComponent) => overlay.tone.has(c.key) || (c.service !== null && overlay.byService.has(c.service))
          : undefined,
      }),
    // overlay 每次轮询都是新对象，按根因与受影响组件的取值（roots、troubled）比较
    [structure, fold, expanded, roots, onlyTroubled, troubled],
  );
  const title = useCallback(
    (boxId: string) => {
      if (boxId.startsWith('d:')) {
        const id = boxId.slice(2);
        const d = structure.domains.find((x) => x.id === id);
        return id === UNASSIGNED || !d ? t('map.unassigned') : localizedText(d.title, locale);
      }
      const sid = boxId.slice(2);
      if (sid.startsWith('ns:')) {
        return t('map.namespace', { ns: sid.slice(3) });
      }
      const s = structure.domains.flatMap((d) => d.services).find((x) => x.id === sid);
      return s ? localizedText(s.title, locale) : sid;
    },
    [structure, t, locale],
  );
  const tierOf = useCallback((d: string) => structure.domains.find((x) => x.id === d)?.tier, [structure]);
  const placed = useMemo(() => packMap(model, tierOf), [model, tierOf]);
  const nodes = useMemo(() => mapNodes(model, placed, title, tierOf), [model, placed, title, tierOf]);
  const [level, setLevel] = useState<EdgeLevel>('core');

  const ctx = useMemo<Overlay>(() => {
    const incidents = new Map<string, MapIncident[]>();
    const nodeTone = new Map<string, Tone>();
    const add = (id: string, list: MapIncident[]) => incidents.set(id, [...(incidents.get(id) ?? []), ...list]);
    for (const d of model.domains) {
      const domainTones: Array<Tone | undefined> = [];
      for (const s of d.services) {
        const own = s.service ? (overlay.byService.get(s.service) ?? []) : [];
        add(s.id, own);
        add(d.id, own);
        const st = worstTone(own.map((i) => (i.severity === 'critical' ? 'bad' : 'warn')));
        for (const it of s.items) {
          const tone = worstTone(it.members.map((m) => overlay.tone.get(m.key)));
          if (tone) {
            nodeTone.set(it.id, tone);
          }
          add(
            it.id,
            it.members.flatMap((m) => overlay.byComponent.get(m.key) ?? []),
          );
        }
        if (st) {
          nodeTone.set(s.id, st);
        }
        domainTones.push(st);
      }
      const dt = worstTone(domainTones);
      if (dt) {
        nodeTone.set(d.id, dt);
      }
    }
    return { tone: overlay.tone, incidents, nodeTone, hostIncidents: overlay.byNode, hostTone: overlay.nodeTone };
  }, [model, overlay]);

  // 画出档位以内的边与事件的传播路径（两端都是根因或受影响的组件，沿 BLAST_MIN_CONFIDENCE 以上的边）；指向或选中组件时
  // 再画出它不低于 τ 的边。只被网络策略放行的边只在"网络放行"档画出（ADR 0199 §4、ADR 0205）
  const edges = useMemo<CanvasEdge[]>(() => {
    const tone = (id: string) => ctx.nodeTone.get(id);
    const reach: EdgeLevel = level === 'allowed' ? 'allowed' : 'deps';
    return model.edges
      .filter((e) => shownAt(e.level, reach))
      .map((e, i) => {
        const path = Boolean(tone(e.from) && tone(e.to)) && e.confidence >= BLAST_MIN_CONFIDENCE;
        return {
          id: `e${i}`,
          source: e.from,
          target: e.to,
          ...edgeSides(placed, e.from, e.to),
          className: [EDGE_CLASS[e.kind], path && styles.path].filter(Boolean).join(' '),
          data: { quiet: !path && !shownAt(e.level, level) },
        };
      });
  }, [model, placed, ctx, level]);

  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const highlight = useMemo(() => {
    if (!hoverNode) {
      return null;
    }
    const lit = new Set<string>();
    for (const c of structure.components) {
      const id = model.nodeOf.get(c.key);
      if (id && c.nodes.includes(hoverNode)) {
        lit.add(id);
      }
    }
    return lit;
  }, [hoverNode, structure, model]);
  const fitTo = useMemo(
    () => (focusDomain && model.domains.some((d) => d.domain === focusDomain) ? [`d:${focusDomain}`] : undefined),
    [focusDomain, model],
  );
  const ariaLabel = useCallback(
    (n: MapNode) => {
      if (n.data.box) {
        return n.data.title;
      }
      const it = n.data.item;
      const tone = ctx.nodeTone.get(n.id);
      return t('map.item_label', {
        name: it.members.length > 1 ? `${it.name} × ${it.members.length}` : it.name,
        kind: it.kind,
        state: tone ? t(`map.tone.${tone}`) : t('map.tone.ok'),
      });
    },
    [t, ctx],
  );
  const findText = useCallback(
    (n: MapNode) => (n.data.item ? [n.data.item.name, ...n.data.item.members.map((m) => m.key)].join('\n') : null),
    [],
  );
  const interactive = useCallback((n: MapNode) => n.type === 'item', []);
  const foldable =
    !fold ||
    expanded.size > 0 ||
    model.domains.some((d) => d.services.some((s) => s.items.some((i) => i.members.length > 1)));

  if (!structure.components.length) {
    return <EmptyState kind="none" title={t('map.empty_title')} because={t('map.empty_because')} />;
  }
  return (
    <OverlayContext.Provider value={ctx}>
      <ReactFlowProvider>
        <GraphCanvas
          label={t('map.label', { n: structure.components.length, e: structure.edges.length })}
          hint={t('map.hint')}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          ariaLabel={ariaLabel}
          findText={findText}
          showFind
          interactive={interactive}
          primary={primary}
          highlight={highlight}
          fitTo={fitTo}
          onOpen={(n) => {
            const it = n.data.item;
            if (it && it.members.length > 1) {
              setExpanded(new Set([...expanded, n.id]));
            } else if (it) {
              onOpenComponent?.(n.id);
            }
          }}
          tools={
            <>
              {foldable && (
                <button
                  type="button"
                  className={canvasStyles.tool}
                  aria-pressed={fold}
                  onClick={() => {
                    setFold(!fold);
                    setExpanded(new Set());
                  }}
                >
                  {t('subgraph.fold')}
                </button>
              )}
              <span role="group" aria-label={t('map.edges_level')} className={styles.levels}>
                {EDGE_LEVELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    className={canvasStyles.tool}
                    aria-pressed={level === l}
                    title={t(`map.level_hint.${l}`)}
                    onClick={() => setLevel(l)}
                  >
                    {t(`map.level.${l}`)}
                  </button>
                ))}
              </span>
              <button
                type="button"
                className={canvasStyles.tool}
                aria-pressed={onlyTroubled}
                disabled={!onlyTroubled && overlay.tone.size === 0 && overlay.byService.size === 0}
                onClick={() => setOnlyTroubled(!onlyTroubled)}
              >
                {t('map.only_troubled')}
              </button>
            </>
          }
          panel={(n, close) =>
            n.data.item ? (
              <ItemPanel
                key={n.id}
                id={n.id}
                item={n.data.item}
                map={structure}
                clusterId={clusterId}
                onExpand={() => setExpanded(new Set([...expanded, n.id]))}
                onClose={close}
              />
            ) : null
          }
          footer={<Footer map={map} model={model} hoverNode={hoverNode} onHoverNode={setHoverNode} />}
        />
      </ReactFlowProvider>
    </OverlayContext.Provider>
  );
}

/** 节点条、集群枢纽、事件与图例 */
function Footer({
  map,
  model,
  hoverNode,
  onHoverNode,
}: {
  map: MapData;
  model: MapModel;
  hoverNode: string | null;
  onHoverNode: (node: string | null) => void;
}) {
  const { t } = useI18n();
  const { links } = useUiEnv();
  const view = useCanvasView();
  const o = useContext(OverlayContext);
  // 被突出的组件（或合并的组）运行在哪些节点上
  const placed = new Set<string>();
  if (view.focusId) {
    for (const c of map.components) {
      if (model.nodeOf.get(c.key) === view.focusId) {
        c.nodes.forEach((n) => placed.add(n));
      }
    }
  }
  const unplaced = map.incidents.filter((i) => !i.component);
  const onNodes = map.incidents.filter((i) => i.placement === 'node');
  return (
    <div className={styles.footer}>
      <div className={styles.strip} role="list" aria-label={t('map.nodes')}>
        <span className={styles.stripLabel}>{t('map.nodes')}</span>
        {map.nodes.map((n) => (
          <span
            key={n.key}
            role="listitem"
            tabIndex={0}
            className={styles.nodeChip}
            data-on={placed.has(n.key) || hoverNode === n.key ? '' : undefined}
            data-dim={view.focusId && !placed.has(n.key) ? '' : undefined}
            data-tone={o.hostTone.get(n.key)}
            onMouseEnter={() => onHoverNode(n.key)}
            onMouseLeave={() => onHoverNode(null)}
            onFocus={() => onHoverNode(n.key)}
            onBlur={() => onHoverNode(null)}
            title={t('map.node_title', { components: n.components, pods: n.pods })}
          >
            {n.name}
            <small>{n.pods}</small>
            {o.hostIncidents.has(n.key) && (
              <b aria-label={t('map.node_incidents', { n: o.hostIncidents.get(n.key)!.length })}>
                {o.hostIncidents.get(n.key)!.length}
              </b>
            )}
          </span>
        ))}
      </div>
      <p className={styles.note}>
        {t('map.hubs', {
          hubs: map.hubs.map((h) => `${h.name}（${h.dependents}）`).join(' · ') || '-',
        })}
        {' · '}
        {t('map.omitted', { n: map.omitted })}
      </p>
      {onNodes.length > 0 && (
        <p className={styles.note}>
          {t('map.on_nodes', { n: onNodes.length })}{' '}
          {onNodes.slice(0, 5).map((i) => (
            <AppLink key={i.incident_id} href={links.incident(i.label)} className={canvasStyles.link}>
              {`${i.component!.slice(i.component!.indexOf(':') + 1)} · ${i.headline?.alertname ?? i.label}`}
            </AppLink>
          ))}
        </p>
      )}
      {unplaced.length > 0 && (
        <p className={styles.note}>
          {t('map.unplaced', { n: unplaced.length })}{' '}
          {unplaced.slice(0, 5).map((i) => (
            <AppLink key={i.incident_id} href={links.incident(i.label)} className={canvasStyles.link}>
              {i.headline?.alertname ?? i.label}
            </AppLink>
          ))}
        </p>
      )}
      <div className={styles.legend} aria-hidden="true">
        <span>
          <i data-tone="bad" />
          {t('map.legend.bad')}
        </span>
        <span>
          <i data-tone="warn" />
          {t('map.legend.warn')}
        </span>
        <span>
          <i data-tone="hit" />
          {t('map.legend.hit')}
        </span>
        <span>
          <i data-src="namespace" />
          {t('map.legend.namespace')}
        </span>
        <span>
          <i data-fold="" />
          {t('map.legend.fold')}
        </span>
        {o.tone.size === 0 && <span>{t('map.none_firing')}</span>}
      </div>
      <div className={styles.legend} aria-hidden="true">
        {ROLES.map((r) => (
          <span key={r}>
            <i data-role={r} />
            {t(`map.role.${r}`)}
          </span>
        ))}
        {EDGE_KINDS.map((k) => (
          <span key={k}>
            <svg className={styles.legendEdge} data-kind={k} viewBox="0 0 22 6" width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" />
            </svg>
            {t(`map.edge_kind.${k}`)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 组件或合并的组的侧栏：归属、成员、所在节点、依赖、事件与跳转 */
function ItemPanel({
  id,
  item,
  map,
  clusterId,
  onExpand,
  onClose,
}: {
  id: string;
  item: MapNodeItem;
  map: MapData;
  clusterId: string;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { links } = useUiEnv();
  const o = useContext(OverlayContext);
  const name = (key: string) => map.components.find((c) => c.key === key)?.name ?? key;
  const folded = item.members.length > 1;
  const c = item.members[0]!;
  const service = map.domains.flatMap((d) => d.services.map((s) => ({ d, s }))).find((x) => x.s.id === c.service);
  const deps = map.edges.filter((e) => e.from === c.key);
  const users = map.edges.filter((e) => e.to === c.key);
  // 只被网络策略放行（置信度低于归并阈值）的组件只计数：观测与发布命名空间放行访问的组件动辄几十个
  const listed = (list: typeof deps, end: 'from' | 'to') => {
    const named = list
      .filter((e) => e.confidence >= MERGE_CONFIDENCE)
      .map((e) => (e.provenance === 'declared' ? t('map.panel.declared', { name: name(e[end]) }) : name(e[end])));
    const allowed = list.length - named.length;
    return [...named, ...(allowed ? [t('map.panel.allowed', { n: allowed })] : [])].join('、') || '-';
  };
  const incidents = o.incidents.get(id) ?? [];
  const count = (r: Record<string, number>) =>
    Object.entries(r)
      .map(([k, n]) => `${k.split('.')[0]} ${n}`)
      .join(' · ') || '-';
  return (
    <SidePanel title={folded ? `${item.name} × ${item.members.length}` : item.name} onClose={onClose}>
      {!folded && <Mono className={canvasStyles.key}>{c.key}</Mono>}
      <dl className={canvasStyles.facts}>
        <dt>{t('map.panel.service')}</dt>
        <dd>
          {service
            ? `${localizedText(service.d.title, locale)} / ${localizedText(service.s.title, locale)}`
            : t('map.unassigned')}
        </dd>
        <dt>{t('map.panel.source')}</dt>
        <dd>{t(`map.source.${c.service_source}`)}</dd>
        <dt>{t('subgraph.panel.kind')}</dt>
        <dd>{[c.kind, c.namespace].filter(Boolean).join(' · ')}</dd>
        {!folded && (
          <>
            <dt>{t('map.panel.members')}</dt>
            <dd>{count(c.members)}</dd>
            <dt>{t('map.panel.attachments')}</dt>
            <dd>{count(c.attachments)}</dd>
            <dt>{t('map.panel.nodes')}</dt>
            <dd>{c.nodes.map((n) => n.slice(n.indexOf(':') + 1)).join('、') || t('map.panel.no_nodes')}</dd>
            <dt>{t('map.panel.depends_on')}</dt>
            <dd>{listed(deps, 'to')}</dd>
            <dt>{t('map.panel.used_by')}</dt>
            <dd>{listed(users, 'from')}</dd>
          </>
        )}
      </dl>
      <h4 className={canvasStyles.panelSub}>{t('map.panel.incidents', { n: incidents.length })}</h4>
      {incidents.length ? (
        <ul className={canvasStyles.alerts}>
          {incidents.map((i) => (
            <li key={i.incident_id}>
              <AppLink href={links.incident(i.label)} className={canvasStyles.link}>
                {i.headline?.alertname ?? i.label}
              </AppLink>{' '}
              <span className={styles.sev} data-tone={i.severity === 'critical' ? 'bad' : 'warn'}>
                {i.severity}
              </span>
              {i.placement === 'protects' && <span className={canvasStyles.none}> {t('map.panel.via_pdb')}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className={canvasStyles.none}>
          {o.tone.get(c.key) === 'hit' ? t('map.panel.hit') : t('map.panel.no_incidents')}
        </p>
      )}
      {folded ? (
        <>
          <button type="button" className={canvasStyles.tool} onClick={onExpand}>
            {t('subgraph.fold_expand')}
          </button>
          <ul className={canvasStyles.alerts}>
            {item.members.map((m) => (
              <li key={m.key} title={m.key}>
                {links.topology ? (
                  <AppLink href={links.topology(clusterId, m.key)} className={canvasStyles.link}>
                    {m.name}
                  </AppLink>
                ) : (
                  m.name
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        (links.topology || links.search) && (
          <nav className={canvasStyles.panelLinks} aria-label={t('subgraph.panel.links')}>
            {links.topology && (
              <AppLink href={links.topology(clusterId, c.key)} className={canvasStyles.link}>
                {t('subgraph.panel.open_neighborhood')}
              </AppLink>
            )}
            {links.search && (
              <AppLink href={links.search(c.key, clusterId)} className={canvasStyles.link}>
                {t('subgraph.panel.search_incidents')}
              </AppLink>
            )}
          </nav>
        )
      )}
    </SidePanel>
  );
}
