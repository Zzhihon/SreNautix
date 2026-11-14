// 全集群地图的画法（ADR 0199）：GET /v1/topology/map 的结构加上事件，整理成要画的框与节点。纯函数，布局与渲染在 ClusterMap.tsx。
// 业务领域 → 服务 → 组件；没有归属的组件放进"未归属"领域，按命名空间分组。同一服务里类型、命名空间、名称词干与连接都相同、
// 没有事件根因的组件合并（三个控制面节点上的同名静态 Pod、每次运行一个的 Workflow）。
// 边分三档（ADR 0205）：核心链路（默认画出）、全部依赖（不低于 τ）、网络策略放行；组件按角色（入口、服务、数据、任务、静态 Pod）区分颜色。

import type { ClusterMap, MapChange } from '../contract';

type MapComponent = ClusterMap['components'][number];
type MapIncident = ClusterMap['incidents'][number];

/** 同类组件达到这个数量才合并：控制面与有状态服务常见 3 副本，地图比邻域图（4）更早合并 */
export const MAP_FOLD_MIN = 3;
/**
 * 受影响只沿置信度不低于它的依赖边传播：网络策略推断的边（0.6）只说明流量被允许，不说明依赖，
 * 沿它传播会把同一命名空间里互相放行的组件都标成受影响
 */
export const BLAST_MIN_CONFIDENCE = 0.7;
/** 归并阈值 τ：低于它的边只说明流量被放行（ADR 0200） */
export const MERGE_CONFIDENCE = 0.6;
/**
 * 被至少这么多个服务引用的组件是共享的汇（指标库、OTel Collector）：指向它的边不进核心链路，组件上标出引用它的服务数。
 * 参考部署上 vmsingle 被 7 个服务引用，OTel Collector 4 个；业务链路上的 PostgreSQL、Dragonfly、NATS 由领域包声明，声明的边不受影响
 */
export const SINK_MIN_SERVICES = 4;
/**
 * 核心链路从这些档次的业务领域出发（核心、支撑），不指向运维自身（self）的领域：业务组件上报指标、日志与链路不是业务链路。
 * 领域包没有声明领域时不按档次筛选
 */
const CORE_TIERS: ReadonlySet<string> = new Set(['core', 'supporting']);
const SELF_TIER = 'self';
/** 没有业务领域的组件所在的领域 id */
export const UNASSIGNED = '';

export type Tone = 'bad' | 'warn' | 'hit';

/** 地图上标出的变更：所看时刻之前这么久之内的变更（ADR 0206） */
export const CHANGE_WINDOW_MS = 60 * 60_000;
/** 变更按用途分组，决定时间轴与地图上的颜色：发布、配置、容量（扩缩、cordon）、其他（退役等） */
export type ChangeGroup = 'release' | 'config' | 'capacity' | 'other';
export const CHANGE_GROUPS: readonly ChangeGroup[] = ['release', 'config', 'capacity', 'other'];
const GROUP_OF: Record<MapChange['kind'], ChangeGroup> = {
  rollout: 'release',
  ci_deploy: 'release',
  gitops_sync: 'release',
  operator: 'release',
  config: 'config',
  runtime_config: 'config',
  scale: 'capacity',
  cordon: 'capacity',
  retire: 'other',
  other: 'other',
};
export const changeGroup = (kind: MapChange['kind']): ChangeGroup => GROUP_OF[kind];

/**
 * 时刻 at 之前 CHANGE_WINDOW_MS 之内的变更，按地图上的位置（组件键或节点键）分组，最新的在前。
 * 同时找出"变更之后出了事件"的位置：变更早于落在这里的某个事件的首次触发
 */
