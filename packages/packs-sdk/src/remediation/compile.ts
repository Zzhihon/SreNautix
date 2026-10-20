// remediations.yaml 的编译（ADR 0103）：CEL、ICU 文案、inputs 引用的信号与 verify 引用的卡片在加载时检查。

import type { Environment } from '@marcbachmann/cel-js';
import type { LocalizedText, Remediation, Signal } from '@srenautix/contract';
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
}

/** 运行时为模板提供的变量 */
export const REMEDIATION_VARIABLES = [
  'incident',
  'root',
  'cards',
  'alerts',
  'params',
  'files',
  'fields',
  'history',
] as const;

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

      const env = registerRemediationFunctions(base.clone());
      for (const v of REMEDIATION_VARIABLES) {
        env.registerVariable(v, v === 'alerts' || v === 'history' ? 'list' : v === 'root' ? 'dyn' : 'map');
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
      });
    }
  }
  return out;
}
