// domains.yaml 的编译（契约 2.28.0，ADR 0146 §1.1、§1.3）：指标目录与领域。
// - 指标只引用 metrics 信号，参数是可移植的 JSON Schema，信号的每个备选按指标的实体类型渲染并严格解析；
// - 领域的卡片引用、查询模板、ops 修复模板（applies 为 goal）、业务 issue 模板与指标引用在加载时检查；
// - 诊断卡与份额卡的按行表达式在卡片的变量上编译（另有 row），求值成本与卡内表达式同样受限；
// - 多个包可以给同一个领域补充内容：同一 id 的领域按包的加载顺序合并，列表追加，gates 后者覆盖前者的同名键。

import type {
  Domain,
  DomainGates,
  DomainLoadGuard,
  DomainTrend,
  Indicator,
  LabelProfile,
  LocalizedText,
  Signal,
} from '@srenautix/contract';
import type { PromqlEngine } from '@srenautix/integration-sdk';
import { PackLintError } from '../cel/errors.js';
import type { CompiledExpr } from '../judge/card.js';
import type { CompiledRemediation } from '../remediation/compile.js';
import type { CompiledIssue } from '../remediation/issues.js';
import { renderMetrics } from '../signals/render.js';
import type { CardEntry } from './compile.js';
import type { LoadedPack } from './load.js';

export interface CompiledIndicator {
  /** <pack>/<id> */
  key: string;
  pack: string;
  def: Indicator;
  /** 信号键 <pack>/<signal id> */
  signal: string;
}

export interface CompiledEntityRows {
  type: string;
  rowsFrom: string;
  key: CompiledExpr;
  display: CompiledExpr | null;
  labels: Record<string, CompiledExpr>;
  when: CompiledExpr | null;
  share: CompiledExpr | null;
  limit: number;
}

export interface CompiledDiagnostic {
  id: string;
  /** 声明它的包 */
  pack: string;
  /** 卡片全局键 */
  card: string;
  finding: string;
  indicator: string | null;
  symptoms: string[];
  entities: CompiledEntityRows | null;
}

export interface CompiledContribution {
  id: string;
  pack: string;
  card: string;
  indicator: string;
  /** 没有 entities 时实体的份额；不填为 1 */
  share: CompiledExpr | null;
  entities: CompiledEntityRows | null;
}

/** 门槛参数（缺省值已填好） */
export type ResolvedGates = DomainGates & {
  violation_ratio: number;
  min_share: number;
  min_gain_ratio: number;
  min_gain_gap_ratio: number;
  cooldown: string;
  thresholds: NonNullable<DomainGates['thresholds']>;
};

export const DEFAULT_GATES = {
  violation_ratio: 0.1,
  min_share: 0.2,
  min_gain_ratio: 0.1,
  min_gain_gap_ratio: 0.5,
  cooldown: '30d',
} as const;

