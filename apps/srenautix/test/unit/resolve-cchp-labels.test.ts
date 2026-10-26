import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AlertCatalog } from '@srenautix/core';
import { describe, expect, it } from 'vitest';
import { resolveAlert, type NodeLookup } from '../../src/alerts/resolve.js';
import { fingerprint, type RawAlert } from '../../src/ingest/normalize.js';

/**
 * server 的告警解析用 CCHP 影子环境的真实标签回归（packages/core/test/testdata/cchp-alert-labels.json）：
 * 实体的 kind 是规范写法、集群级对象没有命名空间，查找拓扑用的就是拓扑里的键；按标签分类的告警照样带上实体。
 */
const F = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../packages/core/test/testdata/cchp-alert-labels.json'), 'utf8'),
) as {
  alerts: Array<{
    alertname: string;
    labels: Record<string, string>;
    expect: { kind: string; namespace: string | null; name: string; key: string; fromLabels: boolean };
  }>;
};

const raw = (labels: Record<string, string>): RawAlert => ({
  source: 'reconcile',
  labels,
  annotations: {},
  severity: 'warning',
  status: 'firing',
  suppressed: 'none',
  startsAt: new Date(),
  endsAt: null,
  generatorUrl: null,
  fingerprint: fingerprint(labels),
  alertname: labels.alertname!,
  alertmanagerSeenAt: null,
});

/** 拓扑里只有节点 storage-01 与 storage-03、Pod observability/alloy-n6r72 */
const TOPOLOGY = new Set(['Node:storage-01', 'Node:storage-03', 'Pod:observability/alloy-n6r72']);
const lookups: string[] = [];
const nodes: NodeLookup = {
  async find(_c, kind, namespace, name) {
    const key = namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`;
    lookups.push(key);
    return TOPOLOGY.has(key) ? { key, uid: `uid-${name}`, tombstone: false } : null;
  },
};

const deps = {
  catalog: new AlertCatalog([]),
  nodes,
  ksm: null,
  ruleExpr: () => undefined,
  chronic: () => false,
};

describe('CCHP 真实告警标签的解析', () => {
  it.each(F.alerts.map((a) => [a.alertname, a] as const))('%s', async (_n, a) => {
    lookups.length = 0;
    const r = await resolveAlert('cchp', raw(a.labels), deps);
    // 查找拓扑用的是规范的 kind 与命名空间
    expect(lookups[0]).toBe(
      a.expect.namespace
        ? `${a.expect.kind}:${a.expect.namespace}/${a.expect.name}`
        : `${a.expect.kind}:${a.expect.name}`,
    );
    if (TOPOLOGY.has(lookups[0]!) || a.expect.fromLabels) {
      // 标签契约给出的实体即使拓扑里没有也保留（领域包的自定义 kind 按它执行证据卡）
      expect(r.entity).toMatchObject({ kind: a.expect.kind, namespace: a.expect.namespace, name: a.expect.name });
      expect(r.component).toBe(a.expect.key);
    } else {
      // 只按标签推断出的实体必须在拓扑中找到
      expect(r.entity).toBeNull();
    }
    if (a.labels.role) {
      expect(r.classification).toMatchObject({ role: a.labels.role, source: 'label' });
    }
  });

  it('没有对象也没有命名空间：component 标签与 service 标签归入逻辑组件；有命名空间时仍归命名空间伪组件', async () => {
    const only = async (labels: Record<string, string>) =>
      (await resolveAlert('cchp', raw({ alertname: 'X', severity: 'warning', ...labels }), deps)).component;
    expect(await only({ component: 'release' })).toBe('component:release');
    // Kind 的 unmapped-alert：ShopCatalogStale 只带 service="catalog"
    expect(await only({ service: 'catalog' })).toBe('component:catalog');
    // component 标签优先于 service
    expect(await only({ component: 'release', service: 'catalog' })).toBe('component:release');
    // 带命名空间的服务级告警仍归命名空间伪组件（抓取目标的 service 标签不当作逻辑组件）
    expect(await only({ service: 'kube-state-metrics', namespace: 'monitoring' })).toBe('Namespace:monitoring');
    expect(await only({})).toBeNull();
  });

  it('节点告警带着抓取目标的命名空间：实体是 Node:storage-01，在拓扑中找到', async () => {
    const node = F.alerts.find((a) => a.alertname === 'NodeRootFilesystemFillForecast')!;
    expect(node.labels.namespace).toBe('observability');
    const r = await resolveAlert('cchp', raw(node.labels), deps);
    expect(r).toMatchObject({
      entity: { kind: 'Node', namespace: null, name: 'storage-01', uid: 'uid-storage-01' },
      entityResolution: 'labels',
      component: 'Node:storage-01',
    });
  });
});
