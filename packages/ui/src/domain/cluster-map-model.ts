// 全集群地图的画法（ADR 0199）：GET /v1/topology/map 的结构加上事件，整理成要画的框与节点。纯函数，布局与渲染在 ClusterMap.tsx。
// 业务领域 → 服务 → 组件；没有归属的组件放进"未归属"领域，按命名空间分组。同一服务里类型、命名空间、名称词干与连接都相同、
// 没有事件根因的组件合并（三个控制面节点上的同名静态 Pod、每次运行一个的 Workflow）。

import type { ClusterMap } from '../contract';

type MapComponent = ClusterMap['components'][number];
type MapIncident = ClusterMap['incidents'][number];

/** 同类组件达到这个数量才合并：控制面与有状态服务常见 3 副本，地图比邻域图（4）更早合并 */
export const MAP_FOLD_MIN = 3;
/**
 * 受影响只沿置信度不低于它的依赖边传播：网络策略推断的边（0.6）只说明流量被允许，不说明依赖，
 * 沿它传播会把同一命名空间里互相放行的组件都标成受影响
 */
export const BLAST_MIN_CONFIDENCE = 0.7;
/** 没有业务领域的组件所在的领域 id */
export const UNASSIGNED = '';

export type Tone = 'bad' | 'warn' | 'hit';

export interface MapNodeItem {
  id: string;
  /** 合并的组有多个成员；单个组件只有它自己 */
  members: MapComponent[];
  /** 合并的组显示词干，单个组件显示名称 */
  name: string;
  kind: string;
  namespace: string | null;
}

export interface MapService {
  /** 画布上的 id：s:<服务 id>，没有归属时 s:ns:<命名空间> */
  id: string;
  service: string | null;
  namespace: string | null;
  items: MapNodeItem[];
}

export interface MapDomain {
  /** 画布上的 id：d:<领域 id> */
  id: string;
  domain: string;
  services: MapService[];
}

export interface MapModel {
  domains: MapDomain[];
  /** 画布上的节点之间的边，合并的组之间去重 */
  edges: Array<{ from: string; to: string }>;
  /** 组件键 → 画布上的节点 id */
  nodeOf: ReadonlyMap<string, string>;
}

/** 名称去掉副本、节点与运行编号的后缀：kube-apiserver-control-plane-01、cchp-discover-1794488820、instance-manager-<哈希> */
export function nameStem(c: Pick<MapComponent, 'name' | 'nodes'>): string {
  for (const n of c.nodes) {
    const node = n.slice(n.indexOf(':') + 1);
    if (c.name.endsWith(`-${node}`)) {
      return c.name.slice(0, -node.length - 1);
    }
  }
  return c.name.replace(
    /-(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,}|[0-9]{5,}|(?=[a-z]*[0-9])[a-z0-9]{5})$/,
    '',
  );
}

