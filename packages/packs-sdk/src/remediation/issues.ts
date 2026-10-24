// issues.yaml：业务仓库 issue 模板（契约 2.28.0，ADR 0146 §4.4）。模板只给出适用条件、锚点、建议、预期收益与验证计划；
// server 用这里的计划渲染 issue 并在业务仓库创建，从不提交 PR。代码定位（锚点 → 文件与函数）由 server 执行。

import type { Environment } from '@marcbachmann/cel-js';
import type { IssueTemplate, LocalizedText } from '@srenautix/contract';
import { IntlMessageFormat } from 'intl-messageformat';
import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { PackLintError } from '../cel/errors.js';
import type { LoadedPack } from '../pack/load.js';
import {
  compileEstimate,
  registerGoalVariables,
  type CompiledEstimate,
  type CompiledMessage,
  type Fn,
} from './compile.js';
import { registerRemediationFunctions, toPlain } from './functions.js';

export interface CompiledIssue {
  pack: string;
  /** <pack>/<id> */
  key: string;
  def: IssueTemplate;
  when: Fn;
  lets: Array<{ name: string; run: Fn }>;
  locate: Array<{ kind: IssueTemplate['locate'][number]['kind']; from: Fn }>;
  suggestion: CompiledMessage;
  estimate: CompiledEstimate;
  verify: CompiledMessage;
}

/** 模板的变量：goal、finding、finding_cards、gates 与 params */
export const ISSUE_VARIABLES = ['goal', 'finding', 'finding_cards', 'gates', 'params'] as const;

function messageArgs(els: MessageFormatElement[], out: Set<string>): void {
  for (const el of els) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) {
      continue;
    }
    if (el.type === TYPE.tag) {
      messageArgs(el.children, out);
      continue;
    }
    out.add(el.value);
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      Object.values(el.options).forEach((o) => messageArgs(o.value, out));
    }
  }
}

export function compileIssues(base: Environment, active: LoadedPack[], cardKeys: ReadonlySet<string>): CompiledIssue[] {
  const out: CompiledIssue[] = [];
  for (const p of active) {
    const ids = new Set<string>();
    for (const t of p.content.issues.issues) {
      const where = `${p.dir}/issues.yaml：${t.id}`;
      const fail = (detail: string): never => {
        throw new PackLintError(where, detail);
      };
      if (ids.has(t.id)) {
        fail(`模板 id ${t.id} 重复`);
      }
      ids.add(t.id);
      const letNames = (t.let ?? []).map((l) => l.name);
      for (const n of letNames) {
        if ((ISSUE_VARIABLES as readonly string[]).includes(n) || letNames.filter((x) => x === n).length > 1) {
          fail(`let 名 ${n} 重复或与保留名冲突`);
        }
      }
      for (const c of t.verify.cards ?? []) {
        if (!cardKeys.has(c)) {
          fail(`verify.cards 引用的卡片 ${c} 不存在`);
        }
      }
      const env = registerGoalVariables(registerRemediationFunctions(base.clone())).registerVariable('params', 'map');
      for (const n of letNames) {
        env.registerVariable(n, 'dyn');
      }
      const compile = (src: string, what: string): Fn => {
        const c = env.check(src);
        if (!c.valid) {
          fail(`${what} 的 CEL 不合法：${c.error?.message ?? ''}：${src}`);
        }
        const parsed = env.parse(src);
        return (ctx) => parsed(ctx);
      };
      const allowedArgs = new Set([...letNames, ...Object.keys(t.params ?? {})]);
      const message = (text: LocalizedText, what: string): CompiledMessage => {
        const formats: CompiledMessage['formats'] = {};
        for (const [loc, src] of Object.entries(text) as Array<['zh-CN' | 'en', string]>) {
          const f = new IntlMessageFormat(src, loc);
          const args = new Set<string>();
          messageArgs(f.getAst(), args);
          for (const a of args) {
            if (!allowedArgs.has(a)) {
              fail(`${what} 的文案引用了未定义的参数 ${a}`);
            }
          }
          formats[loc] = f;
        }
        return { text, formats };
      };
      out.push({
        pack: p.name,
        key: `${p.name}/${t.id}`,
        def: t,
        when: compile(t.when, 'when'),
        lets: (t.let ?? []).map((l) => ({ name: l.name, run: compile(l.cel, `let ${l.name}`) })),
        locate: t.locate.map((l, i) => ({ kind: l.kind, from: compile(l.from, `locate[${i}].from`) })),
        suggestion: message(t.suggestion, 'suggestion'),
        estimate: compileEstimate(t.estimate, compile, allowedArgs, fail),
        verify: message(t.verify.say, 'verify'),
      });
    }
  }
  return out;
}

/** 主动优化的模板上下文（契约 2.28.0）：目标、发现、发现的卡与领域门槛 */
export interface GoalTemplateContext {
  /** GoalSpec 加上 goal_id 与 revision */
  goal: Record<string, unknown>;
  /** 契约 Finding */
  finding: Record<string, unknown>;
  /** 卡片全局 id → 结论（verdict、display_state、value、observations），形状同 RemediationCard */
  finding_cards: Record<string, unknown>;
  /** 领域门槛（ResolvedGates） */
  gates: Record<string, unknown>;
}