export function recentChanges(
  changes: readonly MapChange[],
  incidents: readonly ClusterMap['incidents'][number][],
  at: number,
): { byComponent: ReadonlyMap<string, MapChange[]>; suspects: ReadonlySet<string> } {
  const byComponent = new Map<string, MapChange[]>();
  for (const c of changes) {
    const t = Date.parse(c.time);
    if (t > at || t <= at - CHANGE_WINDOW_MS) {
      continue;
    }
    for (const k of c.components) {
      byComponent.set(k, [c, ...(byComponent.get(k) ?? [])]);
    }
  }
  const suspects = new Set<string>();
  for (const i of incidents) {
    const first = Date.parse(i.first_firing_at);
    if (i.component && byComponent.get(i.component)?.some((c) => Date.parse(c.time) <= first)) {
      suspects.add(i.component);
    }
  }
  return { byComponent, suspects };
}

/** 边的种类，决定颜色与线型：declared 领域包声明，route 路由入口，reference 配置引用，allowed 网络策略放行 */
export type EdgeKind = 'declared' | 'route' | 'reference' | 'allowed';
/** 画边的档位：core 核心链路，deps 全部依赖（不低于 τ），allowed 再加上只被网络策略放行的边 */
export type EdgeLevel = 'core' | 'deps' | 'allowed';
export const EDGE_LEVELS: readonly EdgeLevel[] = ['core', 'deps', 'allowed'];
/** 组件的角色：entry 路由入口，service 常驻服务，data 带持久卷或有状态的组件，batch 一次性任务，node 静态 Pod */
export type ComponentRole = 'entry' | 'service' | 'data' | 'batch' | 'node';

type MapEdge = ClusterMap['edges'][number];
export interface EdgeClass {
  kind: EdgeKind;
  level: EdgeLevel;
}

const KIND_RANK: Record<EdgeKind, number> = { declared: 0, route: 1, reference: 2, allowed: 3 };
const LEVEL_RANK: Record<EdgeLevel, number> = { core: 0, deps: 1, allowed: 2 };
/** 档位 level 下画出这条边（低档的边在高档里都画） */
export const shownAt = (edge: EdgeLevel, level: EdgeLevel) => LEVEL_RANK[edge] <= LEVEL_RANK[level];
const edgeKey = (from: string, to: string) => `${from}\0${to}`;

export function edgeKind(e: Pick<MapEdge, 'provenance' | 'relations'>): EdgeKind {
  if (e.provenance === 'declared') {
    return 'declared';
  }
  if (e.relations.includes('routes_to')) {
    return 'route';
  }
  return e.provenance === 'network_policy' ? 'allowed' : 'reference';
}

/**
 * 每条边的种类与档位，以及共享的汇（ADR 0205）。核心链路是：领域包声明的依赖、路由入口，以及从核心与支撑领域出发、
 * 不指向运维自身领域与共享汇、置信度不低于 BLAST_MIN_CONFIDENCE 的配置引用；再去掉能由其余核心边经别的组件到达的边（传递约简），
 * 只留下链路本身。网络策略推出的边不进核心链路，低于 τ 的边只在"网络放行"档画出。
 */
