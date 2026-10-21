// kps-conditions 包（ADR 0109）：kube-prometheus-stack 告警规则的条件卡，alerts-kps 每个条目一张，作为条目的主卡。
// 生成脚本（scripts/kps-conditions.ts）与 builtin-packs 测试共用 generateKpsConditions，后者核对仓库与生成结果一致。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertCatalogEntry, PackManifest, PackTestFile } from '@srenautix/contract';
import { backendsDir, fetchVerified, loadPromqlEngine, placeAtomically } from '@srenautix/integration-sdk';
import { parse } from 'yaml';
import { loadChartPin, renderUpstreamRules, type UpstreamRule } from '../testing/upstream-rules.js';
import { generateConditionPack, type ConditionPack, type ConditionRule } from './conditions.js';
import { convertPromtoolTests } from './promtool-fixtures.js';

export const KPS_CONDITIONS = 'kps-conditions';

interface Pin {
  name: string;
  version: string;
}

interface MixinTestsPin {
  ref: string;
  url: string;
  files: Array<{ name: string; sha256: string }>;
}

/** 渲染出的上游规则 → 条件卡的规则（来源写 chart 名、版本与规则组，中英文说明共用） */
export function kpsConditionRules(pin: Pin, rules: readonly UpstreamRule[]): ConditionRule[] {
  return rules.map((r) => ({
    alert: r.alert,
    expr: r.expr,
    for: r.for,
    labels: Object.fromEntries(Object.entries(r.labels).filter(([, v]) => !v.includes('{{'))),
    source: `${pin.name} ${pin.version} (${r.group})`,
  }));
}

export function kpsConditionsManifest(pin: Pin): PackManifest {
  return {
    api_version: 'srenautix.io/pack/v1',
    name: KPS_CONDITIONS,
    version: pin.version,
    description: `${pin.name} ${pin.version} 告警规则的条件卡：alerts-kps 每个条目一张，查询与规则表达式相同，判定与规则的 for 相同，作为条目的主卡`,
    // 卡片由规则生成；夹具来自上游 kubernetes-mixin 的 promtool 测试，只覆盖能在后端复现的告警，所以不是 stable
    maturity: 'beta',
    min_srenautix_version: '0.1.0',
    requires: ['metrics.query', 'metrics.query_range'],
  };
}

export interface KpsConditions {
  manifest: PackManifest;
  pack: ConditionPack;
  /** 渲染出的全部规则（pack test --alert-rules 用） */
  rules: UpstreamRule[];
  /** 夹具文件名 → 内容 */
  tests: Map<string, PackTestFile>;
  /** alerts-kps 中不生成条件卡的条目（没有证据链：接入时丢弃的 Watchdog、InfoInhibitor） */
  skip: Set<string>;
  /** 有"触发"夹具的条目数 */
  firing: number;
}

/** 渲染 chart、下载固定提交的 kubernetes-mixin 测试，生成条件卡与夹具 */
export async function generateKpsConditions(repo: string): Promise<KpsConditions> {
  const upstream = join(repo, 'packages/packs-sdk/upstream');
  const pin = loadChartPin(join(upstream, 'kube-prometheus-stack.json'));
  const rendered = await renderUpstreamRules(pin);
  const rules = kpsConditionRules(pin, rendered);
  const entries = (
    parse(readFileSync(join(repo, 'packs/alerts-kps/alerts.yaml'), 'utf8')) as { entries: AlertCatalogEntry[] }
  ).entries;
  const skip = new Set(entries.filter((e) => !e.chains?.length).map((e) => e.id));
  const engine = await loadPromqlEngine();
  const pack = generateConditionPack(engine, rules, entries, skip);
  const mixin = JSON.parse(readFileSync(join(upstream, 'kubernetes-mixin-tests.json'), 'utf8')) as MixinTestsPin;
  // 与 chart 相同：下载（校验 sha256）到后端缓存目录，带完整标记原子落位
  const cache = join(backendsDir(), 'charts', `kubernetes-mixin-tests-${mixin.ref.slice(0, 12)}`);
  await placeAtomically(cache, async (staging) => {
    for (const f of mixin.files) {
      writeFileSync(join(staging, f.name), await fetchVerified(mixin.url + f.name, f.sha256));
    }
  });
  const tests = new Map<string, PackTestFile>();
  const firing = new Set<string>();
  for (const f of mixin.files) {
    const text = readFileSync(join(cache, f.name), 'utf8');
    const c = convertPromtoolTests(engine, f.name, text, entries, pack.ruleOf);
    for (const [name, t] of c.files) {
      tests.set(name, t);
    }
    c.firing.forEach((id) => firing.add(id));
  }
  return { manifest: kpsConditionsManifest(pin), pack, rules: rendered, tests, skip, firing: firing.size };
}
