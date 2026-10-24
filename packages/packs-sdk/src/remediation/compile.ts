// remediations.yaml 的编译（ADR 0103）：CEL、ICU 文案、inputs 引用的信号与 verify 引用的卡片在加载时检查。

import type { Environment } from '@marcbachmann/cel-js';
import type { Estimate, LocalizedText, Remediation, Signal } from '@srenautix/contract';
import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { IntlMessageFormat } from 'intl-messageformat';
import { PackLintError } from '../cel/errors.js';
import type { LoadedPack } from '../pack/load.js';
import { registerRemediationFunctions } from './functions.js';
import { parsePath } from './path.js';

export type Fn = (ctx: Record<string, unknown>) => unknown;

export interface CompiledMessage {
  text: LocalizedText;
  formats: Partial<Record<'zh-CN' | 'en', IntlMessageFormat>>;
}

export interface CompiledRemediation {
  pack: string;
  /** <pack>/<id> */
  key: string;
  def: Remediation;
  when: Fn;
  /** entity 为 null 时查询根因 */
  inputs: Array<{ name: string; signal: string; entity: Fn | null }>;
  lets: Array<{ name: string; run: Fn }>;
  skips: Array<{ run: Fn; say: CompiledMessage }>;
  edits: Array<{
    file: string;
    document: { kind?: string; name?: string } | null;
    locate: string | null;
    set: Array<{ path: string | null; field: string | null; value: Fn }>;
    append: Array<{ path: string; value: Fn }>;
  }>;
  change: CompiledMessage;
  verify: CompiledMessage;
  rollback: CompiledMessage;
  /** applies 为 goal 的模板（契约 2.28.0）：安全约束与预期收益 */
  guards: Array<{ id: string; run: Fn; say: CompiledMessage }>;
  estimate: CompiledEstimate | null;
}

export interface CompiledEstimate {
  indicator: string;
  unit: string;
  lower: Fn;
  expected: Fn;
  basis: CompiledMessage;
}

/** 运行时为模板提供的变量；goal、finding、finding_cards、gates 只在主动优化的计划中有值（契约 2.28.0） */
export const REMEDIATION_VARIABLES = [
  'incident',
  'root',
  'research',
  'cards',
  'root_cards',
  'alerts',
  'params',
  'files',
  'fields',
  'history',
  'goal',
  'finding',
  'finding_cards',
  'gates',
] as const;

/**
 * 预期收益的编译（ADR 0146 §2.5）：lower 与 expected 是 CEL，basis 是 ICU 文案，可引用 allowedArgs 与 lower、expected
 */
export function compileEstimate(
  est: Estimate,
  compile: (src: string, what: string) => Fn,
  allowedArgs: ReadonlySet<string>,
  fail: (detail: string) => never,
): CompiledEstimate {
  const formats: CompiledMessage['formats'] = {};
  for (const [loc, src] of Object.entries(est.basis) as Array<['zh-CN' | 'en', string]>) {
    const f = new IntlMessageFormat(src, loc);
    const args = new Set<string>();
    messageArgs(f.getAst(), args);
    for (const a of args) {
      if (!allowedArgs.has(a) && a !== 'lower' && a !== 'expected') {
        fail(`estimate.basis 的文案引用了未定义的参数 ${a}`);
      }
    }
    formats[loc] = f;
  }
  return {
    indicator: est.indicator,
    unit: est.unit,
    lower: compile(est.lower, 'estimate.lower'),
    expected: compile(est.expected, 'estimate.expected'),
    basis: { text: est.basis, formats },
  };
}

/** 主动优化的上下文变量在 CEL 中的类型 */
export function registerGoalVariables(env: Environment): Environment {
  return env
    .registerVariable('goal', 'dyn')
    .registerVariable('finding', 'dyn')
    .registerVariable('finding_cards', 'map')
    .registerVariable('gates', 'map');
}

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

