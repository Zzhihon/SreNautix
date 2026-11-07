// 只有 MetricsQL 备选的卡（ADR 0187）：pack test 只在 VictoriaMetrics 上执行它的夹具、无数据测试与主卡核对，
// 用例记下没有运行的后端；有 PromQL 备选的卡仍在两个后端上执行。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir, loadPromqlEngine } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { compilePackSet } from '../src/pack/compile.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadAlertRules } from '../src/testing/alert-consistency.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { CATALOG } from './support.js';

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

function dir(): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, 'metricsql-card-'));
  scratch.push(d);
  return d;
}

// 队列积压：最近一次上报的 queue_depth（default_rollup 只有 MetricsQL 有）超过 100 判异常；
// depth-promql 读同一个指标的 PromQL 写法，作为对照
function pack(): string {
  const d = join(dir(), 'queue');
  mkdirSync(join(d, 'tests'), { recursive: true });
  writeFileSync(
    join(d, 'pack.yaml'),
    'api_version: srenautix.io/pack/v1\nname: queue\nversion: 1.0.0\ndescription: 队列\nmaturity: stable\nmin_srenautix_version: 0.1.0\nrequires: [metrics.query, metrics.query_range]\n',
  );
  writeFileSync(
    join(d, 'signals.yaml'),
    [
      'signals:',
      '  - id: last-depth',
      '    kind: metrics',
      '    alternatives:',
      '      - expr: max by (queue) (default_rollup(queue_depth{queue="$name"}[10m]))',
      '        dialect: metricsql',
      '  - id: depth',
      '    kind: metrics',
      '    alternatives:',
      '      - expr: max by (queue) (queue_depth{queue="$name"})',
      '',
    ].join('\n'),
  );
  const card = (id: string, signal: string) => [
    `      - id: ${id}`,
    '        title: { zh-CN: 队列深度, en: Queue depth }',
    '        applies_to: { kinds: [queue] }',
    '        refs:',
    `          - { name: depth, signal: ${signal}, mode: range }`,
    '        judge:',
    '          let:',
    '            - { name: peak, cel: max(depth) }',
    '          abnormal_if:',
    "            - { cel: peak > 100.0, say: { zh-CN: '积压', en: 'Backlog' } }",
    '        display: { value: peak }',
    '        egress: allow',
  ];
  writeFileSync(
    join(d, 'chains.yaml'),
    [
      'chains:',
      '  - id: backlog',
      '    title: { zh-CN: 积压, en: Backlog }',
      '    cards:',
      ...card('last-depth', 'last-depth'),
      ...card('depth', 'depth'),
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(d, 'alerts.yaml'),
    'entries:\n  - { id: queue-backlog, alertname: QueueBacklog, role: symptom, entity: { kind: queue, name_labels: [queue] }, chains: [backlog], primary_card: backlog/last-depth }\n',
  );
  const test = (card: string) => [
    `  - { name: ${card} 积压, eval_time: 30m, card: backlog/${card}, entity: { kind: queue, name: orders }, expect: { verdict: abnormal } }`,
    `  - { name: ${card} 正常, eval_time: 30m, card: backlog/${card}, entity: { kind: queue, name: mail }, expect: { verdict: normal } }`,
  ];
  writeFileSync(
    join(d, 'tests', 'backlog.yaml'),
    [
      'api_version: srenautix.io/pack-test/v1',
      'interval: 1m',
      'input_series:',
      "  - { series: 'queue_depth{queue=\"orders\"}', values: '10x20 150x40' }",
      "  - { series: 'queue_depth{queue=\"mail\"}', values: '10x60' }",
      'tests:',
      ...test('last-depth'),
      ...test('depth'),
      '',
    ].join('\n'),
  );
  return d;
}

function rules(threshold: number): string {
  const f = join(dir(), 'rules.yaml');
  writeFileSync(
    f,
    `groups:\n  - name: queue\n    rules:\n      - alert: QueueBacklog\n        expr: max by (queue) (default_rollup(queue_depth[10m])) > ${threshold}\n        for: 2m\n        labels: { severity: warning }\n`,
  );
  return f;
}

describe('只有 MetricsQL 备选的卡', () => {
  it('pack test 只在 VictoriaMetrics 上执行，PromQL 的卡仍在两个后端上执行', async () => {
    const set = await compilePackSet([loadPackDir(pack(), 'local')], { catalog: CATALOG });
    const engine = await loadPromqlEngine();
    const report = await runPackTests({ set, alertRules: loadAlertRules([rules(100)], engine) });
    expect(report.cases.filter((c) => !c.passed)).toEqual([]);
    const of = (card: string, kind: string) =>
      report.cases.filter((c) => c.card === `queue/backlog/${card}` && c.kind === kind);
    for (const c of [...of('last-depth', 'fixture'), ...of('last-depth', 'nodata')]) {
      expect(Object.keys(c.results)).toEqual(['victoria-metrics']);
      expect(c.dialect_skipped).toEqual(['prometheus']);
    }
    for (const c of [...of('depth', 'fixture'), ...of('depth', 'nodata')]) {
      expect(Object.keys(c.results).sort()).toEqual(['prometheus', 'victoria-metrics']);
      expect(c.dialect_skipped).toBeUndefined();
    }
    // 自动变换用的是 VictoriaMetrics 上的夹具结果
    const derived = [...of('last-depth', 'partial_nodata'), ...of('last-depth', 'datasource_error')];
    expect(derived.length).toBeGreaterThan(0);
    for (const c of derived) {
      expect(Object.keys(c.results)).toEqual(['victoria-metrics']);
    }
    expect(of('last-depth', 'fixture')).toHaveLength(2);
    // 主卡的两个夹具测试只在 VictoriaMetrics 上核对告警规则
    expect(report.alert_checks).toBe(2);
    expect(report.passed).toBe(true);
  });

  it('告警阈值与卡片不一致时在 VictoriaMetrics 上报出分歧', async () => {
    const set = await compilePackSet([loadPackDir(pack(), 'local')], { catalog: CATALOG });
    const engine = await loadPromqlEngine();
    const drift = await runPackTests({ set, alertRules: loadAlertRules([rules(200)], engine) });
    const failed = drift.cases.filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toEqual(['last-depth 积压']);
    expect(failed[0]!.failure).toMatch(/^victoria-metrics：告警 QueueBacklog.*没有触发，主卡判为 abnormal$/);
  });
});
