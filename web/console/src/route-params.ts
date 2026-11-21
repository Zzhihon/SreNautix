// 路由 search 参数的校验与链接地址。search 参数全部可选：链接只需写出要改的字段，默认值由页面补齐，URL 保持简短。

import { stringifySearch } from './search';

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const maybeOneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

export const TOPOLOGY_VIEWS = ['map', 'coverage', 'neighborhood', 'diff'] as const;
export type TopologyView = (typeof TOPOLOGY_VIEWS)[number];

export const REPLAY_SPANS = ['24h', '3d', '7d'] as const;
export type ReplaySpan = (typeof REPLAY_SPANS)[number];

export const REPLAY_SPAN_MS: Record<ReplaySpan, number> = {
  '24h': 24 * 3600_000,
  '3d': 3 * 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
};

const SPAN_RANK: Record<ReplaySpan, number> = { '24h': 0, '3d': 1, '7d': 2 };

/** 按目标时刻距今的时长决定回放时间轴所需的最小跨度（ADR 0208）：24 小时内用 24h，3 天内用 3d，更早用 7d */
export function defaultReplaySpan(at: string | undefined, nowMs = Date.now()): ReplaySpan {
  if (!at) {
    return '24h';
  }
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) {
    return '24h';
  }
  const age = nowMs - ms;
  if (age <= REPLAY_SPAN_MS['24h']) {
    return '24h';
  }
  if (age <= REPLAY_SPAN_MS['3d']) {
    return '3d';
  }
  return '7d';
}

export function widerReplaySpan(a: ReplaySpan, b: ReplaySpan): ReplaySpan {
  return SPAN_RANK[a] >= SPAN_RANK[b] ? a : b;
}

export interface TopologySearch {
  cluster?: string;
  view?: TopologyView;
  /** 邻域视图的中心组件键（ADR 0191）：输入框提交与子图节点双击都写进这里，刷新和分享后仍然打开同一个邻域 */
  component?: string;
  /** 邻域只画 1 跳（ADR 0197）；不写时是 2 跳 */
  hops?: 1;
  /** 全集群地图初次显示时对准的业务领域（ADR 0199） */
  domain?: string;
  /** 地图回放的时刻（ADR 0205）；不写时是现在 */
  at?: string;
  /** 地图回放时间轴的跨度（ADR 0208）；不写时按 at 自动选择（默认 24h） */
  span?: ReplaySpan;
}

const isoTime = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
};

export function topologySearch(s: Record<string, unknown>): TopologySearch {
  return {
    cluster: str(s.cluster),
    view: maybeOneOf(s.view, TOPOLOGY_VIEWS),
    component: str(s.component),
    hops: s.hops === 1 || s.hops === '1' ? 1 : undefined,
    domain: str(s.domain),
    at: isoTime(s.at),
    span: maybeOneOf(s.span, REPLAY_SPANS),
  };
}

/** 全集群地图（拓扑页的默认视图），可以对准一个业务领域或历史回放时刻（ADR 0199、ADR 0208） */
export function clusterMapHref(cluster: string, domain?: string, at?: string): string {
  const validAt = isoTime(at);
  return `/topology${stringifySearch({ cluster, view: validAt ? 'map' : undefined, domain, at: validAt })}`;
}

/** 以某个组件为中心的拓扑邻域 */
export function topologyHref(cluster: string, component: string): string {
  return `/topology${stringifySearch({ cluster, view: 'neighborhood', component })}`;
}

/** 按关键词搜索事件（/v1/search 按事件标签与根因组件匹配） */
export function searchHref(q: string, cluster: string): string {
  return `/search${stringifySearch({ cluster, q })}`;
}
