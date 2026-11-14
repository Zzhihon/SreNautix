// 路由 search 参数的校验与链接地址。search 参数全部可选：链接只需写出要改的字段，默认值由页面补齐，URL 保持简短。

import { stringifySearch } from './search';

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const maybeOneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

export const TOPOLOGY_VIEWS = ['map', 'coverage', 'neighborhood', 'diff'] as const;
export type TopologyView = (typeof TOPOLOGY_VIEWS)[number];

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
  };
}

/** 全集群地图（拓扑页的默认视图），可以对准一个业务领域 */
export function clusterMapHref(cluster: string, domain?: string): string {
  return `/topology${stringifySearch({ cluster, domain })}`;
}

/** 以某个组件为中心的拓扑邻域 */
export function topologyHref(cluster: string, component: string): string {
  return `/topology${stringifySearch({ cluster, view: 'neighborhood', component })}`;
}

/** 按关键词搜索事件（/v1/search 按事件标签与根因组件匹配） */
export function searchHref(q: string, cluster: string): string {
  return `/search${stringifySearch({ cluster, q })}`;
}
