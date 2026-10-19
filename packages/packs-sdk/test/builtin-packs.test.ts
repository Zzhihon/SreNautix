import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePackSet } from '../src/pack/compile.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { checkCoverage, loadChartPin, renderUpstreamRules } from '../src/testing/upstream-rules.js';
import { CATALOG, PACKS } from './support.js';

describe('内置领域包', () => {
  it('全部包一起编译：交叉引用、CEL、PromQL 严格解析、规则提议的动作都合法', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
    expect(set.disabled).toEqual([]);
    expect(set.lockDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('alerts-kps 覆盖固定版本 kube-prometheus-stack 的全部告警名，forecast 与 predict_linear 一致', async () => {
    const pin = loadChartPin(join(import.meta.dirname, '../upstream/kube-prometheus-stack.json'));
    const rules = await renderUpstreamRules(pin);
    const set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
    const kps = set.packs.find((p) => p.name === 'alerts-kps')!;
    const report = await checkCoverage(rules, kps.content.alerts.entries);
    expect(report.upstreamAlertnames).toBeGreaterThan(100);
    expect(report.missing).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.forecastMismatch).toEqual([]);
  });

  it('stable 的包：每张卡都有夹具，在 Prometheus 与 VictoriaMetrics 上结论一致，自动测试全部通过', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
    const report = await runPackTests({ set });
    expect(report.cases.filter((c) => !c.passed)).toEqual([]);
    expect(report.packs.filter((p) => !p.passed)).toEqual([]);
  });
});
