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
import { compileRemediations, type CompiledRemediation } from '../remediation/compile.js';
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
  /** 证据链的排除规则；chain 为证据链全局键 <pack>/<chain id> */
  excludes: Array<{
    pack: string;
    chain: string;
    index: number;
    say: { 'zh-CN'?: string; en?: string };
    when: (ctx: Record<string, unknown>) => unknown;
  }>;
  rules: Array<{
    pack: string;
    rule: PackRule;
    when: (ctx: Record<string, unknown>) => unknown;
    params: Record<string, (ctx: Record<string, unknown>) => unknown>;
  }>;
  /** 修复补丁模板（remediations.yaml，ADR 0103） */
  remediations: CompiledRemediation[];
  /** 阶段 B 的查询模板：全局 id <pack>/<模板 id>，附带的卡在 cards 中的键为 <pack>/templates/<模板 id> */
  templates: Array<{ id: string; pack: string; description: string; args: Record<string, unknown>; card: string }>;
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

/** 主卡的全局键：<chain>/<card> 在条目所在的包内解析，三段为 <pack>/<chain>/<card> */
export function primaryCardKey(pack: string, ref: string): string {
  return ref.split('/').length === 2 ? `${pack}/${ref}` : ref;
}

/** 实体 kind 的比较形式：忽略大小写与 API 组（application 与 Application.argoproj.io 相同），与评测的实体匹配一致 */
export function kindKey(kind: string): string {
  return kind.split('.')[0]!.toLowerCase();
}

/**
 * 主卡的检查：卡片存在；卡片的 applies_to 包含条目的实体 kind；卡片所在的证据链在条目的 chains 中，
 * 告警触发时阶段 A 才会在告警实体上执行它（评测按这次执行的结论统计一致率）。
 */
function checkPrimaryCard(
  pack: string,
  e: { primary_card?: string; chains?: string[]; entity: { kind: string } },
  cards: PackSet['cards'],
  where: string,
): void {
  const key = primaryCardKey(pack, e.primary_card!);
  const card = cards.get(key);
  if (!card || card.chain === null) {
    throw new PackLintError(where, `主卡 ${e.primary_card} 不存在或所在的包被禁用`);
  }
  const kinds = card.def.applies_to?.kinds;
  if (kinds && !kinds.some((k) => kindKey(k) === kindKey(e.entity.kind))) {
    throw new PackLintError(
      where,
      `主卡 ${e.primary_card} 的 applies_to（${kinds.join('、')}）不包含实体 kind ${e.entity.kind}`,
    );
  }
  const chain = `${card.pack}/${card.chain}`;
  if (!(e.chains ?? []).some((c) => (c.includes('/') ? c : `${pack}/${c}`) === chain)) {
    throw new PackLintError(
      where,
      `主卡 ${e.primary_card} 所在的证据链 ${chain} 不在条目的 chains 中，告警触发时不会执行`,
    );
  }
}

interface ArgSchema {
  type?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
}

/**
 * 查询模板参数的检查：模板参数在执行时作为附带卡的 params 传入，模型给出的值按 args 校验后代入查询。
 * - 每个参数都是卡的 params，卡的默认值满足 args（默认值就是不传参数时的行为）；
 * - 参数有 description，模型才知道它的含义；
 * - 字符串参数必须用 enum 或 pattern 限定（它们代入 PromQL 的标签名、正则与字符串）；数字参数必须有 minimum 与 maximum。
 */
