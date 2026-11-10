import type { AlertCatalogEntry, ComponentType } from '@srenautix/contract';
import { AlertCatalog } from '@srenautix/core';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import { describe, expect, it } from 'vitest';
import { resolveAlert, type NodeLookup, type ResolveDeps } from '../../src/alerts/resolve.js';
import { alertService, type ServiceDeps } from '../../src/alerts/service.js';
import { fingerprint, type RawAlert } from '../../src/ingest/normalize.js';
import { ServerMetrics } from '../../src/metrics.js';

// 接入时一条告警的服务（ADR 0193 §3）：真实的告警解析 + 服务目录，拓扑与组件类型记录用内存替身

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

/** 拓扑：网关 Pod 属于 StatefulSet gateway；拓扑节点上记下的组件类型只有 StatefulSet 的 */
const OWNERS: Record<string, string> = { 'Pod:shop/gateway-0': 'StatefulSet:shop/gateway' };
const RECORDED_TYPES: Record<string, string> = { 'StatefulSet:shop/gateway': 'shop.gateway' };
const nodes: NodeLookup = {
  async find(_c, kind, namespace, name) {
    const key = namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`;
    return key in OWNERS || key in RECORDED_TYPES
      ? { key, uid: `uid-${name}`, tombstone: false, owner: OWNERS[key] ?? null }
      : null;
  },
};

const TYPES: ComponentType[] = [{ id: 'shop.gateway', match: { kind: 'StatefulSet', name_pattern: '^gateway$' } }];

const services = new ServiceCatalog(
  [
    {
      pack: 'shop',
      domains: [
        {
          id: 'forwarding',
          title: { 'zh-CN': '请求转发' },
          tier: 'core',
          services: [
            {
              id: 'gateway',
              title: { 'zh-CN': '网关' },
              members: [{ component_type: 'shop.gateway' }],
              namespaces: ['shop'],
            },
          ],
        },
        {
          id: 'archive',
          title: { 'zh-CN': '请求归档' },
          tier: 'supporting',
          services: [
            {
              id: 'archive-exporter',
              title: { 'zh-CN': '归档导出' },
              members: [{ match: { kind: 'component', name_pattern: '^archive-exporter$' } }],
            },
          ],
        },
      ],
    },
  ],
  TYPES,
);

/** 归档导出的告警挂在网关 Pod 上，目录条目声明它属于归档导出 */
const ENTRIES: AlertCatalogEntry[] = [
  {
    id: 'archive-dead-letters',
    alertname: 'ArchiveDeadLetters',
    role: 'symptom',
    entity: { kind: 'Pod', name_labels: ['pod'] },
    service: 'archive-exporter',
  } as AlertCatalogEntry,
];

function setup() {
  const metrics = new ServerMetrics('server', false);
  const typeLookups: string[] = [];
  const sd: ServiceDeps = {
    services: () => services,
    componentTypes: () => TYPES,
    componentType: async (_c, key) => {
      typeLookups.push(key);
      return RECORDED_TYPES[key] ?? null;
    },
    metrics,
  };
  const deps: ResolveDeps = {
    catalog: new AlertCatalog([{ pack: 'shop', entries: ENTRIES }]),
    nodes,
    ksm: null,
    ruleExpr: () => undefined,
    chronic: () => false,
    service: (clusterId, s) => alertService(sd, clusterId, s),
  };
  return { deps, metrics, typeLookups };
}

describe('接入时告警的服务（ADR 0193 §3）', () => {
  it('Pod 的告警归到它的顶层属主所在的服务：组件取自拓扑记录的组件类型', async () => {
    const { deps } = setup();
    const r = await resolveAlert('c', raw({ alertname: 'GatewayOOM', namespace: 'shop', pod: 'gateway-0' }), deps);
    expect(r.component).toBe('StatefulSet:shop/gateway');
    expect(r.classification).toMatchObject({
      service: 'gateway',
      service_source: 'component',
      business_domain: 'forwarding',
    });
  });

  it('目录条目声明的服务优先于所在对象的服务，不再查拓扑的组件类型', async () => {
    const { deps, typeLookups } = setup();
    const r = await resolveAlert(
      'c',
      raw({ alertname: 'ArchiveDeadLetters', namespace: 'shop', pod: 'gateway-0' }),
      deps,
    );
    expect(r.classification).toMatchObject({ service: 'archive-exporter', service_source: 'catalog' });
    expect(typeLookups).toEqual([]);
  });

  it('解析不出对象时归入命名空间伪组件，按默认命名空间推定', async () => {
    const { deps } = setup();
    const r = await resolveAlert('c', raw({ alertname: 'PodsPending', namespace: 'shop' }), deps);
    expect(r.component).toBe('Namespace:shop');
    expect(r.classification).toMatchObject({ service: 'gateway', service_source: 'namespace' });
  });

  it('srenautix_service 的取值不是已声明的服务时忽略并计数，按后面的来源', async () => {
    const { deps, metrics } = setup();
    const r = await resolveAlert(
      'c',
      raw({ alertname: 'GatewayOOM', namespace: 'shop', pod: 'gateway-0', srenautix_service: 'gatway' }),
      deps,
    );
    expect(r.classification).toMatchObject({ service: 'gateway', service_source: 'component' });
    const counted = await metrics.alertServiceLabelInvalid.get();
    expect(counted.values).toEqual([{ labels: { alertname: 'GatewayOOM' }, value: 1 }]);
  });

  it('不在任何服务里、也没有默认命名空间：服务为 null；没有服务依赖时同样为 null', async () => {
    const { deps } = setup();
    expect(
      (await resolveAlert('c', raw({ alertname: 'X', namespace: 'other', deployment: 'api' }), deps)).classification,
    ).toMatchObject({ service: null, service_source: 'default', business_domain: null });
    const withoutService: ResolveDeps = { ...deps, service: undefined };
    expect(
      (await resolveAlert('c', raw({ alertname: 'GatewayOOM', namespace: 'shop', pod: 'gateway-0' }), withoutService))
        .classification,
    ).toMatchObject({ service: null, service_source: 'default' });
  });
});
