// 领域包给技能的绑定（skill-bindings.yaml，ADR 0181 §5）：(技能, id) 全局唯一；一个工作负载对同一个技能最多一个绑定；
// data 按技能的 binding.schema.json 校验；data 中名为 signal 的字符串都必须是加载的领域包里的信号。

import type { SkillBinding } from '@srenautix/contract';
import type { PackSet } from '../pack/compile.js';
import type { LoadedSkill } from './manifest.js';

export interface ResolvedBinding {
  pack: string;
  skill: string;
  id: string;
  workloads: SkillBinding['workloads'];
  data: Record<string, unknown>;
}

export class BindingError extends Error {
  override name = 'BindingError';
}

function signalsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    v.forEach((x) => signalsIn(x, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'signal' && typeof x === 'string') {
        out.push(x);
      } else {
        signalsIn(x, out);
      }
    }
  }
  return out;
}

/** 全部加载的包中给这个技能的绑定；不合法时抛出 BindingError（技能的这个版本不加载） */
export function bindingsFor(set: PackSet, skill: LoadedSkill): ResolvedBinding[] {
  const out: ResolvedBinding[] = [];
  const workloads = new Map<string, string>();
  for (const p of set.packs) {
    for (const b of p.content.skill_bindings.bindings) {
      if (b.skill !== skill.name) {
        continue;
      }
      const where = `${p.name}/skill-bindings.yaml 的绑定 ${b.id}`;
      if (out.some((x) => x.id === b.id)) {
        throw new BindingError(`${where}：技能 ${skill.name} 的绑定 id 重复`);
      }
      if (!skill.binding) {
        throw new BindingError(`${where}：技能 ${skill.name} 不接受绑定`);
      }
      if (!skill.binding(b.data)) {
        const errs = (skill.binding.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`);
        throw new BindingError(`${where}：data 不符合 ${skill.name}/binding.schema.json：${errs.join('；')}`);
      }
      for (const sig of signalsIn(b.data)) {
        if (!set.signals.has(sig)) {
          throw new BindingError(`${where}：引用的信号 ${sig} 不在加载的领域包中`);
        }
      }
      for (const w of b.workloads) {
        const k = `${w.kind}:${w.namespace}/${w.name}`;
        const prev = workloads.get(k);
        if (prev) {
          throw new BindingError(`${where}：工作负载 ${k} 已经由绑定 ${prev} 绑定`);
        }
        workloads.set(k, b.id);
      }
      out.push({ pack: p.name, skill: b.skill, id: b.id, workloads: b.workloads, data: b.data });
    }
  }
  return out;
}

/** 绑定了这个工作负载的绑定 */
export function bindingOf(
  bindings: readonly ResolvedBinding[],
  subject: { kind: string; namespace: string; name: string },
): ResolvedBinding | null {
  return (
    bindings.find((b) =>
      b.workloads.some((w) => w.kind === subject.kind && w.namespace === subject.namespace && w.name === subject.name),
    ) ?? null
  );
}