export function checkTemplateArgs(args: Record<string, unknown>, params: Record<string, unknown>, where: string): void {
  if (args.additionalProperties !== false) {
    throw new PackLintError(where, 'args 必须写 additionalProperties: false');
  }
  for (const [name, raw] of Object.entries((args.properties as Record<string, ArgSchema> | undefined) ?? {})) {
    const s = raw;
    const fail = (detail: string): never => {
      throw new PackLintError(where, `模板参数 ${name}：${detail}`);
    };
    if (!(name in params)) {
      fail('不是附带卡的 params，执行时不会生效');
    }
    if (!s.description) {
      fail('缺少 description');
    }
    const v = params[name];
    if (s.type === 'string') {
      if (!s.enum && !s.pattern) {
        fail('字符串参数必须用 enum 或 pattern 限定');
      }
      if (typeof v !== 'string' || (s.enum && !s.enum.includes(v)) || (s.pattern && !new RegExp(s.pattern).test(v))) {
        fail(`卡的默认值 ${JSON.stringify(v)} 不满足参数的限定`);
      }
    } else if (s.type === 'integer' || s.type === 'number') {
      if (s.minimum === undefined || s.maximum === undefined) {
        fail('数字参数必须有 minimum 与 maximum');
      }
      if (typeof v !== 'number' || v < s.minimum! || v > s.maximum! || (s.type === 'integer' && !Number.isInteger(v))) {
        fail(`卡的默认值 ${JSON.stringify(v)} 不在 [${s.minimum}, ${s.maximum}] 内`);
      }
    } else {
      fail(`只支持 string、integer、number 类型，实际为 ${String(s.type)}`);
    }
  }
}

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
  // 证据链的卡键为 <pack>/<chain>/<card>，检查项为 <pack>/checks/<id>，查询模板附带的卡为 <pack>/templates/<模板 id>
  const addCard = (
    p: LoadedPack,
    chain: string | null,
    def: CardDefinition,
    key = chain ? `${p.name}/${chain}/${def.id}` : `${p.name}/checks/${def.id}`,
  ) => {
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
    // 作为阶段 B 检查时的可覆盖参数：与查询模板参数同样的约束；窗口由运行时提供，不在这里声明
    if (def.check?.args) {
      const props = Object.keys((def.check.args.properties as Record<string, unknown> | undefined) ?? {});
      const windowKey = props.find((k) => k === 'window_before' || k === 'window_after');
      if (windowKey) {
        throw new PackLintError(where, `check.args 不能声明 ${windowKey}，窗口由运行时提供`);
      }
      checkTemplateArgs(def.check.args, def.params ?? {}, `${where}：check`);
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

  // 查询模板（signals.yaml 的 templates，阶段 B 的区分性检查）：附带的卡按与证据卡相同的规则编译与严格解析，
  // 键为 <pack>/templates/<模板 id>，pack test 的夹具以 templates/<模板 id> 引用它
  const templates: PackSet['templates'] = [];
  for (const p of active) {
    for (const t of p.content.signals.templates ?? []) {
      const where = `${p.dir}/signals.yaml：templates ${t.id}`;
      resolveSignal(p.name, t.signal, where);
      if (!t.card) {
        throw new PackLintError(where, '查询模板必须附带判定结果的卡（card）');
      }
      if (t.args.type !== 'object') {
        throw new PackLintError(where, '模板的 args 必须是 type: object 的 JSON Schema');
      }
      const key = `${p.name}/templates/${t.id}`;
      addCard(p, null, t.card as CardDefinition, key);
      checkTemplateArgs(t.args, (t.card as CardDefinition).params ?? {}, where);
      templates.push({ id: `${p.name}/${t.id}`, pack: p.name, description: t.description, args: t.args, card: key });
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
      const where = `${p.dir}/alerts.yaml：${e.id}`;
      (e.chains ?? []).forEach((c) => chainRef(p.name, c, where));
      if (e.component_type && !componentTypes.has(e.component_type)) {
        throw new PackLintError(where, `组件类型 ${e.component_type} 不存在`);
      }
      if (e.primary_card) {
        checkPrimaryCard(p.name, e, cards, where);
      }
    }
    for (const ct of p.content.components.component_types) {
      const where = `${p.dir}/components.yaml：${ct.id}`;
      (ct.chains ?? []).forEach((c) => chainRef(p.name, c, where));
      // 可读名称的 signal 来源：本包的 metrics 信号，每个备选按组件类型的 kind 渲染并严格解析
      for (const src of ct.display_name ?? []) {
        if (!('signal' in src)) {
          continue;
        }
        const sk = `${p.name}/${src.signal}`;
        const sig = signals.get(sk)?.signal;
        if (!sig) {
          throw new PackLintError(where, `display_name 引用的信号 ${src.signal} 不在本包中`);
        }
        if (sig.kind !== 'metrics') {
          throw new PackLintError(
            where,
            `display_name 引用的信号 ${src.signal} 必须是 metrics 信号，实际为 ${sig.kind}`,
          );
        }
        for (const [i, alt] of sig.alternatives.entries()) {
          try {
            const text = renderMetrics(engine, alt, {
              entity: { cluster_id: 'lint', kind: ct.match.kind, namespace: 'lint', name: 'lint', node: 'lint' },
              params: {},
              windowSeconds: 1800,
              profile: LINT_PROFILE,
            });
            const a = engine.analyze(text, alt.dialect === 'metricsql' ? 'metricsql' : 'promql');
            if (a.has_at) {
              throw new Error('不允许使用 @ 修饰符');
            }
          } catch (err) {
            throw new PackLintError(
              where,
              `display_name 的信号 ${sk} 的备选 ${i}：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
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

  // 证据链的排除规则：上下文与规则提议相同，命中时阶段 A 的 disposition 为 ignore
  const excludes: PackSet['excludes'] = [];
  for (const [key, { pack, chain }] of chains) {
    for (const [i, ex] of (chain.excludes ?? []).entries()) {
      const where = `${key} 的 excludes[${i}]`;
      const c = ruleEnv.check(ex.cel);
      if (!c.valid) {
        throw new PackLintError(where, `CEL 不合法：${c.error?.message ?? ''}`);
      }
      const f = ruleEnv.parse(ex.cel);
      excludes.push({ pack, chain: key, index: i, say: ex.say, when: (ctx) => f(ctx) });
    }
  }

  const remediations = compileRemediations(base, active, signals, new Set(cards.keys()));
  return {
    packs: active,
    disabled,
    signals,
    cards,
    chains,
    rules,
    excludes,
    remediations,
    templates,
    lock,
    lockDigest: lockDigest(lock),
  };
}
