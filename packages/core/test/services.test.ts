import { describe, expect, it } from 'vitest';
import { assertValid, type Alert, type Incident } from '@srenautix/contract';
import {
  computeIncidents,
  DEFAULT_RCA_PARAMS,
  EntityResolver,
  incidentServices,
  normalizeAlert,
  reconcileIncidents,
} from '../src/index.js';
import { catalog, CLUSTER, clusterStore, MIN, RULE_EXPRS, T0 } from './fixtures.js';

describe('事件的服务（ADR 0193 §4）', () => {
  const m = (
    alert_id: string,
    component: string,
    severity: 'critical' | 'warning',
    service: string | null,
    service_source: 'component' | 'namespace' | 'default',
    left_version: number | null = null,
  ) => ({
    alert_id,
    component,
    severity,
    starts_at: '2026-10-15T10:00:00Z',
    service,
    service_source,
    business_domain: service === null ? null : `d-${service}`,
    left_version,
  });

  it('并集按字典序；主服务先取非推定来源，根因组件上的成员优先；已离开的成员不算', () => {
    const members = [
      m('a', 'Namespace:shop', 'critical', 'gateway', 'namespace'),
      m('b', 'Cluster:shop/pg', 'warning', 'orders-db', 'component'),
      m('c', 'Deployment:shop/api', 'critical', 'orders-api', 'component'),
      m('d', 'Deployment:shop/old', 'critical', 'legacy', 'component', 2),
      m('e', 'Deployment:shop/x', 'critical', null, 'default'),
    ];
    // 根因 pg 上的成员来源是 component：取它，即使 a、c 更严重
    expect(incidentServices(members, 'Cluster:shop/pg')).toEqual({
      services: ['gateway', 'orders-api', 'orders-db'],
      primary_service: 'orders-db',
      primary_service_source: 'component',
      business_domain: 'd-orders-db',
    });
    // 没有根因：非推定来源中最严重的 c，而不是同样 critical、来源为 namespace 的 a
    expect(incidentServices(members, null).primary_service).toBe('orders-api');
    // 只有推定来源时取推定
    expect(incidentServices([members[0]!], null)).toMatchObject({
      primary_service: 'gateway',
      primary_service_source: 'namespace',
    });
    expect(incidentServices([members[4]!], null)).toEqual({
      services: [],
      primary_service: null,
      primary_service_source: null,
      business_domain: null,
    });
  });

  it('成员带上告警的服务，事件求出服务；服务变化不改版本', async () => {
    const store = clusterStore();
    const graph = store.asOf(T0 + 60 * MIN);
    let n = 0;
    const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const normalized = async (labels: Record<string, string>, startsAt: string): Promise<Alert> =>
      (await normalizeAlert(
        { labels, annotations: {}, startsAt, endsAt: '0001-01-01T00:00:00Z', status: 'firing' },
        {
          clusterId: CLUSTER,
          source: 'alertmanager',
          receivedAt: T0,
          catalog: catalog(),
          resolver: new EntityResolver({ store }),
          ruleExprs: RULE_EXPRS,
          now: T0,
        },
      ))!;
    const withService = (a: Alert, service: string | null, source: 'owner' | 'namespace' | 'default'): Alert => ({
      ...a,
      classification: {
        ...a.classification,
        service,
        service_source: source,
        business_domain: service === null ? null : 'shop',
      },
    });
    const api = withService(
      await normalized(
        { alertname: 'ApiErrorRatioHigh', namespace: 'shop', deployment: 'api', severity: 'critical' },
        '2026-10-15T10:02:00Z',
      ),
      'storefront',
      'namespace',
    );
    const pg = withService(
      await normalized(
        { alertname: 'KubeContainerOOMKilled', namespace: 'shop', pod: 'pg-1', severity: 'warning' },
        '2026-10-15T10:01:00Z',
      ),
      'orders-db',
      'owner',
    );
    const run = (previous: Incident[], alerts: Alert[], now: number) =>
      reconcileIncidents({
        clusterId: CLUSTER,
        previous,
        computed: computeIncidents({ alerts, changes: [], graph, params: DEFAULT_RCA_PARAMS, now }),
        topologyVersion: graph.version,
        now,
        newId,
      });
    const inc = run([], [api, pg], T0 + 5 * MIN).incidents[0]!;
    assertValid('schemas/incident.schema.json', inc);
    expect(inc).toMatchObject({
      services: ['orders-db', 'storefront'],
      primary_service: 'orders-db',
      primary_service_source: 'owner',
      business_domain: 'shop',
    });
    expect(Object.fromEntries(inc.members.map((x) => [x.alertname, x.service]))).toEqual({
      ApiErrorRatioHigh: 'storefront',
      KubeContainerOOMKilled: 'orders-db',
    });
    const inc2 = run([inc], [withService(api, 'storefront-v2', 'owner'), pg], T0 + 6 * MIN).incidents[0]!;
    expect(inc2.incident_version).toBe(inc.incident_version);
    expect(inc2.services).toEqual(['orders-db', 'storefront-v2']);
  });
});