export function classifyEdges(map: Pick<ClusterMap, 'domains' | 'components' | 'edges'>): {
  edges: ReadonlyMap<string, EdgeClass>;
  /** 共享汇的组件键 → 引用它的服务数 */
  sinks: ReadonlyMap<string, number>;
} {
  const byKey = new Map(map.components.map((c) => [c.key, c]));
  const serviceOf = (k: string) => {
    const c = byKey.get(k);
    return c?.service ?? `ns:${c?.namespace ?? '-'}`;
  };
  const tierOf = new Map<string, string>();
  for (const d of map.domains) {
    for (const s of d.services) {
      tierOf.set(s.id, d.tier);
    }
  }
  const fanIn = new Map<string, Set<string>>();
  for (const e of map.edges) {
    if (e.confidence >= MERGE_CONFIDENCE) {
      fanIn.set(e.to, (fanIn.get(e.to) ?? new Set()).add(serviceOf(e.from)));
    }
  }
  const sinks = new Map<string, number>();
  for (const [k, s] of fanIn) {
    if (s.size >= SINK_MIN_SERVICES) {
      sinks.set(k, s.size);
    }
  }
  const out = new Map<string, EdgeClass>();
  const core: MapEdge[] = [];
  for (const e of map.edges) {
    const kind = edgeKind(e);
    const tier = (k: string) => tierOf.get(byKey.get(k)?.service ?? '');
    const business = tierOf.size === 0 || (CORE_TIERS.has(tier(e.from) ?? '') && tier(e.to) !== SELF_TIER);
    const isCore =
      kind === 'declared' ||
      kind === 'route' ||
      (kind === 'reference' && e.confidence >= BLAST_MIN_CONFIDENCE && business && !sinks.has(e.to));
    if (isCore) {
      core.push(e);
    }
    out.set(edgeKey(e.from, e.to), {
      kind,
      level: isCore ? 'core' : e.confidence >= MERGE_CONFIDENCE ? 'deps' : 'allowed',
    });
  }
  // 传递约简：from 经别的核心边也能到达 to 时，这条边不是链路的一环；声明的边与入口保留
  const next = new Map<string, string[]>();
  for (const e of core) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const reachable = (from: string, to: string, skip: string) => {
    const seen = new Set([from]);
    const stack = (next.get(from) ?? []).filter((x) => x !== skip);
    while (stack.length) {
      const x = stack.pop()!;
      if (x === to) {
        return true;
      }
      if (!seen.has(x)) {
        seen.add(x);
        stack.push(...(next.get(x) ?? []));
      }
    }
    return false;
  };
  for (const e of core) {
    const c = out.get(edgeKey(e.from, e.to))!;
    if (c.kind === 'reference' && reachable(e.from, e.to, e.to)) {
      c.level = 'deps';
    }
  }
  return { edges: out, sinks };
}

const BATCH_KINDS: ReadonlySet<string> = new Set(['Job', 'CronJob', 'Workflow', 'CronWorkflow']);

/**
 * 组件的角色：有路由出边的是入口；一次性任务、静态 Pod 按类型；有状态（StatefulSet 或持久卷）而且除共享汇外不依赖别的组件的是数据；
 * 其余是服务。参考部署的网关是带临时卷的 StatefulSet，但它依赖数据库，所以是服务
 */
export function componentRole(
  c: MapComponent,
  entries: ReadonlySet<string>,
  dependsOnOthers: ReadonlySet<string>,
): ComponentRole {
  const kind = c.kind.split('.')[0]!;
  if (entries.has(c.key)) {
    return 'entry';
  }
  if (BATCH_KINDS.has(kind)) {
    return 'batch';
  }
  if (kind === 'Pod') {
    return 'node';
  }
  const has = (k: string) => (c.members[k] ?? 0) > 0 || (c.attachments[k] ?? 0) > 0;
  const stateful = kind === 'StatefulSet' || has('PersistentVolumeClaim') || has('StatefulSet');
  return stateful && !dependsOnOthers.has(c.key) ? 'data' : 'service';
}

export interface MapNodeItem {
  id: string;
  /** 合并的组有多个成员；单个组件只有它自己 */
  members: MapComponent[];
  /** 合并的组显示词干，单个组件显示名称 */
  name: string;
  kind: string;
  namespace: string | null;
  role: ComponentRole;
  /** 共享汇：引用它的服务数（ADR 0205）；不是汇时没有 */
  sinkServices?: number;
}

