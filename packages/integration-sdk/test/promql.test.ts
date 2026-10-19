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
      engine.rewrite(
        'label_replace(sum by (namespace, pod) (rate(x{namespace="a"}[5m])), "dst", "$1", "pod", "(.*)")',
        'promql',
        { rename: { namespace: 'k8s_namespace_name', pod: 'k8s_pod_name' }, inject: {} },
      ),
    ).toBe(
      'label_replace(sum by (k8s_namespace_name, k8s_pod_name) (rate(x{k8s_namespace_name="a"}[5m])), "dst", "$1", "k8s_pod_name", "(.*)")',
    );
    expect(
      engine.rewrite('sum(rate(x{namespace="a"})) by (namespace)', 'metricsql', {
        rename: { namespace: 'kubernetes_namespace' },
        inject: {},
      }),
    ).toBe('sum(rate(x{kubernetes_namespace="a"})) by(kubernetes_namespace)');
  });

  it('给每个选择器注入集群标签', () => {
    expect(
      engine.rewrite('up{job="a"} / on (job) group_left kube_info{cluster="b"}', 'promql', {
        rename: {},
        inject: { cluster: 'c1' },
      }),
    ).toBe('up{cluster="c1",job="a"} / on (job) group_left () kube_info{cluster="b"}');
    expect(engine.rewrite('rate(x)', 'metricsql', { rename: {}, inject: { cluster: 'c1' } })).toBe(
      'rate(x{cluster="c1"})',
    );
  });

  it('回看范围', () => {
    expect(engine.analyze('rate(x[10m] offset 5m)', 'promql').lookback_ms).toBe(15 * 60_000);
    expect(engine.analyze('max_over_time(rate(x[5m])[1h:1m])', 'promql').lookback_ms).toBe(65 * 60_000);
    expect(engine.analyze('x offset -10m', 'promql').lookahead_ms).toBe(10 * 60_000);
    expect(engine.analyze('x', 'promql').lookback_ms).toBe(5 * 60_000);
  });

  it('展开 promtool 的 input_series 写法', () => {
    expect(engine.parseSeries('up{job="a"} 1+1x3 _ stale 5x2')).toEqual({
      labels: { __name__: 'up', job: 'a' },
      values: [1, 2, 3, 4, null, 'stale', 5, 5, 5],
    });
  });
});
