import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AlertCatalogEntry } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { ALERT_CATEGORIES, AlertCatalog, classifyAlert, classifyExpression, type CategoryRule } from '../src/index.js';

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
      category: 'unclassified',
      category_source: 'default',
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

describe('告警类别（ADR 0183）', () => {
  const entries: AlertCatalogEntry[] = [
    {
      id: 'pod-crash-looping',
      alertname: 'KubePodCrashLooping',
      role: 'cause',
      category: 'availability',
      entity: { kind: 'Pod', name_labels: ['pod'] },
    },
    {
      id: 'hpa-maxed-out',
      alertname: 'KubeHpaMaxedOut',
      role: 'symptom',
      category: 'performance',
      entity: { kind: 'HorizontalPodAutoscaler', name_labels: ['horizontalpodautoscaler'] },
    },
    {
      // 第三方包的条目可以不声明类别，交给部署方的规则
      id: 'shop-checkout-errors',
      alertname: 'ShopCheckoutErrors',
      role: 'symptom',
      entity: { kind: 'Deployment', name_labels: ['deployment'] },
    },
  ];
  const rules: CategoryRule[] = [
    { labels: { component: ['provider'] }, exclude_labels: {}, category: 'provider' },
    { labels: { layer: ['L0'] }, exclude_labels: { team: ['infra'] }, category: 'availability' },
    { labels: { layer: ['L0', 'L3'] }, exclude_labels: {}, category: 'platform' },
  ];
  const invalid: Array<[string, string]> = [];
  const catalog = new AlertCatalog([{ pack: 'test', entries }], {
    categoryRules: rules,
    onInvalidCategoryLabel: (alertname, value) => invalid.push([alertname, value]),
  });
  const of = (labels: Record<string, string>) => {
    const c = classifyAlert({ labels, chronic: false }, catalog);
    return [c.category, c.category_source];
  };

  it('类别枚举与契约相同', () => {
    const common = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../contract/schemas/common.schema.json', import.meta.url)), 'utf8'),
    ) as { $defs: Record<string, { enum: string[] }> };
    expect([...ALERT_CATEGORIES]).toEqual(common.$defs.AlertCategory!.enum);
    expect([...ALERT_CATEGORIES, 'unclassified']).toEqual(common.$defs.IncidentCategory!.enum);
  });

  it('srenautix_category 标签优先于告警目录与规则', () => {
    expect(of({ alertname: 'KubePodCrashLooping', srenautix_category: 'platform', component: 'provider' })).toEqual([
      'platform',
      'label',
    ]);
    expect(of({ alertname: 'NotInCatalog', srenautix_category: 'observability' })).toEqual(['observability', 'label']);
  });

  it('没有标签时取告警目录条目声明的类别，规则不覆盖目录', () => {
    expect(of({ alertname: 'KubeHpaMaxedOut' })).toEqual(['performance', 'catalog']);
    expect(of({ alertname: 'KubePodCrashLooping', component: 'provider' })).toEqual(['availability', 'catalog']);
  });

  it('目录没有声明类别时按规则表的顺序取第一条命中的规则，exclude_labels 命中的规则跳过', () => {
    expect(of({ alertname: 'ShopCheckoutErrors', component: 'provider', layer: 'L0' })).toEqual(['provider', 'rule']);
    expect(of({ alertname: 'ShopCheckoutErrors', layer: 'L0' })).toEqual(['availability', 'rule']);
    expect(of({ alertname: 'ShopCheckoutErrors', layer: 'L0', team: 'infra' })).toEqual(['platform', 'rule']);
    expect(of({ alertname: 'EdgeProbeFailed', layer: 'L3' })).toEqual(['platform', 'rule']);
  });

  it('标签、目录与规则都没有给出类别时为 unclassified', () => {
    expect(of({ alertname: 'ShopCheckoutErrors', layer: 'L2' })).toEqual(['unclassified', 'default']);
    expect(of({ alertname: 'Unknown' })).toEqual(['unclassified', 'default']);
    expect(new AlertCatalog([]).category({ alertname: 'Unknown', layer: 'L0' })).toEqual({
      category: 'unclassified',
      source: 'default',
    });
  });

  it('标签的取值不在枚举里时忽略标签、按后面的来源继续，并报告一次', () => {
    invalid.length = 0;
    expect(of({ alertname: 'KubeHpaMaxedOut', srenautix_category: 'latency' })).toEqual(['performance', 'catalog']);
    expect(of({ alertname: 'ShopCheckoutErrors', srenautix_category: 'unclassified', layer: 'L0' })).toEqual([
      'availability',
      'rule',
    ]);
    expect(of({ alertname: 'Unknown', srenautix_category: '' })).toEqual(['unclassified', 'default']);
    expect(invalid).toEqual([
      ['KubeHpaMaxedOut', 'latency'],
      ['ShopCheckoutErrors', 'unclassified'],
      ['Unknown', ''],
    ]);
  });

  it('告警自带 role 标签时类别照样按标签、目录与规则求出', () => {
    const c = classifyAlert({ labels: { alertname: 'KubeHpaMaxedOut', role: 'cause' }, chronic: false }, catalog);
    expect(c).toMatchObject({ role: 'cause', source: 'label', category: 'performance', category_source: 'catalog' });
  });

  it('类别解析的输入按告警名与查找顺序列出条目，再列出规则；与类别无关的字段不在其中', () => {
    const variants: AlertCatalogEntry[] = [
      {
        id: 'slow',
        alertname: 'ShopSlow',
        role: 'symptom',
        entity: { kind: 'Deployment', name_labels: ['deployment'] },
      },
      {
        id: 'slow-critical',
        alertname: 'ShopSlow',
        role: 'symptom',
        category: 'availability',
        match_labels: { severity: 'critical' },
        entity: { kind: 'Deployment', name_labels: ['deployment'] },
      },
    ];
    const inputs = new AlertCatalog(
      [
        { pack: 'test', entries },
        { pack: 'shop', entries: variants },
      ],
      { categoryRules: rules },
    ).categoryInputs();
    expect(inputs.entries).toEqual([
      { alertname: 'KubeHpaMaxedOut', match_labels: {}, category: 'performance' },
      { alertname: 'KubePodCrashLooping', match_labels: {}, category: 'availability' },
      { alertname: 'ShopCheckoutErrors', match_labels: {}, category: null },
      { alertname: 'ShopSlow', match_labels: { severity: 'critical' }, category: 'availability' },
      { alertname: 'ShopSlow', match_labels: {}, category: null },
    ]);
    expect(inputs.rules).toEqual(rules);
    // 包名、标题、角色与证据链变化时输入不变；包的先后决定同样具体的条目的查找顺序，输入随之变化
    const renamed = entries.map((e) => ({ ...e, id: `${e.id}-v2`, role: 'cause' as const, title: { en: 'Renamed' } }));
    expect(new AlertCatalog([{ pack: 'other', entries: renamed }], { categoryRules: rules }).categoryInputs()).toEqual(
      new AlertCatalog([{ pack: 'test', entries }], { categoryRules: rules }).categoryInputs(),
    );
    const twin: AlertCatalogEntry = { ...entries[1]!, id: 'hpa-twin', category: 'platform' };
    expect(
      new AlertCatalog([
        { pack: 'a', entries: [entries[1]!] },
        { pack: 'b', entries: [twin] },
      ]).categoryInputs(),
    ).not.toEqual(
      new AlertCatalog([
        { pack: 'b', entries: [twin] },
        { pack: 'a', entries: [entries[1]!] },
      ]).categoryInputs(),
    );
  });
});