export function buildMapModel(
  map: Pick<ClusterMap, 'domains' | 'components' | 'edges'>,
  opts: {
    fold: boolean;
    expanded: ReadonlySet<string>;
    keep?: (c: MapComponent) => boolean;
    roots: ReadonlySet<string>;
  },
): MapModel {
  const keep = opts.keep ?? (() => true);
  const links = new Map<string, string[]>();
  for (const e of map.edges) {
    links.set(e.from, [...(links.get(e.from) ?? []), `>${e.to}`]);
    links.set(e.to, [...(links.get(e.to) ?? []), `<${e.from}`]);
  }
  const byService = new Map<string, MapComponent[]>();
  for (const c of map.components) {
    if (!keep(c)) {
      continue;
    }
    const sid = c.service ?? `ns:${c.namespace ?? '-'}`;
    byService.set(sid, [...(byService.get(sid) ?? []), c]);
  }
  const nodeOf = new Map<string, string>();
  const itemsOf = (list: MapComponent[]): MapNodeItem[] => {
    const alike = new Map<string, MapComponent[]>();
    for (const c of list) {
      const key = opts.roots.has(c.key)
        ? `root\0${c.key}`
        : [c.kind, c.namespace ?? '', nameStem(c), ...(links.get(c.key) ?? []).sort()].join('\0');
      alike.set(key, [...(alike.get(key) ?? []), c]);
    }
    const out: MapNodeItem[] = [];
    for (const members of alike.values()) {
      const first = members[0] as MapComponent;
      const id = `fold:${first.key}`;
      if (opts.fold && members.length >= MAP_FOLD_MIN && !opts.expanded.has(id)) {
        out.push({ id, members, name: nameStem(first), kind: first.kind, namespace: first.namespace });
        members.forEach((m) => nodeOf.set(m.key, id));
      } else {
        for (const c of members) {
          out.push({ id: c.key, members: [c], name: c.name, kind: c.kind, namespace: c.namespace });
          nodeOf.set(c.key, c.key);
        }
      }
    }
    return out;
  };
  const domains: MapDomain[] = [];
  for (const d of map.domains) {
    const services = d.services
      .filter((s) => byService.has(s.id))
      .map((s) => ({ id: `s:${s.id}`, service: s.id, namespace: null, items: itemsOf(byService.get(s.id)!) }));
    if (services.length) {
      domains.push({ id: `d:${d.id}`, domain: d.id, services });
    }
  }
  const loose = [...byService.keys()].filter((k) => k.startsWith('ns:')).sort();
  if (loose.length) {
    domains.push({
      id: `d:${UNASSIGNED}`,
      domain: UNASSIGNED,
      services: loose.map((k) => ({
        id: `s:${k}`,
        service: null,
        namespace: k.slice(3),
        items: itemsOf(byService.get(k)!),
      })),
    });
  }
  const seen = new Set<string>();
  const edges: MapModel['edges'] = [];
  for (const e of map.edges) {
    const from = nodeOf.get(e.from);
    const to = nodeOf.get(e.to);
    if (from && to && from !== to && !seen.has(`${from}\0${to}`)) {
      seen.add(`${from}\0${to}`);
      edges.push({ from, to });
    }
  }
  return { domains, edges, nodeOf };
}

/**
 * 事件叠加：根因组件按严重度着色；沿依赖边反向能到达根因的组件（依赖它的组件）标为受影响（只走 BLAST_MIN_CONFIDENCE 以上的边）。
 * 根因不在地图上的事件按主服务计入服务框。
 */
export function incidentOverlay(
  map: Pick<ClusterMap, 'components' | 'edges'>,
  incidents: readonly MapIncident[],
): {
  tone: ReadonlyMap<string, Tone>;
  byComponent: ReadonlyMap<string, MapIncident[]>;
  byService: ReadonlyMap<string, MapIncident[]>;
} {
  const tone = new Map<string, Tone>();
  const byComponent = new Map<string, MapIncident[]>();
  const byService = new Map<string, MapIncident[]>();
  const serviceOf = new Map(map.components.map((c) => [c.key, c.service]));
  for (const i of incidents) {
    if (i.component) {
      byComponent.set(i.component, [...(byComponent.get(i.component) ?? []), i]);
      if (tone.get(i.component) !== 'bad') {
        tone.set(i.component, i.severity === 'critical' ? 'bad' : 'warn');
      }
    }
    const s = i.component ? (serviceOf.get(i.component) ?? null) : i.service;
    if (s) {
      byService.set(s, [...(byService.get(s) ?? []), i]);
    }
  }
  const dependents = new Map<string, string[]>();
  for (const e of map.edges) {
    if (e.confidence >= BLAST_MIN_CONFIDENCE) {
      dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);
    }
  }
  const queue = [...byComponent.keys()];
  while (queue.length) {
    for (const d of dependents.get(queue.pop()!) ?? []) {
      if (!tone.has(d)) {
        tone.set(d, 'hit');
        queue.push(d);
      }
    }
  }
  return { tone, byComponent, byService };
}

/** 合并的组取成员中最重的状态 */
export function worstTone(tones: ReadonlyArray<Tone | undefined>): Tone | undefined {
  return tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : tones.includes('hit') ? 'hit' : undefined;
}

export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 父框的 id；坐标相对父框（与 xyflow 的 parentId 相同） */
  parent?: string;
}

