// 把加载并合并好的包编译成可执行的包集合：
// - 解析并检查所有交叉引用（信号、证据链、组件类型、依赖包、动作目录）；
// - 编译每张卡的 CEL（含求值成本上界），渲染并严格解析每个指标备选；
// - 按可用能力处理 requires（缺失时整个包禁用并给出原因）。

import type { EvidenceChain, LabelProfile, PackRule, Signal } from '@srenautix/contract';
import { Environment } from '@marcbachmann/cel-js';
import { loadPromqlEngine, type PromqlEngine } from '@srenautix/integration-sdk';
import { PackLintError } from '../cel/errors.js';
import { createBaseEnvironment } from '../cel/library.js';
import { compileCard, type CompiledCard } from '../judge/card.js';
import type { CardDefinition } from '../judge/types.js';
import { renderMetrics } from '../signals/render.js';
import type { ActionCatalog } from './catalog.js';
import { applyLayers, type LoadedLayer } from './layers.js';
import type { LoadedPack } from './load.js';
import { computeLock, lockDigest, verifyLock } from './lock.js';
import type { PackLock } from '@srenautix/contract';

export interface CardEntry {
  /** <pack>/<chain>/<card> 或 <pack>/checks/<id> */
  key: string;
  pack: string;
  chain: string | null;
  def: CardDefinition;
  compiled: CompiledCard;
  /** 引用名 → 信号键 <pack>/<signal id> */
  signals: Record<string, string>;
}

export interface PackSet {
  packs: LoadedPack[];
  disabled: Array<{ name: string; reason: string }>;
  signals: Map<string, { pack: string; signal: Signal }>;
  cards: Map<string, CardEntry>;
  chains: Map<string, { pack: string; chain: EvidenceChain }>;
  rules: Array<{
    pack: string;
    rule: PackRule;
    when: (ctx: Record<string, unknown>) => unknown;
    params: Record<string, (ctx: Record<string, unknown>) => unknown>;
  }>;
  lock: PackLock;
  lockDigest: string;
}

export interface CompileOptions {
  layers?: LoadedLayer[];
  catalog: ActionCatalog;
  /** 已通过 verify() 的能力；不填时不按能力禁用包（pack lint、pack test） */
  capabilities?: ReadonlySet<string>;
  /** 已提交的 pack.lock；给出时加载结果必须与之一致 */
  expectedLock?: PackLock;
}

/** lint 用的标签档案与实体：规范标签名、30 秒抓取间隔 */
const LINT_PROFILE: LabelProfile = {
  namespace: 'namespace',
  pod: 'pod',
  container: 'container',
  node: 'node',
  cluster: 'cluster',
  scrape_interval_seconds: 30,
  tenant: null,
};

function cardKind(mode: string): Signal['kind'] {
  return mode === 'logs' ? 'logs' : mode === 'traces' ? 'traces' : 'metrics';
}

