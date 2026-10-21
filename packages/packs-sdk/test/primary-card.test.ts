// 告警目录的主卡：pack lint 检查卡片存在、applies_to 包含实体 kind、证据链在条目的 chains 中；
// pack test --alert-rules 在主卡的夹具上同时求告警规则，触发与主卡判为异常必须一致。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir, loadPromqlEngine } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
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
  const d = mkdtempSync(join(base, 'primary-card-'));
  scratch.push(d);
  return d;
}

// 队列积压：queue_depth 超过 params.limit 判异常
function pack(entry: string): string {
  // 目录名必须等于包名
  const d = join(dir(), 'queue');
  mkdirSync(join(d, 'tests'), { recursive: true });
  writeFileSync(
    join(d, 'pack.yaml'),
    'api_version: srenautix.io/pack/v1\nname: queue\nversion: 1.0.0\ndescription: 队列\nmaturity: stable\nmin_srenautix_version: 0.1.0\nrequires: [metrics.query, metrics.query_range]\n',
  );
  writeFileSync(
    join(d, 'signals.yaml'),
    'signals:\n  - id: depth\n    kind: metrics\n    alternatives:\n      - expr: max by (queue) (queue_depth{queue="$name"})\n',
  );
  writeFileSync(
    join(d, 'chains.yaml'),
    [
      'chains:',
      '  - id: backlog',
      '    title: { zh-CN: 积压, en: Backlog }',
      '    cards:',
      '      - id: depth',
      '        title: { zh-CN: 队列深度, en: Queue depth }',
      '        applies_to: { kinds: [queue] }',
      '        params: { limit: 100 }',
      '        refs:',
      '          - { name: depth, signal: depth, mode: range }',
      '        judge:',
      '          let:',
      '            - { name: peak, cel: max(depth) }',
      '          abnormal_if:',
      "            - { cel: peak > double(params.limit), say: { zh-CN: '积压', en: 'Backlog' } }",
      '        display: { value: peak }',
      '        egress: allow',
      '',
    ].join('\n'),
  );
  writeFileSync(join(d, 'alerts.yaml'), `entries:\n  - ${entry}\n`);
  writeFileSync(
    join(d, 'tests', 'backlog.yaml'),
    [
      'api_version: srenautix.io/pack-test/v1',
      'interval: 1m',
      'input_series:',
      "  - { series: 'queue_depth{queue=\"orders\"}', values: '10x20 150x40' }",
      "  - { series: 'queue_depth{queue=\"mail\"}', values: '10x60' }",
      'tests:',
      '  - { name: 积压, eval_time: 30m, card: backlog/depth, entity: { kind: queue, name: orders }, expect: { verdict: abnormal } }',
      '  - { name: 正常, eval_time: 30m, card: backlog/depth, entity: { kind: queue, name: mail }, expect: { verdict: normal } }',
      '',
    ].join('\n'),
  );
  return d;
}

const ENTRY = (extra: string) =>
  `{ id: queue-backlog, alertname: QueueBacklog, role: symptom, entity: { kind: queue, name_labels: [queue] }, chains: [backlog]${extra} }`;

function rules(threshold: number): string {
  const d = dir();
  const f = join(d, 'rules.yaml');
  writeFileSync(
    f,
    `groups:\n  - name: queue\n    rules:\n      - alert: QueueBacklog\n        expr: queue_depth > ${threshold}\n        for: 2m\n        labels: { severity: warning }\n`,
  );
  return f;
}

describe('主卡', () => {
  it('lint：卡片不存在、kind 不符、证据链不在条目中时拒绝', async () => {
    const compile = (extra: string) => compilePackSet([loadPackDir(pack(ENTRY(extra)), 'local')], { catalog: CATALOG });
    await expect(compile(', primary_card: backlog/depth')).resolves.toBeDefined();
    await expect(compile(', primary_card: backlog/missing')).rejects.toThrow(PackLintError);
    await expect(
      compilePackSet(
        [
          loadPackDir(
            pack(
              '{ id: queue-backlog, alertname: QueueBacklog, role: symptom, entity: { kind: Pod, name_labels: [pod] }, chains: [backlog], primary_card: backlog/depth }',
            ),
            'local',
          ),
        ],
        { catalog: CATALOG },
      ),
    ).rejects.toThrow(/applies_to/);
    await expect(
      compilePackSet(
        [
          loadPackDir(
            pack(
              '{ id: queue-backlog, alertname: QueueBacklog, role: symptom, entity: { kind: queue, name_labels: [queue] }, primary_card: backlog/depth }',
            ),
            'local',
          ),
        ],
        { catalog: CATALOG },
      ),
    ).rejects.toThrow(/chains/);
  });

  it('pack test：阈值与卡片一致时通过，不一致时报出告警与主卡的分歧', async () => {
    const set = await compilePackSet([loadPackDir(pack(ENTRY(', primary_card: backlog/depth')), 'local')], {
      catalog: CATALOG,
    });
    const engine = await loadPromqlEngine();
    const same = await runPackTests({ set, alertRules: loadAlertRules([rules(100)], engine) });
    expect(same.cases.filter((c) => !c.passed)).toEqual([]);
    // 两个夹具测试 × 两个后端
    expect(same.alert_checks).toBe(4);
    // 告警阈值改成 200：orders 的 150 触发卡片但不触发告警
    const drift = await runPackTests({ set, alertRules: loadAlertRules([rules(200)], engine) });
    const failed = drift.cases.filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toEqual(['积压']);
    expect(failed[0]!.failure).toMatch(/QueueBacklog.*没有触发，主卡判为 abnormal/);
  });
});
