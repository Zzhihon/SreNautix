import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertCatalogEntry } from '@srenautix/contract';
import { loadPromqlEngine, postgresBins, startPostgres, type TestPostgres } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compilePackSet } from '../src/pack/compile.js';
import { generateKpsConditions } from '../src/pack/kps-conditions.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { generateUpstreamConditions } from '../src/pack/upstream-conditions.js';
import { alertRulesFrom } from '../src/testing/alert-consistency.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { checkCoverage, loadChartPin, renderUpstreamRules } from '../src/testing/upstream-rules.js';
import { CATALOG, PACKS, REPO } from './support.js';

describe('内置领域包', () => {
  it('全部包一起编译：交叉引用、CEL、PromQL 严格解析、规则提议的动作都合法', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
    expect(set.disabled).toEqual([]);
    expect(set.lockDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('kps-conditions 与生成器一致，alerts-kps 的主卡在 kubernetes-mixin 的夹具上与 chart 渲染的规则结论一致', async () => {
    const g = await generateKpsConditions(REPO);
    const read = (p: string) => parse(readFileSync(join(PACKS, p), 'utf8')) as unknown;
    // 仓库内容与生成结果一致（不比较格式；更新执行 pnpm --filter @srenautix/packs-sdk run gen:kps-conditions）
    expect(read('kps-conditions/pack.yaml')).toEqual(g.manifest);
    expect(read('kps-conditions/signals.yaml')).toEqual({ signals: g.pack.signals });
    expect(read('kps-conditions/chains.yaml')).toEqual({ chains: g.pack.chains });
    expect(readdirSync(join(PACKS, 'kps-conditions/tests')).sort()).toEqual([...g.tests.keys()].sort());
    for (const [name, t] of g.tests) {
      expect(read(`kps-conditions/tests/${name}`)).toEqual(t);
    }
    const entries = (read('alerts-kps/alerts.yaml') as { entries: AlertCatalogEntry[] }).entries;
    for (const e of entries.filter((x) => !g.skip.has(x.id))) {
      expect(e.primary_card).toBe(`kps-conditions/${e.id}/condition`);
      expect(e.chains).toContain(`kps-conditions/${e.id}`);
    }
    expect(g.firing).toBeGreaterThan(10);

    const set = await shared;
    const report = await runPackTests({
      set,
      packs: ['kps-conditions'],
      alertRules: alertRulesFrom(g.rules, 'kube-prometheus-stack', await loadPromqlEngine()),
    });
    expect(report.cases.filter((c) => !c.passed)).toEqual([]);
    // 每个夹具测试在两个后端上各核对一次
    expect(report.alert_checks).toBe(2 * report.cases.filter((c) => c.kind === 'fixture').length);
  });

  it('upstream-conditions 与生成器一致，社区包的条目都有主卡，夹具上主卡与上游规则结论一致', async () => {
    const g = await generateUpstreamConditions(REPO);
    const read = (p: string) => parse(readFileSync(join(PACKS, p), 'utf8')) as unknown;
    // 仓库内容与生成结果一致（不比较格式；更新执行 pnpm --filter @srenautix/packs-sdk run gen:upstream-conditions）
    expect(read('upstream-conditions/pack.yaml')).toEqual(g.manifest);
    expect(read('upstream-conditions/signals.yaml')).toEqual({ signals: g.pack.signals });
    expect(read('upstream-conditions/chains.yaml')).toEqual({ chains: g.pack.chains });
    expect(readdirSync(join(PACKS, 'upstream-conditions/tests')).sort()).toEqual([...g.tests.keys()].sort());
    for (const [name, t] of g.tests) {
      expect(read(`upstream-conditions/tests/${name}`)).toEqual(t);
    }
    for (const [pack, ids] of g.targets) {
      const entries = (read(`${pack}/alerts.yaml`) as { entries: AlertCatalogEntry[] }).entries;
      for (const e of entries.filter((x) => ids.includes(x.id))) {
        expect(e.primary_card).toBe(`upstream-conditions/${e.id}/condition`);
        expect(e.chains).toContain(`upstream-conditions/${e.id}`);
      }
    }
    // 每个没有手写主卡的条目在上游都有同名规则
    expect(g.missing).toEqual([]);
    expect(g.firing).toBeGreaterThan(0);

    const set = await shared;
    const report = await runPackTests({
      set,
      packs: ['upstream-conditions'],
      alertRules: alertRulesFrom(g.rules, 'community-rules', await loadPromqlEngine()),
    });
    expect(report.cases.filter((c) => !c.passed)).toEqual([]);
    expect(report.alert_checks).toBe(2 * report.cases.filter((c) => c.kind === 'fixture').length);
  });

  it('内置包中有证据链的条目都声明了主卡', async () => {
    const set = await shared;
    const without = set.packs.flatMap((p) =>
      p.content.alerts.entries.filter((e) => e.chains?.length && !e.primary_card).map((e) => e.id),
    );
    expect(without).toEqual([]);
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
});

// 每个包单独一个测试，各自启动后端，并发执行（vitest 的 maxConcurrency）
const names = loadBuiltinPacks(PACKS).map((p) => p.name);
const shared = compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });

// 带 input_sql 的夹具在真实 PostgreSQL 上执行（SRENAUTIX_PG_BINS 或 SRENAUTIX_PG_BIN 的第一个版本，ADR 0146）
const pgBin = postgresBins()[0];
let postgres: TestPostgres | undefined;
beforeAll(async () => {
  if (pgBin) {
    postgres = await startPostgres(pgBin);
  }
});
afterAll(async () => {
  await postgres?.stop();
});

describe.concurrent(
  'stable 的包：每张卡都有夹具，在 Prometheus 与 VictoriaMetrics 上结论一致，自动测试全部通过',
  () => {
    it.each(names)('%s', async (name) => {
      const set = await shared;
      const report = await runPackTests({ set, packs: [name], ...(postgres ? { postgres } : {}) });
      expect(report.cases.filter((c) => !c.passed)).toEqual([]);
      expect(report.packs.filter((p) => !p.passed)).toEqual([]);
      expect(report.packs.map((p) => p.name)).toEqual([name]);
      // 有 PostgreSQL 时 input_sql 的夹具不能被跳过
      if (postgres) {
        expect(report.packs[0]!.skipped).toBeUndefined();
      }
    });
  },
);
