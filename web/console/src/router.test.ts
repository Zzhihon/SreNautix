// 单集群默认选中的规则：拓扑页与集群选择器共用 resolveCluster。
// 只 import 纯函数；仓库的 console vitest 是 browser-mode（需要 Chromium），按其默认配置运行。

import { describe, expect, it } from 'vitest';
import { isPrimaryNavActive, isSecondaryRoute, resolveCluster } from './shell/Shell';

const c = (id: string) => ({ cluster_id: id });

describe('resolveCluster（单集群自动选中）', () => {
  it('只有一个集群且 URL 未指定时，默认选中该集群（不再用「全部集群」）', () => {
    expect(resolveCluster([c('prod')], undefined)).toBe('prod');
  });

  it('多个集群时保持「全部集群」默认（undefined），行为不变', () => {
    expect(resolveCluster([c('prod'), c('staging')], undefined)).toBeUndefined();
  });

  it('集群列表未加载或不为空数组时不擅自选择', () => {
    expect(resolveCluster(undefined, undefined)).toBeUndefined();
    expect(resolveCluster([], undefined)).toBeUndefined();
  });

  it('URL 上显式选择的集群始终优先，分享链接不被覆盖', () => {
    expect(resolveCluster([c('prod')], 'staging')).toBe('staging');
    expect(resolveCluster([c('prod'), c('staging')], 'prod')).toBe('prod');
    expect(resolveCluster(undefined, 'shared')).toBe('shared');
  });
});

describe('三视图导航与次级抽屉路由归属', () => {
  it('核心视图路径不触发系统抽屉自动展开，次级路径与深链自动展开', () => {
    for (const p of [
      '/',
      '/incidents',
      '/incidents/inc-1',
      '/runs/run-1',
      '/alerts',
      '/topology',
      '/eval',
      '/search',
    ]) {
      expect(isSecondaryRoute(p), p).toBe(false);
    }
    for (const p of [
      '/actions',
      '/actions/prop-1',
      '/health',
      '/clusters',
      '/clusters/cchp',
      '/integrations',
      '/packs',
      '/policies',
      '/models',
      '/audit',
      '/users',
      '/settings',
    ]) {
      expect(isSecondaryRoute(p), p).toBe(true);
    }
  });

  it('事件详情、研判运行与告警查找归入事件收件箱高亮', () => {
    expect(isPrimaryNavActive('/incidents', '/incidents')).toBe(true);
    expect(isPrimaryNavActive('/incidents', '/incidents/inc-42')).toBe(true);
    expect(isPrimaryNavActive('/incidents', '/runs/r-9')).toBe(true);
    expect(isPrimaryNavActive('/incidents', '/alerts')).toBe(true);
    expect(isPrimaryNavActive('/incidents', '/topology')).toBe(false);
    expect(isPrimaryNavActive('/topology', '/topology')).toBe(true);
    expect(isPrimaryNavActive('/eval', '/eval')).toBe(true);
  });
});