export interface CompiledDomain {
  id: string;
  title: LocalizedText | null;
  /** 给这个领域补充内容的包，按加载顺序 */
  packs: string[];
  applies_to: string[];
  indicators: string[];
  diagnostics: CompiledDiagnostic[];
  contribution: CompiledContribution[];
  templates: string[];
  optimizations: string[];
  issues: string[];
  gates: ResolvedGates;
  trends: Array<DomainTrend & { pack: string }>;
  schedule: { cron: string } | null;
  load_guards: Array<{ pack: string; card: string; backends: DomainLoadGuard['backends'] }>;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * 同一 id 的两个领域定义合并（用户层的 extend 与多个包的补充共用）：列表追加并去重，诊断卡、份额卡、趋势与负载保护卡的
 * id 不能重复；gates 后者覆盖前者的同名键（thresholds 追加）；title、schedule 后者优先
 */
export function mergeDomain(where: string, a: Domain, b: Domain): Domain {
  const byId = <T extends { id: string }>(what: string, x: T[] | undefined, y: T[] | undefined): T[] => {
    const out = [...(x ?? [])];
    for (const item of y ?? []) {
      if (out.some((o) => o.id === item.id)) {
        throw new PackLintError(where, `领域 ${a.id} 的${what} ${item.id} 重复`);
      }
      out.push(item);
    }
    return out;
  };
  const gates: DomainGates = {
    ...(a.gates ?? {}),
    ...(b.gates ?? {}),
    ...(a.gates?.thresholds || b.gates?.thresholds
      ? { thresholds: [...(a.gates?.thresholds ?? []), ...(b.gates?.thresholds ?? [])] }
      : {}),
  };
  return {
    id: a.id,
    ...((b.title ?? a.title) ? { title: (b.title ?? a.title)! } : {}),
    applies_to: uniq([...(a.applies_to ?? []), ...(b.applies_to ?? [])]),
    indicators: uniq([...(a.indicators ?? []), ...(b.indicators ?? [])]),
    diagnostics: byId('诊断卡', a.diagnostics, b.diagnostics),
    contribution: byId('份额卡', a.contribution, b.contribution),
    templates: uniq([...(a.templates ?? []), ...(b.templates ?? [])]),
    optimizations: uniq([...(a.optimizations ?? []), ...(b.optimizations ?? [])]),
    issues: uniq([...(a.issues ?? []), ...(b.issues ?? [])]),
    gates,
    trends: byId('趋势', a.trends, b.trends),
    ...((b.schedule ?? a.schedule) ? { schedule: (b.schedule ?? a.schedule)! } : {}),
    load_guards: [...(a.load_guards ?? []), ...(b.load_guards ?? [])],
  };
}

interface ParamSchema {
  type?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
}

/** 指标参数的可移植子集检查；返回 lint 渲染用的示例取值 */
function indicatorParams(where: string, def: Indicator): Record<string, number | string | boolean> {
  const schema = def.params;
  if (!schema) {
    return {};
  }
  if (schema.additionalProperties !== false) {
    throw new PackLintError(where, 'params 必须写 additionalProperties: false');
  }
  const sample: Record<string, number | string | boolean> = {};
  for (const [name, raw] of Object.entries((schema.properties as Record<string, ParamSchema> | undefined) ?? {})) {
    const fail = (detail: string): never => {
      throw new PackLintError(where, `参数 ${name}：${detail}`);
    };
    if (!raw.description) {
      fail('缺少 description');
    }
    if (raw.type === 'string') {
      if (!raw.enum && !raw.pattern) {
        fail('字符串参数必须用 enum 或 pattern 限定');
      }
      sample[name] = typeof raw.enum?.[0] === 'string' ? raw.enum[0] : 'lint';
    } else if (raw.type === 'integer' || raw.type === 'number') {
      if (raw.minimum === undefined || raw.maximum === undefined) {
        fail('数字参数必须有 minimum 与 maximum');
      }
      sample[name] = raw.minimum!;
    } else if (raw.type === 'boolean') {
      sample[name] = false;
    } else {
      fail(`只支持 string、integer、number、boolean 类型，实际为 ${String(raw.type)}`);
    }
  }
  return sample;
}

export interface CompileDomainsInput {
  engine: PromqlEngine;
  active: LoadedPack[];
  signals: Map<string, { pack: string; signal: Signal }>;
  cards: Map<string, CardEntry>;
  /** 查询模板全局 id */
  templates: ReadonlySet<string>;
  remediations: CompiledRemediation[];
  issues: CompiledIssue[];
  lintProfile: LabelProfile;
}

/** 领域里的卡片引用：<chain>/<card>、checks/<id>、templates/<id> 在声明它的包内解析，三段为 <pack>/<chain>/<card> */
function cardRef(pack: string, ref: string, cards: Map<string, CardEntry>, where: string): CardEntry {
  const key = ref.split('/').length === 2 ? `${pack}/${ref}` : ref;
  const e = cards.get(key);
  if (!e) {
    throw new PackLintError(where, `引用的卡片 ${ref} 不存在或所在的包被禁用`);
  }
  return e;
}

function compileRows(
  e: CardEntry,
  rows: NonNullable<Domain['diagnostics']>[number]['entities'],
  need: 'when' | 'share',
  where: string,
): CompiledEntityRows | null {
  if (!rows) {
    return null;
  }
  if (!e.def.refs.some((r) => r.name === rows.rows_from)) {
    throw new PackLintError(where, `entities.rows_from ${rows.rows_from} 不是卡片 ${e.key} 的引用`);
  }
  if (need === 'when' && !rows.when) {
    throw new PackLintError(where, '诊断卡的 entities 必须写 when（为 true 的行是候选）');
  }
  if (need === 'share' && !rows.share) {
    throw new PackLintError(where, '份额卡的 entities 必须写 share（行的份额）');
  }
  const c = (src: string, what: string) => e.compiled.compileExpr(src, `${where}：entities.${what}`, { row: true });
  return {
    type: rows.type,
    rowsFrom: rows.rows_from,
    key: c(rows.key, 'key'),
    display: rows.display ? c(rows.display, 'display') : null,
    labels: Object.fromEntries(Object.entries(rows.labels ?? {}).map(([k, v]) => [k, c(v!, `labels.${k}`)])),
    when: rows.when ? c(rows.when, 'when') : null,
    share: rows.share ? c(rows.share, 'share') : null,
    limit: rows.limit ?? 20,
  };
}

export function compileDomains(input: CompileDomainsInput): {
  indicators: Map<string, CompiledIndicator>;
  domains: Map<string, CompiledDomain>;
} {
  const { active, signals, cards, engine } = input;
  const indicators = new Map<string, CompiledIndicator>();
  for (const p of active) {
    for (const def of p.content.domains.indicators ?? []) {
      const key = `${p.name}/${def.id}`;
      const where = `${p.dir}/domains.yaml：指标 ${def.id}`;
      if (indicators.has(key)) {
        throw new PackLintError(where, `指标 ${def.id} 重复`);
      }
      const sk = def.signal.includes('/') ? def.signal : `${p.name}/${def.signal}`;
      const sig = signals.get(sk)?.signal;
      if (!sig) {
        throw new PackLintError(where, `引用的信号 ${def.signal} 不存在或所在的包被禁用`);
      }
      if (sig.kind !== 'metrics') {
        throw new PackLintError(where, `指标只能引用 metrics 信号，${sk} 是 ${sig.kind}`);
      }
      const params = indicatorParams(where, def);
      for (const [i, alt] of sig.alternatives.entries()) {
        try {
          const text = renderMetrics(engine, alt, {
            entity: { cluster_id: 'lint', kind: def.entity, namespace: 'lint', name: 'lint', node: 'lint' },
            params,
            windowSeconds: 3600,
            profile: input.lintProfile,
          });
          if (engine.analyze(text, alt.dialect === 'metricsql' ? 'metricsql' : 'promql').has_at) {
            throw new Error('不允许使用 @ 修饰符');
          }
        } catch (err) {
          throw new PackLintError(where, `信号 ${sk} 的备选 ${i}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      indicators.set(key, { key, pack: p.name, def, signal: sk });
    }
  }
  const needIndicator = (ref: string | undefined, where: string) => {
    if (ref !== undefined && !indicators.has(ref)) {
      throw new PackLintError(where, `引用的指标 ${ref} 不存在或所在的包被禁用`);
    }
  };
  for (const ind of indicators.values()) {
    needIndicator(ind.def.load_indicator, `${ind.key} 的 load_indicator`);
  }
  // 主动优化的 ops 修复模板与业务 issue 模板引用的指标
  for (const r of input.remediations) {
    if ((r.def.applies ?? 'incident') !== 'goal') {
      continue;
    }
    needIndicator(r.def.estimate?.indicator, `${r.key} 的 estimate`);
    (r.def.verify.guards ?? []).forEach((g) => needIndicator(g, `${r.key} 的 verify.guards`));
  }
  for (const t of input.issues) {
    needIndicator(t.def.estimate.indicator, `${t.key} 的 estimate`);
    (t.def.verify.guards ?? []).forEach((g) => needIndicator(g, `${t.key} 的 verify.guards`));
  }

  const domains = new Map<string, CompiledDomain>();
  for (const p of active) {
    for (const d of p.content.domains.domains ?? []) {
      const where = `${p.dir}/domains.yaml：领域 ${d.id}`;
      const diagnostics: CompiledDiagnostic[] = (d.diagnostics ?? []).map((x) => {
        const w = `${where} 的诊断卡 ${x.id}`;
        const e = cardRef(p.name, x.card, cards, w);
        needIndicator(x.indicator, w);
        return {
          id: x.id,
          pack: p.name,
          card: e.key,
          finding: x.finding,
          indicator: x.indicator ?? null,
          symptoms: x.symptoms ?? [],
          entities: compileRows(e, x.entities, 'when', w),
        };
      });
      const contribution: CompiledContribution[] = (d.contribution ?? []).map((x) => {
        const w = `${where} 的份额卡 ${x.id}`;
        const e = cardRef(p.name, x.card, cards, w);
        needIndicator(x.indicator, w);
        if (x.share && x.entities) {
          throw new PackLintError(w, '有 entities 时份额写在 entities.share，不写 share');
        }
        return {
          id: x.id,
          pack: p.name,
          card: e.key,
          indicator: x.indicator,
          share: x.share ? e.compiled.compileExpr(x.share, `${w}：share`) : null,
          entities: compileRows(e, x.entities, 'share', w),
        };
      });
      for (const ref of d.indicators ?? []) {
        needIndicator(ref, where);
      }
      for (const t of d.gates?.thresholds ?? []) {
        needIndicator(t.indicator, `${where} 的 gates.thresholds`);
      }
      for (const t of d.templates ?? []) {
        if (!input.templates.has(t)) {
          throw new PackLintError(where, `查询模板 ${t} 不存在或所在的包被禁用`);
        }
      }
      for (const o of d.optimizations ?? []) {
        const r = input.remediations.find((x) => x.key === o);
        if (!r) {
          throw new PackLintError(where, `ops 修复模板 ${o} 不存在或所在的包被禁用`);
        }
        if ((r.def.applies ?? 'incident') !== 'goal') {
          throw new PackLintError(where, `ops 修复模板 ${o} 不是 applies: goal 的模板，不能用于主动优化`);
        }
      }
      for (const i of d.issues ?? []) {
        const t = input.issues.find((x) => x.key === i);
        if (!t) {
          throw new PackLintError(where, `业务 issue 模板 ${i} 不存在或所在的包被禁用`);
        }
        if (t.def.domain !== d.id) {
          throw new PackLintError(where, `业务 issue 模板 ${i} 属于领域 ${t.def.domain}，不是 ${d.id}`);
        }
      }
      const trends = (d.trends ?? []).map((t) => {
        const w = `${where} 的趋势 ${t.id}`;
        needIndicator(t.indicator, w);
        needIndicator(t.limit, w);
        const missing =
          t.method === 'drift'
            ? (['ratio'] as const).filter((k) => t[k] === undefined)
            : t.method === 'slope'
              ? (['window', 'horizon', 'limit'] as const).filter((k) => t[k] === undefined)
              : (['ratio', 'limit'] as const).filter((k) => t[k] === undefined);
        if (missing.length) {
          throw new PackLintError(w, `${t.method} 趋势缺少 ${missing.join('、')}`);
        }
        return { ...t, pack: p.name };
      });
      const loadGuards = (d.load_guards ?? []).map((g) => ({
        pack: p.name,
        card: cardRef(p.name, g.card, cards, `${where} 的负载保护卡`).key,
        backends: g.backends,
      }));

      const prev = domains.get(d.id);
      const ids = new Set<string>();
      for (const x of [...(prev?.diagnostics ?? []), ...(prev?.contribution ?? []), ...diagnostics, ...contribution]) {
        if (ids.has(x.id)) {
          throw new PackLintError(where, `诊断卡与份额卡的 id ${x.id} 在领域 ${d.id} 中重复`);
        }
        ids.add(x.id);
      }
      for (const t of trends) {
        if (prev?.trends.some((x) => x.id === t.id)) {
          throw new PackLintError(where, `趋势 ${t.id} 在领域 ${d.id} 中重复`);
        }
      }
      const gates = {
        ...(prev?.gates ?? DEFAULT_GATES),
        ...(d.gates ?? {}),
        thresholds: [...(prev?.gates.thresholds ?? []), ...(d.gates?.thresholds ?? [])],
      } as ResolvedGates;
      domains.set(d.id, {
        id: d.id,
        title: d.title ?? prev?.title ?? null,
        packs: [...(prev?.packs ?? []), p.name],
        applies_to: uniq([...(prev?.applies_to ?? []), ...(d.applies_to ?? [])]),
        indicators: uniq([...(prev?.indicators ?? []), ...(d.indicators ?? [])]),
        diagnostics: [...(prev?.diagnostics ?? []), ...diagnostics],
        contribution: [...(prev?.contribution ?? []), ...contribution],
        templates: uniq([...(prev?.templates ?? []), ...(d.templates ?? [])]),
        optimizations: uniq([...(prev?.optimizations ?? []), ...(d.optimizations ?? [])]),
        issues: uniq([...(prev?.issues ?? []), ...(d.issues ?? [])]),
        gates,
        trends: [...(prev?.trends ?? []), ...trends],
        schedule: d.schedule ?? prev?.schedule ?? null,
        load_guards: [...(prev?.load_guards ?? []), ...loadGuards],
      });
    }
  }
  return { indicators, domains };
}