/** 画布上两个节点之间的边：合并的组之间去重，取最低的档位、最强的种类与最高的置信度 */
export interface MapModelEdge extends EdgeClass {
  from: string;
  to: string;
  confidence: number;
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
  edges: MapModelEdge[];
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
  const classes = classifyEdges(map);
  const entries = new Set(map.edges.filter((e) => edgeKind(e) === 'route').map((e) => e.from));
  const upstream = new Set(
    map.edges.filter((e) => e.confidence >= MERGE_CONFIDENCE && !classes.sinks.has(e.to)).map((e) => e.from),
  );
  const facts = (c: MapComponent) => ({
    role: componentRole(c, entries, upstream),
    sinkServices: classes.sinks.get(c.key),
  });
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
        out.push({ id, members, name: nameStem(first), kind: first.kind, namespace: first.namespace, ...facts(first) });
        members.forEach((m) => nodeOf.set(m.key, id));
      } else {
        for (const c of members) {
          out.push({ id: c.key, members: [c], name: c.name, kind: c.kind, namespace: c.namespace, ...facts(c) });
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
  const merged = new Map<string, MapModelEdge>();
  for (const e of map.edges) {
    const from = nodeOf.get(e.from);
    const to = nodeOf.get(e.to);
    if (!from || !to || from === to) {
      continue;
    }
    const c = classes.edges.get(edgeKey(e.from, e.to))!;
    const seen = merged.get(edgeKey(from, to));
    if (!seen) {
      merged.set(edgeKey(from, to), { from, to, ...c, confidence: e.confidence });
      continue;
    }
    if (LEVEL_RANK[c.level] < LEVEL_RANK[seen.level]) {
      seen.level = c.level;
    }
    if (KIND_RANK[c.kind] < KIND_RANK[seen.kind]) {
      seen.kind = c.kind;
    }
    seen.confidence = Math.max(seen.confidence, e.confidence);
  }
  return { domains, edges: [...merged.values()], nodeOf };
}

/**
 * 事件叠加：落在组件上的事件按严重度给组件着色；沿依赖边反向能到达根因的组件（依赖它的组件）标为受影响（只走
 * BLAST_MIN_CONFIDENCE 以上的边）。只有根因本身（root）或按名称认出的根因（named）向外传播：经 PodDisruptionBudget
 * 定位的事件（protects）只说明保护对象不能再中断，节点上的事件（node）放在节点条上，两者都只给自己的位置着色（ADR 0203）。
 * 落在节点上或放不到地图上的事件按主服务计入服务框。
 */
export function incidentOverlay(
  map: Pick<ClusterMap, 'components' | 'edges'>,
  incidents: readonly MapIncident[],
): {
  tone: ReadonlyMap<string, Tone>;
  byComponent: ReadonlyMap<string, MapIncident[]>;
  byService: ReadonlyMap<string, MapIncident[]>;
  byNode: ReadonlyMap<string, MapIncident[]>;
  nodeTone: ReadonlyMap<string, Tone>;
} {
  const tone = new Map<string, Tone>();
  const byComponent = new Map<string, MapIncident[]>();
  const byService = new Map<string, MapIncident[]>();
  const byNode = new Map<string, MapIncident[]>();
  const nodeTone = new Map<string, Tone>();
  const serviceOf = new Map(map.components.map((c) => [c.key, c.service]));
  const seeds: string[] = [];
  const mark = (list: Map<string, MapIncident[]>, tones: Map<string, Tone>, key: string, i: MapIncident) => {
    list.set(key, [...(list.get(key) ?? []), i]);
    if (tones.get(key) !== 'bad') {
      tones.set(key, i.severity === 'critical' ? 'bad' : 'warn');
    }
  };
  for (const i of incidents) {
    if (i.component && i.placement === 'node') {
      mark(byNode, nodeTone, i.component, i);
    } else if (i.component) {
      mark(byComponent, tone, i.component, i);
      if (i.placement !== 'protects') {
        seeds.push(i.component);
      }
    }
    const s = i.component && serviceOf.has(i.component) ? serviceOf.get(i.component)! : i.service;
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
  const queue = [...new Set(seeds)];
  while (queue.length) {
    for (const d of dependents.get(queue.pop()!) ?? []) {
      if (!tone.has(d)) {
        tone.set(d, 'hit');
        queue.push(d);
      }
    }
  }
  return { tone, byComponent, byService, byNode, nodeTone };
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