export interface EstimateResult {
  indicator: string;
  unit: string;
  lower: number;
  expected: number | null;
  basis: LocalizedText;
}

export function formatMessage(msg: CompiledMessage, vars: Record<string, unknown>): LocalizedText {
  const args = Object.fromEntries(
    Object.entries(vars).map(([k, v]) => {
      const p = toPlain(v);
      return [k, typeof p === 'object' && p !== null ? JSON.stringify(p) : p];
    }),
  ) as Record<string, string | number | boolean>;
  const out: LocalizedText = {};
  for (const [loc, f] of Object.entries(msg.formats) as Array<
    ['zh-CN' | 'en', NonNullable<CompiledMessage['formats']['en']>]
  >) {
    out[loc] = String(f.format(args));
  }
  return out;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** 预期收益求值：lower 必须是有限数值，expected 不是有限数值时为 null */
export function evaluateEstimate(
  est: CompiledEstimate,
  vars: Record<string, unknown>,
  msgVars: Record<string, unknown>,
): EstimateResult {
  const lower = finite(est.lower(vars));
  if (lower === null) {
    throw new TypeError('estimate.lower 的结果不是有限数值');
  }
  const expected = finite(est.expected(vars));
  return {
    indicator: est.indicator,
    unit: est.unit,
    lower,
    expected,
    basis: formatMessage(est.basis, { ...msgVars, lower, expected: expected ?? '—' }),
  };
}

export interface IssuePlan {
  kind: 'issue';
  key: string;
  pack: string;
  id: string;
  domain: string;
  title: LocalizedText;
  /** 代码定位的锚点，按模板的顺序；取值为空串或 null 的锚点不在其中 */
  anchors: Array<{ kind: IssueTemplate['locate'][number]['kind']; value: string }>;
  suggestion: LocalizedText;
  estimate: EstimateResult;
  verify: { say: LocalizedText; cards: string[]; within: string | null; guards: string[] };
  labels: string[];
}

export interface IssueSkip {
  kind: 'skipped';
  key: string;
  code: 'not_applicable' | 'evaluation_error' | 'no_anchor';
  reason: LocalizedText;
}

const both = (zh: string, en: string): LocalizedText => ({ 'zh-CN': zh, en });

/** 适用条件为 true 的业务 issue 模板；domain 给出时只看这个领域的模板 */
export function applicableIssues(
  issues: readonly CompiledIssue[],
  ctx: GoalTemplateContext,
  domain?: string,
): { applicable: string[]; errors: Array<{ key: string; message: string }> } {
  const applicable: string[] = [];
  const errors: Array<{ key: string; message: string }> = [];
  for (const t of issues) {
    if (domain !== undefined && t.def.domain !== domain) {
      continue;
    }
    try {
      if (t.when({ ...ctx, params: t.def.params ?? {} }) === true) {
        applicable.push(t.key);
      }
    } catch (err) {
      errors.push({ key: t.key, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applicable, errors };
}

/** 一个业务 issue 模板在一个发现上的计划：锚点、建议、预期收益与验证计划 */
export function planIssue(
  issues: readonly CompiledIssue[],
  key: string,
  ctx: GoalTemplateContext,
): IssuePlan | IssueSkip {
  const t = issues.find((x) => x.key === key);
  if (!t) {
    throw new Error(`没有业务 issue 模板 ${key}`);
  }
  const params = t.def.params ?? {};
  const vars: Record<string, unknown> = { ...ctx, params };
  const lets: Record<string, unknown> = {};
  try {
    if (t.when(vars) !== true) {
      return {
        kind: 'skipped',
        key,
        code: 'not_applicable',
        reason: both('适用条件不成立', 'The template does not apply'),
      };
    }
    for (const l of t.lets) {
      const v = l.run(vars);
      vars[l.name] = v;
      lets[l.name] = v;
    }
    const anchors = t.locate.flatMap((l) => {
      const v = toPlain(l.from(vars));
      return v === null || v === undefined || v === '' ? [] : [{ kind: l.kind, value: String(v) }];
    });
    if (!anchors.length) {
      return {
        kind: 'skipped',
        key,
        code: 'no_anchor',
        reason: both('没有可用于代码定位的锚点', 'No anchor is available to locate the code'),
      };
    }
    const msgVars = { ...params, ...lets };
    return {
      kind: 'issue',
      key,
      pack: t.pack,
      id: t.def.id,
      domain: t.def.domain,
      title: t.def.title,
      anchors,
      suggestion: formatMessage(t.suggestion, msgVars),
      estimate: evaluateEstimate(t.estimate, vars, msgVars),
      verify: {
        say: formatMessage(t.verify, msgVars),
        cards: t.def.verify.cards ?? [],
        within: t.def.verify.within ?? null,
        guards: t.def.verify.guards ?? [],
      },
      labels: t.def.labels ?? [],
    };
  } catch (err) {
    return {
      kind: 'skipped',
      key,
      code: 'evaluation_error',
      reason: both(`求值出错：${String(err)}`, `Evaluation failed: ${String(err)}`),
    };
  }
}