export async function compilePackSet(loaded: LoadedPack[], opts: CompileOptions): Promise<PackSet> {
  const names = new Set<string>();
  for (const p of loaded) {
    if (names.has(p.name)) {
      throw new PackLintError(p.dir, `包名 ${p.name} 重复`);
    }
    names.add(p.name);
  }
  const layers = opts.layers ?? [];
  // 锁基于合并前的内容与层文件本身
  const lock = computeLock(loaded, layers);
  if (opts.expectedLock) {
    verifyLock(opts.expectedLock, lock);
  }
  const packs = loaded.map((p) => ({ ...p, content: structuredClone(p.content) }));
  applyLayers(packs, layers);

  const disabled: PackSet['disabled'] = [];
  const active: LoadedPack[] = [];
  for (const p of packs) {
    const missing = opts.capabilities ? p.content.manifest.requires.filter((c) => !opts.capabilities!.has(c)) : [];
    if (missing.length) {
      disabled.push({ name: p.name, reason: `缺少必须的能力：${missing.join('、')}` });
    } else {
      active.push(p);
    }
  }
  // 依赖被禁用或缺失的包同样禁用
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of [...active]) {
      const lack = (p.content.manifest.depends_on ?? []).filter((d) => !active.some((x) => x.name === d));
      if (lack.length) {
        active.splice(active.indexOf(p), 1);
        const known = lack.filter((d) => packs.some((x) => x.name === d));
        if (known.length < lack.length) {
          throw new PackLintError(p.dir, `依赖的包没有加载：${lack.filter((d) => !known.includes(d)).join('、')}`);
        }
        disabled.push({ name: p.name, reason: `依赖的包被禁用：${lack.join('、')}` });
        changed = true;
      }
    }
  }

  const engine: PromqlEngine = await loadPromqlEngine();
  const base = createBaseEnvironment();
  const signals: PackSet['signals'] = new Map();
  for (const p of active) {
    for (const s of p.content.signals.signals) {
      const key = `${p.name}/${s.id}`;
      if (signals.has(key)) {
        throw new PackLintError(p.dir, `信号 ${s.id} 重复`);
      }
      s.alternatives.forEach((a, i) => {
        if (a.recording_rule && i === s.alternatives.length - 1) {
          throw new PackLintError(
            `${p.dir}/signals.yaml`,
            `信号 ${s.id} 的最后一个备选依赖录制规则；录制规则可选，最后一个备选必须是原始表达式`,
          );
        }
        const d = a.dialect ?? 'promql';
        const ok =
          s.kind === 'metrics'
            ? d === 'promql' || d === 'metricsql'
            : s.kind === 'logs'
              ? d === 'logql' || d === 'logs_match'
              : d === 'traceql';
        if (!ok) {
          throw new PackLintError(
            `${p.dir}/signals.yaml`,
            `信号 ${s.id} 的备选 ${i} 方言 ${d} 与信号类型 ${s.kind} 不符`,
          );
        }
      });
      signals.set(key, { pack: p.name, signal: s });
    }
  }

  const resolveSignal = (pack: string, ref: string, where: string): string => {
    const key = ref.includes('/') ? ref : `${pack}/${ref}`;
    if (!signals.has(key)) {
      throw new PackLintError(where, `引用的信号 ${ref} 不存在或所在的包被禁用`);
    }
    return key;
  };

  const cards: PackSet['cards'] = new Map();
  const chains: PackSet['chains'] = new Map();
  const addCard = (p: LoadedPack, chain: string | null, def: CardDefinition) => {
    const key = chain ? `${p.name}/${chain}/${def.id}` : `${p.name}/checks/${def.id}`;
    if (cards.has(key)) {
      throw new PackLintError(p.dir, `卡片 ${key} 重复`);
    }
    const where = `${p.dir}：${key}`;
    const refSignals: Record<string, string> = {};
    for (const r of def.refs) {
      const sk = resolveSignal(p.name, r.signal, where);
      const sig = signals.get(sk)!.signal;
      if (sig.kind !== cardKind(r.mode)) {
        throw new PackLintError(where, `引用 ${r.name} 的模式 ${r.mode} 与信号 ${sk} 的类型 ${sig.kind} 不符`);
      }
      refSignals[r.name] = sk;
      // 严格解析每个指标备选（用卡片与引用的默认参数渲染）
      if (sig.kind === 'metrics') {
        const params = { ...(def.params ?? {}), ...(r.params ?? {}) } as Record<string, number | string | boolean>;
        for (const [i, alt] of sig.alternatives.entries()) {
          for (const kind of def.applies_to?.kinds ?? ['Pod']) {
            try {
              const text = renderMetrics(engine, alt, {
                entity: { cluster_id: 'lint', kind, namespace: 'lint', name: 'lint', node: 'lint' },
                params,
                windowSeconds: 1800,
                profile: LINT_PROFILE,
              });
              const a = engine.analyze(text, alt.dialect === 'metricsql' ? 'metricsql' : 'promql');
              if (a.has_at) {
                throw new Error('不允许使用 @ 修饰符');
              }
              if (r.mode === 'range' && a.type && a.type !== 'vector' && a.type !== 'scalar') {
                throw new Error(`range 模式的查询结果必须是瞬时向量，实际为 ${a.type}`);
              }
            } catch (err) {
              throw new PackLintError(
                where,
                `信号 ${sk} 的备选 ${i}（实体类型 ${kind}）：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    }
    for (const t of def.requires ?? []) {
      if (!/^[a-z]+\.[a-z_]+$/.test(t)) {
        throw new PackLintError(where, `能力名格式不对：${t}`);
      }
    }
    for (const l of def.links ?? []) {
      if (l.kind === 'runbook') {
        const file = (l.target ?? '').split('#')[0]!;
        if (!(file in p.content.runbooks)) {
          throw new PackLintError(where, `runbook 链接指向不存在的文件 ${l.target}`);
        }
      }
    }
    cards.set(key, { key, pack: p.name, chain, def, compiled: compileCard(base, def, { where }), signals: refSignals });
  };

  for (const p of active) {
    for (const ch of p.content.chains.chains) {
      const key = `${p.name}/${ch.id}`;
      if (chains.has(key)) {
        throw new PackLintError(p.dir, `证据链 ${ch.id} 重复`);
      }
      chains.set(key, { pack: p.name, chain: ch });
      if (ch.runbook && !(ch.runbook.split('#')[0]! in p.content.runbooks)) {
        throw new PackLintError(p.dir, `证据链 ${ch.id} 的 runbook ${ch.runbook} 不存在`);
      }
      for (const c of ch.cards) {
        addCard(p, ch.id, c);
      }
    }
    for (const c of p.content.checks.checks) {
      addCard(p, null, c);
    }
  }

  const chainRef = (pack: string, ref: string, where: string) => {
    const key = ref.includes('/') ? ref : `${pack}/${ref}`;
    if (!chains.has(key)) {
      throw new PackLintError(where, `引用的证据链 ${ref} 不存在或所在的包被禁用`);
    }
  };
  const componentTypes = new Set(active.flatMap((p) => p.content.components.component_types.map((c) => c.id)));
  for (const p of active) {
    for (const e of p.content.alerts.entries) {
      (e.chains ?? []).forEach((c) => chainRef(p.name, c, `${p.dir}/alerts.yaml：${e.id}`));
      if (e.component_type && !componentTypes.has(e.component_type)) {
        throw new PackLintError(`${p.dir}/alerts.yaml：${e.id}`, `组件类型 ${e.component_type} 不存在`);
      }
    }
    for (const ct of p.content.components.component_types) {
      (ct.chains ?? []).forEach((c) => chainRef(p.name, c, `${p.dir}/components.yaml：${ct.id}`));
    }
    for (const k of Object.values(p.content.knowledge)) {
      for (const e of k.entries) {
        if (!e.learned_from.length) {
          throw new PackLintError(`${p.dir}/knowledge`, `知识条目 ${e.id} 必须写明 learned_from`);
        }
      }
    }
  }

  // 规则提议：动作必须在目录中，参数名必须是动作声明的参数；when 与参数值都是 CEL
  const ruleEnv = new Environment({ unlistedVariablesAreDyn: false, homogeneousAggregateLiterals: false })
    .registerVariable('incident', 'map')
    .registerVariable('root', 'map')
    .registerVariable('cards', 'map');
  const rules: PackSet['rules'] = [];
  for (const p of active) {
    for (const r of p.content.rules.rules) {
      const where = `${p.dir}/rules.yaml：${r.id}`;
      const action = opts.catalog.actions.find((a) => a.id === r.action);
      if (!action) {
        throw new PackLintError(where, `动作 ${r.action} 不在动作目录中；领域包不能定义新动作`);
      }
      const declared = Object.keys(action.params.properties ?? {});
      for (const k of Object.keys(r.params)) {
        if (!declared.includes(k)) {
          throw new PackLintError(where, `动作 ${r.action} 没有参数 ${k}`);
        }
      }
      for (const k of action.params.required ?? []) {
        if (!(k in r.params)) {
          throw new PackLintError(where, `缺少动作 ${r.action} 的必填参数 ${k}`);
        }
      }
      for (const [k, v] of Object.entries({ when: r.when, ...(r.params as Record<string, unknown>) })) {
        if (typeof v !== 'string') {
          throw new PackLintError(where, `${k} 必须是 CEL 表达式文本`);
        }
        const c = ruleEnv.check(v);
        if (!c.valid) {
          throw new PackLintError(where, `${k} 的 CEL 不合法：${c.error?.message ?? ''}`);
        }
      }
      const when = ruleEnv.parse(r.when);
      const params = Object.fromEntries(
        Object.entries(r.params as Record<string, string>).map(([k, v]) => {
          const f = ruleEnv.parse(v);
          return [k, (ctx: Record<string, unknown>) => f(ctx)];
        }),
      );
      rules.push({ pack: p.name, rule: r, when: (ctx) => when(ctx), params });
    }
  }

  return { packs: active, disabled, signals, cards, chains, rules, lock, lockDigest: lockDigest(lock) };
}
