import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { compilePackSet } from '../src/pack/compile.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { CATALOG, PACKS } from './support.js';

// 用户包补充内置包的信号（Signal.extends，契约 2.26.0，ADR 0139）：应用没有 http_request_duration_seconds 时，
// 用户包为 workload 的 HPA 延迟信号补一个自己的指标，内置的 hpa-latency 卡（影响卡）因此能够判定

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

const PACK = `api_version: srenautix.io/pack/v1
name: shopx
version: 0.1.0
description: 为 gw 的 HPA 补充请求延迟信号
maturity: beta
min_srenautix_version: 0.1.0
requires: [metrics.query, metrics.query_range]
`;

// 只对伸缩对象是 gw 的 HPA 返回数据：被选中后这个备选用于全部 HPA，其余 HPA 查不到数据（无法判定）
const guard = (offset: string) =>
  `and on () max(kube_horizontalpodautoscaler_info{namespace="$namespace", horizontalpodautoscaler="$name", scaletargetref_name="gw"}${offset})`;
const SIGNALS = `signals:
  - id: gw_latency_p95
    kind: metrics
    unit: seconds
    extends: workload/hpa_target_latency_p95
    alternatives:
      - expr: 'max(shop_gw_latency_p95_seconds{namespace="$namespace"}) ${guard('')}'
  - id: gw_latency_p95_baseline
    kind: metrics
    unit: seconds
    extends: workload/hpa_target_latency_p95_baseline
    alternatives:
      - expr: 'max(shop_gw_latency_p95_seconds{namespace="$namespace"} offset 1d) ${guard('')}'
`;

// 每 30 分钟一个点、26 小时：gw 第一天 0.05 秒，之后 0.4 秒；calm 的 HPA 伸缩别的对象
const TESTS = `api_version: srenautix.io/pack-test/v1
interval: 30m
input_series:
  - { series: 'kube_horizontalpodautoscaler_info{namespace="shop",horizontalpodautoscaler="gw",scaletargetref_kind="StatefulSet",scaletargetref_name="gw"}', values: '1x52' }
  - { series: 'kube_horizontalpodautoscaler_info{namespace="shop",horizontalpodautoscaler="calm",scaletargetref_kind="Deployment",scaletargetref_name="calm"}', values: '1x52' }
  - { series: 'shop_gw_latency_p95_seconds{namespace="shop"}', values: '0.05x48 0.4x4' }
tests:
  - { name: gw 的 p95 是一天前的 8 倍, eval_time: 25h, card: workload/capacity/hpa-latency, entity: { kind: HorizontalPodAutoscaler, namespace: shop, name: gw }, expect: { verdict: abnormal } }
  - { name: calm 没有延迟数据, eval_time: 25h, card: workload/capacity/hpa-latency, entity: { kind: HorizontalPodAutoscaler, namespace: shop, name: calm }, expect: { verdict: undeterminable } }
`;

function userPack(signals: string, tests: string | null = TESTS): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const dir = join(mkdtempSync(join(base, 'signal-extends-')), 'shopx');
  scratch.push(join(dir, '..'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), PACK);
  writeFileSync(join(dir, 'signals.yaml'), signals);
  if (tests) {
    writeFileSync(join(dir, 'tests', 'latency.yaml'), tests);
  }
  return dir;
}

const compile = (signals: string, tests: string | null = TESTS) =>
  compilePackSet([...loadBuiltinPacks(PACKS, ['workload']), loadPackDir(userPack(signals, tests), 'test')], {
    catalog: CATALOG,
  });

describe('补充别的包的信号', () => {
  it('补充的备选排在原有备选之前；补充信号本身仍是本包的信号', async () => {
    const set = await compile(SIGNALS);
    const merged = set.signals.get('workload/hpa_target_latency_p95')!.signal;
    const builtin = (await compilePackSet(loadBuiltinPacks(PACKS, ['workload']), { catalog: CATALOG })).signals.get(
      'workload/hpa_target_latency_p95',
    )!.signal;
    expect(merged.alternatives.map((a) => a.expr)).toEqual([
      expect.stringContaining('shop_gw_latency_p95_seconds'),
      ...builtin.alternatives.map((a) => a.expr),
    ]);
    expect(set.signals.get('workload/hpa_target_latency_p95')!.pack).toBe('workload');
    expect(set.signals.get('shopx/gw_latency_p95')!.signal.alternatives).toHaveLength(1);
  });

  it('内置的 hpa-latency 卡按补充的备选判定：gw 异常，其余 HPA 查不到数据', async () => {
    const set = await compile(SIGNALS);
    const report = await runPackTests({ set, packs: ['shopx'] });
    expect(report.cases.filter((c) => c.kind === 'fixture').map((c) => [c.name, c.passed, c.failure])).toEqual([
      ['gw 的 p95 是一天前的 8 倍', true, null],
      ['calm 没有延迟数据', true, null],
    ]);
  }, 300_000);

  it('补充的信号不存在、在本包中、类型不同或本身是补充时加载失败', async () => {
    await expect(
      compile(SIGNALS.replace('workload/hpa_target_latency_p95\n', 'workload/no_such\n'), null),
    ).rejects.toThrow(PackLintError);
    await expect(
      compile(
        `${SIGNALS}  - id: own
    kind: metrics
    alternatives: [{ expr: 'vector(1)' }]
  - id: own_ext
    kind: metrics
    extends: shopx/own
    alternatives: [{ expr: 'vector(2)' }]
`,
        null,
      ),
    ).rejects.toThrow(/只能补充别的包的信号/);
    await expect(
      compile(
        `${SIGNALS}  - id: logs_ext
    kind: logs
    extends: workload/hpa_target_ratio
    alternatives: [{ expr: 'error', dialect: logs_match }]
`,
        null,
      ),
    ).rejects.toThrow(/类型不同/);
  });
});