/** 组件节点与框的尺寸（像素），与 ClusterMap.module.css 一致 */
export const PACK = {
  itemW: 184,
  itemH: 46,
  gap: 10,
  servicePad: 8,
  serviceHead: 24,
  domainPad: 10,
  domainHead: 32,
  laneGap: 28,
};

const TIER_ORDER = ['core', 'supporting', 'foundation', 'self'];

/**
 * 确定的排布（ADR 0199 §3）：服务框里组件按名称排成网格，服务框在领域框里上下叠放；领域框按重要程度（核心、支撑、底座、
 * 运维自身，未归属最后）依次填进若干列，列数取外框最接近 16:10 的。同一结构每次得到同样的位置，值班的人能记住位置。
 */
export function packMap(model: MapModel, tierOf: (domain: string) => string | undefined): Map<string, Placed> {
  const P = PACK;
  const out = new Map<string, Placed>();
  const domains = model.domains
    .map((d, i) => ({
      d,
      i,
      tier: d.domain === UNASSIGNED ? TIER_ORDER.length : TIER_ORDER.indexOf(tierOf(d.domain) ?? ''),
    }))
    .sort((a, b) => (a.tier < 0 ? 99 : a.tier) - (b.tier < 0 ? 99 : b.tier) || a.i - b.i)
    .map((x) => x.d);
  const sized = domains.map((d) => {
    let w = 0;
    let h = P.domainHead;
    const services = d.services.map((s) => {
      const n = s.items.length;
      const cols = n > 12 ? 4 : Math.min(3, Math.ceil(Math.sqrt(n)));
      const rows = Math.ceil(n / cols);
      const sw = P.servicePad * 2 + cols * P.itemW + (cols - 1) * P.gap;
      const sh = P.serviceHead + P.servicePad + rows * P.itemH + (rows - 1) * P.gap;
      const items = [...s.items].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      items.forEach((it, i) =>
        out.set(it.id, {
          x: P.servicePad + (i % cols) * (P.itemW + P.gap),
          y: P.serviceHead + Math.floor(i / cols) * (P.itemH + P.gap),
          w: P.itemW,
          h: P.itemH,
          parent: s.id,
        }),
      );
      const placed = { id: s.id, y: h, w: sw, h: sh };
      w = Math.max(w, sw);
      h += sh + P.gap;
      return placed;
    });
    return { d, services, w: w + P.domainPad * 2, h: h - P.gap + P.domainPad };
  });
  // 列数：外框最接近 16:10；每列按顺序填到目标高度为止
  const total = sized.reduce((n, s) => n + s.h + P.laneGap, 0);
  let best: { cols: (typeof sized)[]; score: number } | undefined;
  for (let k = 1; k <= Math.min(6, sized.length); k++) {
    const target = Math.max(total / k, ...sized.map((s) => s.h));
    const cols: (typeof sized)[] = [[]];
    let height = 0;
    for (const s of sized) {
      if (height > 0 && height + s.h > target && cols.length < k) {
        cols.push([]);
        height = 0;
      }
      cols[cols.length - 1]!.push(s);
      height += s.h + P.laneGap;
    }
    const W = cols.reduce((n, c) => n + Math.max(...c.map((s) => s.w)) + P.laneGap, 0);
    const H = Math.max(...cols.map((c) => c.reduce((n, s) => n + s.h + P.laneGap, 0)));
    const score = Math.abs(Math.log(W / H / 1.6));
    if (!best || score < best.score) {
      best = { cols, score };
    }
  }
  let x = 0;
  for (const col of best?.cols ?? []) {
    const cw = Math.max(...col.map((s) => s.w));
    let y = 0;
    for (const s of col) {
      out.set(s.d.id, { x, y, w: cw, h: s.h });
      for (const sv of s.services) {
        out.set(sv.id, { x: P.domainPad, y: sv.y, w: cw - P.domainPad * 2, h: sv.h, parent: s.d.id });
      }
      y += s.h + P.laneGap;
    }
    x += cw + P.laneGap;
  }
  return out;
}
