import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPrometheus, type FixtureMetricSeries, type TsdbInstance } from '@srenautix/integration-sdk';
import { runPackCli } from '../src/cli.js';
import type { QuerySnapshot } from '../src/runtime/snapshot.js';
import { REPO } from './support.js';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const pts = (f: (i: number) => number) => Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v: f(i) }));
const fixtures: FixtureMetricSeries[] = [
  { labels: { __name__: 'up', job: 'kubelet', instance: 'n1' }, points: pts(() => 1) },
  { labels: { __name__: 'kube_pod_info', namespace: 'shop', pod: 'web-0', node: 'n1' }, points: pts(() => 1) },
  { labels: { __name__: 'kube_pod_info', namespace: 'shop', pod: 'web-1', node: 'n1' }, points: pts(() => 1) },
  {
    labels: { __name__: 'kube_pod_container_info', namespace: 'shop', pod: 'web-0', container: 'web' },
    points: pts(() => 1),
  },
  {
    labels: { __name__: 'container_memory_working_set_bytes', namespace: 'shop', pod: 'web-0', container: 'web' },
    points: pts((i) => (i < 20 ? 5e8 : 9.6e8)),
  },
  {
    labels: {
      __name__: 'kube_pod_container_resource_limits',
      namespace: 'shop',
      pod: 'web-0',
      container: 'web',
      resource: 'memory',
    },
    points: pts(() => 1e9),
  },
  {
    labels: { __name__: 'container_memory_working_set_bytes', namespace: 'shop', pod: 'web-1', container: 'web' },
    points: pts(() => 3e8),
  },
  {
    labels: {
      __name__: 'kube_pod_container_resource_limits',
      namespace: 'shop',
      pod: 'web-1',
      container: 'web',
      resource: 'memory',
    },
    points: pts(() => 1e9),
  },
  {
    labels: { __name__: 'container_oom_events_total', namespace: 'shop', pod: 'web-1', container: 'web' },
    points: pts(() => 0),
  },
  {
    labels: {
      __name__: 'ALERTS',
      alertname: 'KubePodCrashLooping',
      alertstate: 'firing',
      namespace: 'shop',
      pod: 'web-0',
    },
    points: pts(() => 1),
  },
  {
    labels: { __name__: 'ALERTS', alertname: 'TeamCustomAlert', alertstate: 'firing', namespace: 'shop' },
    points: pts(() => 1),
  },
];

let prom: TsdbInstance;
const out: string[] = [];
const io = { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s) };
const common = ['--packs', join(REPO, 'packs'), '--catalog', join(REPO, 'contract/gateway/v1/action-catalog.yaml')];
const scratch = join(REPO, '.scratch', 'packs-cli-test');

beforeAll(async () => {
  prom = await startPrometheus(fixtures);
  mkdirSync(scratch, { recursive: true });
});
afterAll(async () => {
  // beforeAll 启动失败时 prom 未赋值
  await prom?.stop();
});

