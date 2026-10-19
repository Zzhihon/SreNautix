import { describe, expect, it } from 'vitest';
import { assertValid, type AlertmanagerAlert, type AlertmanagerWebhook } from '@srenautix/contract';
import {
  EntityResolver,
  labelsFingerprint,
  normalizeAlert,
  normalizeWebhook,
  type NormalizeContext,
} from '../src/index.js';
import { catalog, CLUSTER, clusterStore, MIN, RULE_EXPRS, T0, testdata } from './fixtures.js';

function ctx(now: number): NormalizeContext {
  return {
    clusterId: CLUSTER,
    source: 'alertmanager',
    receivedAt: now,
    catalog: catalog(),
    resolver: new EntityResolver({ store: clusterStore() }),
    ruleExprs: RULE_EXPRS,
    now,
  };
}

describe('Alertmanager webhook → 告警（黄金）', () => {
  it('实体、组件、角色与解析层', async () => {
    const body = JSON.parse(testdata('am-webhook-cascade.json')) as AlertmanagerWebhook;
    assertValid('integrations/alerts/v1/alerts.schema.json#/$defs/AlertmanagerWebhook', body);
    const alerts = await normalizeWebhook(body, ctx(T0 + 20 * MIN));
    for (const a of alerts) {
      assertValid('schemas/alert.schema.json', a);
    }
    const view = alerts.map((a) => ({
      alertname: a.alertname,
      entity: a.entity ? `${a.entity.kind}:${a.entity.namespace ?? ''}/${a.entity.name}` : null,
      uid: a.entity?.uid ?? null,
      component: a.component,
      role: a.classification.role,
      source: a.classification.source,
      layer: a.entity_resolution,
      severity: a.severity,
    }));
    expect(view).toEqual([
      {
        alertname: 'KubeContainerOOMKilled',
        entity: 'Pod:shop/pg-1',
        uid: '7b2d0000-0000-4000-8000-000000000p01',
        component: 'Cluster:shop/pg',
        role: 'cause',
        source: 'catalog',
        layer: 'informer',
        severity: 'critical',
      },
      {
        alertname: 'ApiErrorRatioHigh',
        entity: 'Deployment:shop/api',
        uid: '8c3e0000-0000-4000-8000-0000000a0000',
        component: 'Deployment:shop/api',
        role: 'symptom',
        source: 'expression',
        layer: 'informer',
        severity: 'critical',
      },
      {
        alertname: 'WorkerJobFailuresHigh',
        entity: 'Deployment:shop/worker',
        uid: '8c3e0000-0000-4000-8000-0000000b0000',
        component: 'Deployment:shop/worker',
        role: 'symptom',
        source: 'expression',
        layer: 'informer',
        severity: 'warning',
      },
      {
        alertname: 'FrontendErrorRatioHigh',
        entity: 'Deployment:web/frontend',
        uid: '9d4f0000-0000-4000-8000-0000000f0000',
        component: 'Deployment:web/frontend',
        role: 'symptom',
        source: 'expression',
        layer: 'informer',
        severity: 'warning',
      },
      {
        alertname: 'KubePodCrashLooping',
        entity: 'Pod:shop/pg-1',
        uid: '7b2d0000-0000-4000-8000-000000000p01',
        component: 'Cluster:shop/pg',
        role: 'cause',
        source: 'catalog',
        layer: 'informer',
        severity: 'warning',
      },
      {
        alertname: 'KubePersistentVolumeFillingUp',
        entity: 'PersistentVolumeClaim:shop/data-search-0',
        uid: '8c3e0000-0000-4000-8000-0000000c0002',
        component: 'PersistentVolumeClaim:shop/data-search-0',
        role: 'forecast',
        source: 'catalog',
        layer: 'informer',
        severity: 'warning',
      },
    ]);
    // Watchdog 不进入事件；alert_id 由去掉 prometheus 之外的身份标签计算，与 Alertmanager 的 fingerprint 无关
    expect(alerts.find((a) => a.alertname === 'Watchdog')).toBeUndefined();
    expect(alerts[0]!.alert_id).toBe(`${labelsFingerprint(body.alerts[0]!.labels)}@${(T0 + MIN) / 1000}`);
    expect(alerts.every((a) => a.status === 'firing' && a.ends_at === null && a.suppressed === 'none')).toBe(true);
  });

  it('API v2：抑制状态、静默、目录外告警归入命名空间伪组件', async () => {
    const raw = JSON.parse(testdata('am-api-v2-alerts.json')) as AlertmanagerAlert[];
    const c = { ...ctx(T0 + 185 * MIN), source: 'reconcile' as const };
    const alerts = await Promise.all(raw.map((r) => normalizeAlert(r, c)));
    const [node, mismatch, ledger] = alerts;
    expect(node).toMatchObject({ component: 'Node:node-1', suppressed: 'none', status: 'firing', ends_at: null });
    expect(node!.classification.role).toBe('cause');
    expect(mismatch).toMatchObject({ component: 'Deployment:shop/api', suppressed: 'inhibited' });
    expect(mismatch!.classification).toMatchObject({
      role: 'symptom',
      catalog_entry: 'test/deployment-replicas-mismatch',
    });
    expect(ledger).toMatchObject({
      component: 'Namespace:shop',
      entity: null,
      entity_resolution: 'unresolved',
      suppressed: 'silenced',
      severity: 'info',
    });
    expect(ledger!.classification).toMatchObject({ role: 'symptom', source: 'default' });
  });

  it('webhook 的 resolved 告警带结束时间', async () => {
    const body = JSON.parse(testdata('am-webhook-cascade.json')) as AlertmanagerWebhook;
    const resolved = { ...body.alerts[1]!, status: 'resolved' as const, endsAt: '2026-10-15T10:40:00Z' };
    const a = await normalizeAlert(resolved, ctx(T0 + 41 * MIN));
    expect(a).toMatchObject({ status: 'resolved', ends_at: '2026-10-15T10:40:00Z' });
  });

  it('告警时刻之后才删除的 Pod 从墓碑解析；24 小时之外的不再解析', async () => {
    const store = clusterStore();
    const deletedAt = T0 + 30 * MIN;
    const snapshot = store.asOf(T0);
    store.reconcile(
      {
        nodes: [...snapshot.allNodes()].filter((n) => n.key !== 'Pod:shop/search-0'),
        edges: snapshot.edges.filter((e) => e.from !== 'Pod:shop/search-0' && e.to !== 'Pod:shop/search-0'),
      },
      deletedAt,
      'informer',
    );
    const resolver = new EntityResolver({ store });
    const cand = {
      entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: 'search-0', uid: null },
      namespace: 'shop',
      fromLabels: false,
    };
    // 告警发生在删除之后（例如对账时才收到）：informer 中已没有，墓碑中有
    const late = await resolver.resolve(cand, deletedAt + MIN, deletedAt + 2 * MIN);
    expect(late).toMatchObject({ layer: 'tombstone', component: 'StatefulSet:shop/search' });
    expect(late.entity?.uid).toBe('8c3e0000-0000-4000-8000-0000000c0001');
    // 告警发生在删除之前：按告警时刻的拓扑解析
    expect(await resolver.resolve(cand, T0, deletedAt + 2 * MIN)).toMatchObject({ layer: 'informer' });
    // 墓碑过期
    expect(await resolver.resolve(cand, deletedAt + MIN, deletedAt + 25 * 60 * MIN)).toMatchObject({
      layer: 'unresolved',
      component: 'Namespace:shop',
    });
  });
});