export function compileRemediations(
  base: Environment,
  active: LoadedPack[],
  signals: Map<string, { pack: string; signal: Signal }>,
  cardKeys: ReadonlySet<string>,
): CompiledRemediation[] {
  const out: CompiledRemediation[] = [];
  for (const p of active) {
    const ids = new Set<string>();
    for (const r of p.content.remediations.remediations) {
      const where = `${p.dir}/remediations.yaml：${r.id}`;
      const fail = (detail: string): never => {
        throw new PackLintError(where, detail);
      };
      if (ids.has(r.id)) {
        fail(`模板 id ${r.id} 重复`);
      }
      ids.add(r.id);

      const inputNames = (r.inputs ?? []).map((i) => i.name);
      const letNames = (r.let ?? []).map((l) => l.name);
      const reserved = new Set<string>([...REMEDIATION_VARIABLES, 'current']);
      for (const n of [...inputNames, ...letNames]) {
        if (reserved.has(n) || [...inputNames, ...letNames].filter((x) => x === n).length > 1) {
          fail(`inputs 或 let 名 ${n} 重复或与保留名冲突`);
        }
      }
      for (const i of r.inputs ?? []) {
        const sig = signals.get(`${p.name}/${i.signal}`)?.signal;
        if (!sig) {
          fail(`inputs.${i.name} 引用的信号 ${i.signal} 不在本包中`);
        }
        if (sig!.kind !== 'metrics') {
          fail(`inputs.${i.name} 引用的信号 ${i.signal} 必须是 metrics 信号`);
        }
      }
      for (const c of r.verify.cards ?? []) {
        if (!cardKeys.has(c)) {
          fail(`verify.cards 引用的卡片 ${c} 不存在`);
        }
      }

      const goal = (r.applies ?? 'incident') === 'goal';
      if (goal && !r.estimate) {
        fail('applies 为 goal 的模板必须写 estimate（预期收益，ADR 0146 §2.5）');
      }
      if (!goal && (r.estimate || r.guard?.length || r.verify.guards?.length)) {
        fail('estimate、guard 与 verify.guards 只用于 applies 为 goal 的模板');
      }
      const env = registerGoalVariables(registerRemediationFunctions(base.clone()));
      for (const v of REMEDIATION_VARIABLES) {
        if (v === 'goal' || v === 'finding' || v === 'finding_cards' || v === 'gates') {
          continue;
        }
        env.registerVariable(
          v,
          v === 'alerts' || v === 'history' ? 'list' : v === 'root' || v === 'research' ? 'dyn' : 'map',
        );
      }
      for (const n of inputNames) {
        env.registerVariable(n, 'list');
      }
      for (const n of letNames) {
        env.registerVariable(n, 'dyn');
      }
      const valueEnv = env.clone().registerVariable('current', 'dyn');
      const compile = (src: string, what: string, e: Environment = env): Fn => {
        const c = e.check(src);
        if (!c.valid) {
          fail(`${what} 的 CEL 不合法：${c.error?.message ?? ''}：${src}`);
        }
        const parsed = e.parse(src);
        return (ctx) => parsed(ctx);
      };
      const allowedArgs = new Set([...letNames, ...Object.keys(r.params ?? {})]);
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
      const checkPath = (path: string, what: string) => {
        try {
          // {变量} 先换成占位值再检查语法
          parsePath(path.replace(/\{([a-z_][a-z0-9_]*)\}/g, 'x'));
        } catch (err) {
          fail(`${what}：${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const edits = r.edits.map((e, i) => {
        if (!(e.set?.length || e.append?.length)) {
          fail(`edits[${i}] 没有 set 或 append`);
        }
        if (e.locate) {
          checkPath(e.locate, `edits[${i}].locate`);
        }
        return {
          file: e.file,
          document: e.document ?? null,
          locate: e.locate ?? null,
          set: (e.set ?? []).map((s, j) => {
            if ((s.path === undefined) === (s.field === undefined)) {
              fail(`edits[${i}].set[${j}] 需要且只能给出 path 或 field 之一`);
            }
            if (s.path) {
              checkPath(s.path, `edits[${i}].set[${j}].path`);
            }
            return {
              path: s.path ?? null,
              field: s.field ?? null,
              value: compile(s.value, `edits[${i}].set[${j}].value`, valueEnv),
            };
          }),
          append: (e.append ?? []).map((a, j) => {
            checkPath(a.path, `edits[${i}].append[${j}].path`);
            return { path: a.path, value: compile(a.value, `edits[${i}].append[${j}].value`) };
          }),
        };
      });

      out.push({
        pack: p.name,
        key: `${p.name}/${r.id}`,
        def: r,
        when: compile(r.when, 'when'),
        inputs: (r.inputs ?? []).map((i) => ({
          name: i.name,
          signal: i.signal,
          entity: i.entity !== undefined ? compile(i.entity, `inputs.${i.name}.entity`) : null,
        })),
        lets: (r.let ?? []).map((l) => ({ name: l.name, run: compile(l.cel, `let ${l.name}`) })),
        skips: (r.skip_if ?? []).map((s, i) => ({
          run: compile(s.cel, `skip_if[${i}]`),
          say: message(s.say, `skip_if[${i}]`),
        })),
        edits,
        change: message(r.change, 'change'),
        verify: message(r.verify.say, 'verify'),
        rollback: message(r.rollback.say, 'rollback'),
        guards: (r.guard ?? []).map((g, i) => {
          if ((r.guard ?? []).findIndex((x) => x.id === g.id) !== i) {
            fail(`guard 的 id ${g.id} 重复`);
          }
          return { id: g.id, run: compile(g.cel, `guard ${g.id}`), say: message(g.say, `guard ${g.id}`) };
        }),
        estimate: r.estimate ? compileEstimate(r.estimate, (s, w) => compile(s, w), allowedArgs, fail) : null,
      });
    }
  }
  return out;
}
