import { describe, expect, it } from 'vitest';
import { AlertCatalog, classifyAlert, classifyExpression } from '../src/index.js';

// kube-prometheus-stack 92.10.1 渲染后的表达式（job 与命名空间取默认值）
const PV_CRITICAL = `(
  kubelet_volume_stats_available_bytes{job="kubelet", namespace=~".*", metrics_path="/metrics"}
    /
  kubelet_volume_stats_capacity_bytes{job="kubelet", namespace=~".*", metrics_path="/metrics"}
) < 0.03
and
kubelet_volume_stats_used_bytes{job="kubelet", namespace=~".*", metrics_path="/metrics"} > 0
unless on (cluster, namespace, persistentvolumeclaim)
kube_persistentvolumeclaim_access_mode{ access_mode="ReadOnlyMany"} == 1`;
const PV_WARNING = `(
  kubelet_volume_stats_available_bytes{job="kubelet", namespace=~".*", metrics_path="/metrics"}
    /
  kubelet_volume_stats_capacity_bytes{job="kubelet", namespace=~".*", metrics_path="/metrics"}
) < 0.15
and
predict_linear(kubelet_volume_stats_available_bytes{job="kubelet", namespace=~".*", metrics_path="/metrics"}[6h], 4 * 24 * 3600) < 0`;
const CRASH_LOOP = `max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff", job="kube-state-metrics", namespace=~".*"}[5m]) >= 1`;
const GENERATION_MISMATCH = `kube_deployment_status_observed_generation{job="kube-state-metrics", namespace=~".*"}
  !=
kube_deployment_metadata_generation{job="kube-state-metrics", namespace=~".*"}`;
const TARGET_DOWN = `100 * (count(up == 0) BY (cluster, job, namespace, service) / count(up) BY (cluster, job, namespace, service)) > 10`;
const ERROR_BUDGET = `sum(rate(apiserver_request_total{job="apiserver",code=~"5.."}[5m])) / sum(rate(apiserver_request_total{job="apiserver"}[5m])) > 0.05`;

describe('按表达式分类', () => {
  it.each([
    [PV_WARNING, 'forecast'],
    [PV_CRITICAL, null],
    [CRASH_LOOP, 'cause'],
    [GENERATION_MISMATCH, 'change'],
    [TARGET_DOWN, 'cause'],
    [ERROR_BUDGET, 'symptom'],
    ['histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m]))) > 1', 'symptom'],
    ['changes(kube_pod_container_status_restarts_total[10m]) > 2', 'change'],
    ['absent(up{job="kube-state-metrics"} == 1)', 'meta'],
  ])('%s → %s', (expr, role) => {
    expect(classifyExpression(expr)?.role ?? null).toBe(role);
  });
});

describe('告警目录与分类顺序', () => {
  const catalog = new AlertCatalog([
    {
      pack: 'alerts-kps',
      entries: [
        {
          id: 'pv-filling-up-warning',
          alertname: 'KubePersistentVolumeFillingUp',
          match_labels: { severity: 'warning' },
          expr: PV_WARNING,
          role: 'forecast',
          entity: { kind: 'PersistentVolumeClaim', name_labels: ['persistentvolumeclaim'] },
        },
        {
          id: 'pv-filling-up-critical',
          alertname: 'KubePersistentVolumeFillingUp',
          match_labels: { severity: 'critical' },
          expr: PV_CRITICAL,
          role: 'forecast',
          entity: { kind: 'PersistentVolumeClaim', name_labels: ['persistentvolumeclaim'] },
        },
        {
          id: 'target-down',
          alertname: 'TargetDown',
          expr: TARGET_DOWN,
          role: 'meta',
          entity: { kind: 'Service', name_labels: ['service'] },
        },
      ],
    },
  ]);

  it('同名告警按 match_labels 选变体，forecast 按表达式判断', () => {
    const warn = classifyAlert(
      { labels: { alertname: 'KubePersistentVolumeFillingUp', severity: 'warning' }, chronic: false },
      catalog,
    );
    expect(warn).toMatchObject({
      role: 'forecast',
      source: 'catalog',
      catalog_entry: 'alerts-kps/pv-filling-up-warning',
    });
    // 目录误写为 forecast 的 critical 变体：表达式描述当前状态，属于 cause
    const crit = classifyAlert(
      { labels: { alertname: 'KubePersistentVolumeFillingUp', severity: 'critical' }, chronic: false },
      catalog,
    );
    expect(crit).toMatchObject({ role: 'cause', catalog_entry: 'alerts-kps/pv-filling-up-critical' });
  });

  it('目录中的 meta 角色不被表达式改写', () => {
    expect(classifyAlert({ labels: { alertname: 'TargetDown' }, chronic: false }, catalog).role).toBe('meta');
  });

  it('告警自带 role 标签时角色以标签为准，目录条目照样记下（证据链作为补充执行）', () => {
    const c = classifyAlert({ labels: { alertname: 'TargetDown', role: 'symptom' }, chronic: true }, catalog);
    expect(c).toMatchObject({ role: 'symptom', source: 'label', confidence: 1, chronic: true });
    expect(c.catalog_entry).toBe(
      classifyAlert({ labels: { alertname: 'TargetDown' }, chronic: false }, catalog).catalog_entry,
    );
    expect(c.catalog_entry).not.toBeNull();
    expect(classifyAlert({ labels: { alertname: 'NotInCatalog', role: 'cause' }, chronic: false }, catalog)).toEqual({
      role: 'cause',
      source: 'label',
      confidence: 1,
      catalog_entry: null,
      chronic: false,
    });
  });

  it('目录外的告警按 rules API 的表达式分类，没有依据时按 symptom', () => {
    expect(
      classifyAlert(
        { labels: { alertname: 'MyDiskForecast' }, ruleExpr: 'predict_linear(x[1h], 3600) < 0', chronic: false },
        catalog,
      ),
    ).toMatchObject({ role: 'forecast', source: 'expression' });
    expect(classifyAlert({ labels: { alertname: 'Unknown' }, chronic: false }, catalog)).toMatchObject({
      role: 'symptom',
      source: 'default',
      confidence: 0.3,
    });
  });
});
