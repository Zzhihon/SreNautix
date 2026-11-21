import { describe, expect, it } from 'vitest';
import {
  clusterMapHref,
  defaultReplaySpan,
  searchHref,
  topologyHref,
  topologySearch,
  widerReplaySpan,
} from './route-params';
import { parseSearch } from './search';

describe('拓扑页的 search 参数（ADR 0191）', () => {
  it('邻域的中心组件放在 component 参数里；空值与非字符串按没有处理', () => {
    expect(topologySearch({ cluster: 'prod', view: 'neighborhood', component: 'StatefulSet:db/pg-main' })).toEqual({
      cluster: 'prod',
      view: 'neighborhood',
      component: 'StatefulSet:db/pg-main',
    });
    expect(topologySearch({ cluster: 'prod', view: 'unknown', component: '' })).toEqual({
      cluster: 'prod',
      view: undefined,
      component: undefined,
    });
    expect(topologySearch({ component: 42 }).component).toBeUndefined();
  });

  it('邻域范围只记 1 跳（ADR 0197）：不写或写别的值都是默认的 2 跳', () => {
    expect(topologySearch({ hops: 1 }).hops).toBe(1);
    expect(topologySearch(parseSearch('?hops=1')).hops).toBe(1);
    for (const hops of [2, '2', 0, 'x', undefined]) {
      expect(topologySearch({ hops }).hops).toBeUndefined();
    }
  });

  it('子图侧栏的邻域链接经路由解析后回到同一个集群、视图与组件', () => {
    const key = 'postgres.cluster:db/pg-main';
    const href = topologyHref('prod', key);
    expect(href.startsWith('/topology?')).toBe(true);
    expect(topologySearch(parseSearch(href.slice('/topology'.length)))).toEqual({
      cluster: 'prod',
      view: 'neighborhood',
      component: key,
    });
  });

  it('全集群地图是默认视图，链接只写集群与要对准的业务领域（ADR 0199）', () => {
    expect(topologySearch({ view: 'map' }).view).toBe('map');
    const href = clusterMapHref('prod', 'forwarding');
    expect(href.startsWith('/topology?')).toBe(true);
    expect(topologySearch(parseSearch(href.slice('/topology'.length)))).toEqual({
      cluster: 'prod',
      view: undefined,
      component: undefined,
      hops: undefined,
      domain: 'forwarding',
    });
    expect(parseSearch(clusterMapHref('prod').slice('/topology'.length))).toEqual({ cluster: 'prod' });
  });

  it('搜索链接带上集群与组件键', () => {
    const href = searchHref('Deployment:app/gateway', 'prod');
    expect(href.startsWith('/search?')).toBe(true);
    expect(parseSearch(href.slice('/search'.length))).toEqual({ cluster: 'prod', q: 'Deployment:app/gateway' });
  });

  it('历史事件跳转到全集群地图发生时刻，并按时刻距今自动选择 24h / 3d / 7d 回放跨度（ADR 0208）', () => {
    const at = '2026-11-18T10:00:00Z';
    const href = clusterMapHref('cchp', 'forwarding', at);
    expect(topologySearch(parseSearch(href.slice('/topology'.length)))).toEqual({
      cluster: 'cchp',
      view: 'map',
      component: undefined,
      hops: undefined,
      domain: 'forwarding',
      at,
      span: undefined,
    });
    // 非法时间戳被忽略，回退为默认实时地图链接
    expect(clusterMapHref('cchp', 'forwarding', 'invalid')).toBe('/topology?cluster=cchp&domain=forwarding');

    expect(topologySearch({ span: '3d' }).span).toBe('3d');
    expect(topologySearch({ span: '7d' }).span).toBe('7d');
    expect(topologySearch({ span: '30d' }).span).toBeUndefined();

    const now = Date.parse('2026-11-22T00:00:00Z');
    const H = 3600_000;
    expect(defaultReplaySpan(undefined, now)).toBe('24h');
    expect(defaultReplaySpan(new Date(now - 6 * H).toISOString(), now)).toBe('24h');
    expect(defaultReplaySpan(new Date(now - 36 * H).toISOString(), now)).toBe('3d');
    expect(defaultReplaySpan(new Date(now - 5 * 24 * H).toISOString(), now)).toBe('7d');
    expect(widerReplaySpan('24h', '3d')).toBe('3d');
    expect(widerReplaySpan('7d', '24h')).toBe('7d');
  });
});
