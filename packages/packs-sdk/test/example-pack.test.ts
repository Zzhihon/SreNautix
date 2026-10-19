import { describe, expect, it } from 'vitest';
import { compilePackSet } from '../src/pack/compile.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { evaluateRules } from '../src/runtime/rules.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { CATALOG, PACKS } from './support.js';

describe('_example 包', () => {
  it('在 Prometheus 与 VictoriaMetrics 上通过全部夹具与自动测试', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS, ['_example']), { catalog: CATALOG });
    const report = await runPackTests({ set });
    const failed = report.cases.filter((c) => !c.passed);
    expect(failed).toEqual([]);
    expect(report.packs).toEqual([{ name: '_example', maturity: 'stable', uncovered: [], passed: true }]);
    // 每张卡都有无数据测试；每个非无法判定的夹具结果都派生了部分无数据与报错测试
    const kinds = new Set(report.cases.map((c) => c.kind));
    expect(kinds).toEqual(new Set(['fixture', 'nodata', 'partial_nodata', 'datasource_error']));
  });

  it('规则提议引用目录中的动作', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS, ['_example']), { catalog: CATALOG });
    const ev = evaluateRules(set, {
      incident: { id: 'i1' },
      root: { cluster_id: 'c1', kind: 'Pod', namespace: 'shop', name: 'web-0', component_type: 'example.web' },
      cards: {
        '_example/pod-memory/limit-ratio': {
          verdict: 'abnormal',
          display_state: 'abnormal',
          value: '95%',
          reason_kind: 'rule',
        },
      },
    });
    expect(ev.errors).toEqual([]);
    expect(ev.proposals).toEqual([
      expect.objectContaining({
        rule_id: 'oom-restart-pod',
        action: 'pod_restart',
        params: { namespace: 'shop', pod: 'web-0' },
      }),
    ]);
  });
});
