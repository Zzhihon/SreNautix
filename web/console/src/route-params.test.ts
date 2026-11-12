import { describe, expect, it } from 'vitest';
import { searchHref, topologyHref, topologySearch } from './route-params';
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

  it('搜索链接带上集群与组件键', () => {
    const href = searchHref('Deployment:app/gateway', 'prod');
    expect(href.startsWith('/search?')).toBe(true);
    expect(parseSearch(href.slice('/search'.length))).toEqual({ cluster: 'prod', q: 'Deployment:app/gateway' });
  });
});
