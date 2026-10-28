// promtool 规则单元测试 → 条件卡的夹具测试（ADR 0109）。只转能在 pack test 的后端上复现的用例：
// - 规则表达式的每个选择器都匹配夹具里的原始序列（pack test 的后端不求值录制规则；chart 渲染的选择器与上游测试
//   的默认配置不同时，规则在这份数据上本来就不会触发）；
// - 表达式不用 time()、timestamp()（promtool 的时间零点是 1970 年，夹具是 2026 年），也不用 changes()、resets()
//   （序列起点处 Prometheus 与 VictoriaMetrics 的结果不同，上游夹具的序列从 0 开始）；
// - 夹具不含 stale（VictoriaMetrics 的导入接口不接受 staleness marker）。
// 期望：告警在 eval_time 触发（标签符合条目的 match_labels）→ 该实体的条件卡为异常；同一组里任何时刻都没有断言这条
// 告警触发 → 正常（实体取同一文件其他组里这条告警触发时的实体）。条件卡看整个卡片窗口，所以不转"此刻还没触发、
// 稍后会触发"的断言。

import type { AlertCatalogEntry, PackTestFile } from '@srenautix/contract';
import type { PromqlEngine } from '@srenautix/integration-sdk';
import { parse } from 'yaml';
import { ruleDialect, type ConditionRule } from './conditions.js';

interface PromtoolGroup {
  interval?: string;
  input_series?: Array<{ series: string; values: string }>;
  alert_rule_test?: Array<{
    eval_time: string;
    alertname: string;
    exp_alerts?: Array<{ exp_labels?: Record<string, string> }>;
  }>;
}

type Labels = Record<string, string>;

function matches(m: { label: string; op: string; value: string }, labels: Labels): boolean {
  const v = labels[m.label] ?? '';
  switch (m.op) {
    case '=':
      return v === m.value;
    case '!=':
      return v !== m.value;
    case '=~':
      return new RegExp(`^(?:${m.value})$`).test(v);
    case '!~':
      return !new RegExp(`^(?:${m.value})$`).test(v);
    default:
      throw new Error(`不支持的匹配器 ${m.op}`);
  }
}

/**
 * 规则能在这组夹具上按原样求值：不用 time()、timestamp()；表达式里的每个选择器（含指标名与全部匹配器）都匹配
 * 夹具里的某条序列。上游测试按 mixin 的默认配置写夹具，chart 渲染出的选择器（job、metrics_path 等）不同时，
 * 规则在这份数据上本来就不会触发，这样的组不转。缺失本身就是条件的规则（absent）只要求夹具里有 up。
 */
function reproducible(engine: PromqlEngine, expr: string, inputs: readonly Labels[]): boolean {
  const a = engine.analyze(expr, ruleDialect(engine, expr));
  // changes()、resets() 在序列起点处两个后端不同（VictoriaMetrics 把第一个样本算作一次变化），上游夹具的序列从 0 开始
  if (a.functions.some((f) => ['time', 'timestamp', 'changes', 'resets'].includes(f))) {
    return false;
  }
  if (a.functions.some((f) => f === 'absent' || f === 'absent_over_time')) {
    return inputs.some((l) => l.__name__ === 'up');
  }
  return a.selectors.every((s) =>
    inputs.some((l) => l.__name__ === s.metric && s.matchers.every((m) => m.label === '__name__' || matches(m, l))),
  );
}

export interface ConvertedFixtures {
  /** 文件名 → 夹具 */
  files: Map<string, PackTestFile>;
  /** 有"触发"用例的条目 id */
  firing: Set<string>;
}

/**
 * 转换一个 promtool 测试文件。chainOf：条目 id → 条件卡所在的证据链 id（卡片为 <链>/condition）；
 * ruleOf：条目 id → 对应的规则。
 */
export function convertPromtoolTests(
  engine: PromqlEngine,
  name: string,
  text: string,
  entries: readonly AlertCatalogEntry[],
  ruleOf: ReadonlyMap<string, readonly ConditionRule[]>,
): ConvertedFixtures {
  const doc = parse(text) as { tests?: PromtoolGroup[] };
  const files = new Map<string, PackTestFile>();
  const firing = new Set<string>();
  const base = name
    .replace(/\.ya?ml$/, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .toLowerCase();
  const groups = doc.tests ?? [];
  groups.forEach((g, gi) => {
    const series = g.input_series ?? [];
    if (!series.length || series.some((s) => /stale/.test(String(s.values)))) {
      return;
    }
    const inputs = series.map((s) => engine.parseSeries(`${s.series} ${s.values}`).labels as Labels);
    const cases: Array<NonNullable<PackTestFile['tests']>[number]> = [];
    for (const t of g.alert_rule_test ?? []) {
      for (const e of entries.filter((x) => x.alertname === t.alertname && ruleOf.has(x.id))) {
        if (!ruleOf.get(e.id)!.every((r) => reproducible(engine, r.expr, inputs))) {
          continue;
        }
        const mine = (alerts: Array<{ exp_labels?: Record<string, string> }>) =>
          alerts.filter((a) => Object.entries(e.match_labels ?? {}).every(([k, v]) => (a.exp_labels ?? {})[k] === v));
        const nameOf = (labels: Record<string, string>) =>
          (e.entity.name_labels ?? []).map((l) => labels[l]).find((v) => v !== undefined && v !== '');
        const entity = (name: string, ns: string | null | undefined) => ({
          kind: e.entity.kind,
          ...(ns ? { namespace: ns } : {}),
          name,
        });
        const fired = mine(t.exp_alerts ?? []);
        if (fired.length) {
          for (const a of fired) {
            const n = nameOf(a.exp_labels ?? {});
            if (!n) {
              continue;
            }
            cases.push({
              name: `${t.alertname} 在 ${t.eval_time} 触发（${name}#${gi + 1}）`,
              eval_time: t.eval_time,
              card: `${e.id}/condition`,
              entity: entity(n, a.exp_labels?.namespace),
              expect: { verdict: 'abnormal' },
            });
            firing.add(e.id);
          }
          continue;
        }
        if ((g.alert_rule_test ?? []).some((o) => o.alertname === t.alertname && mine(o.exp_alerts ?? []).length)) {
          continue;
        }
        const other = groups
          .flatMap((og) => og.alert_rule_test ?? [])
          .filter((o) => o.alertname === t.alertname)
          .flatMap((o) => mine(o.exp_alerts ?? []))
          .map((a) => ({ n: nameOf(a.exp_labels ?? {}), ns: a.exp_labels?.namespace }))
          .find((x) => x.n);
        if (!other?.n) {
          continue;
        }
        cases.push({
          name: `${t.alertname} 在 ${t.eval_time} 没有触发（${name}#${gi + 1}）`,
          eval_time: t.eval_time,
          card: `${e.id}/condition`,
          entity: entity(other.n, other.ns),
          expect: { verdict: 'normal' },
        });
      }
    }
    const [first, ...rest] = cases;
    if (first) {
      files.set(`${base}-${gi + 1}.yaml`, {
        api_version: 'srenautix.io/pack-test/v1',
        interval: g.interval ?? '1m',
        input_series: series.map((s) => ({ series: s.series, values: String(s.values) })),
        tests: [first, ...rest],
      });
    }
  });
  return { files, firing };
}