describe('srenautix pack', () => {
  it('lint 与 lock --check', async () => {
    out.length = 0;
    expect(await runPackCli(['lint', ...common], io)).toBe(0);
    expect(out.join('')).toMatch(/pack\.lock sha256:[0-9a-f]{64}/);
    const lock = join(scratch, 'pack.lock');
    expect(await runPackCli(['lock', ...common, '--write', lock], io)).toBe(0);
    expect(await runPackCli(['lock', ...common, '--check', lock], io)).toBe(0);
    writeFileSync(lock, readFileSync(lock, 'utf8').replace(/sha256:[0-9a-f]{4}/, 'sha256:0000'));
    expect(await runPackCli(['lock', ...common, '--check', lock], io)).toBe(1);
    expect(await runPackCli(['lint', ...common, '--lock', lock], io).catch((e: Error) => e.message)).toMatch(
      /pack\.lock 与加载的内容不一致/,
    );
  });

  it('record 录制查询邻域，--replay 在快照上得出同样的结论', async () => {
    const snapFile = join(scratch, 'memory.json');
    const at = new Date(T0 + 60 * MIN).toISOString();
    const args = [
      'record',
      ...common,
      '--only',
      '_example',
      '--prometheus',
      prom.url,
      '--at',
      at,
      '--anchor',
      new Date(T0 + 40 * MIN).toISOString(),
      '--out',
      snapFile,
    ];
    expect(
      await runPackCli(
        [
          ...args,
          '--card',
          '_example/pod-memory/limit-ratio',
          '--entity',
          'Pod/shop/web-0',
          '--card',
          '_example/pod-memory/limit-ratio',
          '--entity',
          'Pod/shop/web-1',
          '--card',
          '_example/checks/memory-headroom',
          '--entity',
          'Pod/shop/web-0',
        ],
        io,
      ),
    ).toBe(0);
    const snap = JSON.parse(readFileSync(snapFile, 'utf8')) as QuerySnapshot;
    expect(snap.cases.map((c) => c.expect?.verdict)).toEqual(['abnormal', 'normal', 'abnormal']);
    expect(snap.entries.length).toBeGreaterThan(3);

    // 回放：把快照放进一个只含 _example 的包目录副本的 tests/replay 下
    const { replaySnapshot } = await import('../src/testing/replay.js');
    const { compilePackSet } = await import('../src/pack/compile.js');
    const { loadBuiltinPacks } = await import('../src/pack/sources.js');
    const { CATALOG, PACKS } = await import('./support.js');
    const set = await compilePackSet(loadBuiltinPacks(PACKS, ['_example']), { catalog: CATALOG });
    const report = await replaySnapshot(set, snap);
    expect(report.cases.map((c) => [c.verdict, c.passed])).toEqual([
      ['abnormal', true],
      ['normal', true],
      ['abnormal', true],
    ]);
    expect(report.miss_rate).toBe(0);

    // 去掉一个区间查询的录制：对应引用判为数据源报错，卡片不能判为正常，未命中率大于 0
    const pruned: QuerySnapshot = { ...snap, entries: snap.entries.filter((e) => e.op !== 'query_range') };
    const missed = await replaySnapshot(set, pruned);
    expect(missed.miss_rate).toBeGreaterThan(0);
    expect(missed.cases[0]!.verdict).not.toBe('normal');
    expect(missed.cases[1]!.verdict).toBe('undeterminable');
  });

  it('test --replay 执行包内 tests/replay 下的快照', async () => {
    out.length = 0;
    expect(await runPackCli(['test', ...common, '--only', '_example', '--replay'], io)).toBe(0);
    expect(out.join('')).toMatch(/快照未命中率 0\.0%/);
  });

  it('test --test 只执行指定包的测试，其余包照常加载', async () => {
    out.length = 0;
    expect(
      await runPackCli(['test', ...common, '--only', '_example', '--only', 'node', '--test', '_example'], io),
    ).toBe(0);
    const text = out.join('');
    expect(text).toMatch(/通过 {2}_example/);
    expect(text).not.toMatch(/通过 {2}node/);
    await expect(runPackCli(['test', ...common, '--only', 'node', '--test', 'missing'], io)).rejects.toThrow(
      /--test 指定的包 missing 没有加载/,
    );
  });

  it('doctor 报告信号、未映射告警与没有证据链的组件', async () => {
    out.length = 0;
    const at = new Date(T0 + 60 * MIN).toISOString();
    expect(await runPackCli(['doctor', ...common, '--prometheus', prom.url, '--at', at, '--json'], io)).toBe(0);
    const report = JSON.parse(out.join('')) as {
      signals: Array<{ signal: string; selected: number | null }>;
      unmapped_alerts: Array<{ alertname: string }>;
    };
    expect(report.unmapped_alerts.map((a) => a.alertname)).toEqual(['TeamCustomAlert']);
    expect(report.signals.find((s) => s.signal === '_example/container_memory_limit_ratio')?.selected).toBe(1);
    expect(report.signals.find((s) => s.signal === 'postgres/instance_up')?.selected).toBeNull();
  });
});
