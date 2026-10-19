import { beforeAll, describe, expect, it } from 'vitest';
import { loadPromqlEngine, QuerySyntaxError, type PromqlEngine } from '../src/promql/engine.js';

let engine: PromqlEngine;
beforeAll(async () => {
  engine = await loadPromqlEngine();
});

describe('PromqlEngine', () => {
  it('分析选择器、函数与标签', () => {
    const a = engine.analyze(
      'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{namespace="a",pod=~"b.*"}[5m])) / on (namespace) group_left (node) kube_pod_info',
      'promql',
    );
    expect(a.type).toBe('vector');
    expect(a.selectors.map((s) => s.metric)).toEqual(['container_cpu_usage_seconds_total', 'kube_pod_info']);
    expect(a.functions).toEqual(['rate', 'sum']);
    expect(a.labels).toEqual(['namespace', 'node', 'pod']);
  });

  it('PromQL 严格：rate 需要区间向量；MetricsQL 必须显式声明', () => {
    expect(() => engine.analyze('rate(x)', 'promql')).toThrow(QuerySyntaxError);
    expect(engine.analyze('rate(x)', 'metricsql').functions).toEqual(['rate']);
  });

  it('不接受实验函数', () => {
    expect(() => engine.analyze('sort_by_label(up, "job")', 'promql')).toThrow(QuerySyntaxError);
  });

  it('按标签档案改写标签名', () => {
    expect(
      engine.renameLabels(
        'label_replace(sum by (namespace, pod) (rate(x{namespace="a"}[5m])), "dst", "$1", "pod", "(.*)")',
        'promql',
        { namespace: 'k8s_namespace_name', pod: 'k8s_pod_name' },
      ),
    ).toBe(
      'label_replace(sum by (k8s_namespace_name, k8s_pod_name) (rate(x{k8s_namespace_name="a"}[5m])), "dst", "$1", "k8s_pod_name", "(.*)")',
    );
    expect(engine.renameLabels('sum(rate(x{namespace="a"})) by (namespace)', 'metricsql', { namespace: 'kubernetes_namespace' })).toBe(
      'sum(rate(x{kubernetes_namespace="a"})) by(kubernetes_namespace)',
    );
  });

  it('展开 promtool 的 input_series 写法', () => {
    expect(engine.parseSeries('up{job="a"} 1+1x3 _ stale 5x2')).toEqual({
      labels: { __name__: 'up', job: 'a' },
      values: [1, 2, 3, 4, null, 'stale', 5, 5, 5],
    });
  });
});
