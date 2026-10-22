// 修复补丁的计划（ADR 0103）：按模板与事件上下文读取仓库，修改文件，生成 git diff 格式的补丁。
// 补丁直接作为 gitops_pr 的 params.patch；server 负责何时调用、PR 描述与提议，这里不写任何仓库。

import type { LocalizedText, RepositoryLayout } from '@srenautix/contract';
import { loadPromqlEngine, toIso } from '@srenautix/integration-sdk';
import { structuredPatch } from 'diff';
import { toCelSeries } from '../judge/data.js';
import type { PackSet } from '../pack/compile.js';
import type { EvidenceDataSource } from '../runtime/datasource.js';
import { renderMetrics, type RenderEntity } from '../signals/render.js';
import type { CompiledMessage, CompiledRemediation } from './compile.js';
import { appendValue, parseFile, setValue, type FileFormat, type ParsedFile } from './edit.js';
import { toPlain } from './functions.js';
import { getAt, parentPath, PathError, resolvePath, resolveSetTarget, substitutePath, type Concrete } from './path.js';
import type { RepoReader } from './repo.js';

export interface RemediationContext {
  /** 事件（契约 Incident 或其中的字段） */
  incident: Record<string, unknown>;
  /** 根因实体与组件类型；没有根因时为 null */
  root: (RenderEntity & { component_type?: string | null }) | null;
  /** 触发计划的研判结论：处置（契约 Disposition）与结论等级（契约 ConclusionLevel）；没有研判时为 null */
  research?: { disposition: string; level: string } | null;
  /** 卡片全局 id → 结论（同一张卡在多个实体上时取最严重的） */
  cards: Record<string, RemediationCard>;
  /**
   * 根因自己的卡（ADR 0139）：实体沿 owned_by 的顶层属主就是根因（根因本身、它拥有的 Pod 与 ReplicaSet），根因是
   * GitOps 应用时还有它管理的对象，再加上管理根因的应用本身的卡；形状与 cards 相同。没有给出时为空
   */
  root_cards?: Record<string, RemediationCard>;
  /** 成员告警；role、source、catalog_entry、chronic 取自契约 AlertClassification */
  alerts: Array<{
    alertname: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    role: string;
    source: string;
    catalog_entry: string | null;
    chronic: boolean;
    entity: Record<string, unknown> | null;
  }>;
}

export interface RemediationCard {
  verdict: string;
  display_state?: string;
  value?: string | null;
  reason_kind?: string;
  /** 判定时 let 绑定的标量取值（契约 EvidenceResult.observations） */
  observations?: Record<string, number | string | boolean | null | undefined>;
}

export interface RemediationTarget {
  repo: RepoReader;
  layout: RepositoryLayout;
}

export type SkipCode =
  | 'not_applicable'
  | 'layout_missing'
  | 'input_failed'
  | 'evaluation_error'
  | 'skip_if'
  | 'target_not_found'
  | 'ambiguous_target'
  | 'no_change';

export interface RemediationSkip {
  kind: 'skipped';
  key: string;
  code: SkipCode;
  reason: LocalizedText;
}

export interface RemediationPlan {
  kind: 'plan';
  key: string;
  pack: string;
  id: string;
  category: CompiledRemediation['def']['category'];
  repository: string;
  title: LocalizedText;
  /** 补丁基于的提交 */
  base: string;
  files: Array<{ path: string; before: string; after: string }>;
  /** git diff 格式，每个文件带 diff --git 头 */
  patch: string;
  change: LocalizedText;
  verify: { say: LocalizedText; cards: string[]; within: string | null };
  rollback: { say: LocalizedText };
}

const both = (zh: string, en: string): LocalizedText => ({ 'zh-CN': zh, en });

function skip(key: string, code: SkipCode, reason: LocalizedText): RemediationSkip {
  return { kind: 'skipped', key, code, reason };
}

function ctxOf(ctx: RemediationContext, params: Record<string, unknown>): Record<string, unknown> {
  return {
    incident: ctx.incident,
    root: ctx.root,
    research: ctx.research ?? null,
    cards: ctx.cards,
    root_cards: ctx.root_cards ?? {},
    alerts: ctx.alerts,
    params,
  };
}

/** 适用条件为 true 的模板；条件求值出错的模板不适用，错误写入 errors */
export function applicableRemediations(
  set: PackSet,
  ctx: RemediationContext,
): {
  applicable: Array<{ key: string; pack: string; id: string; category: string; repository: string }>;
  errors: Array<{ key: string; message: string }>;
} {
  const applicable: Array<{ key: string; pack: string; id: string; category: string; repository: string }> = [];
  const errors: Array<{ key: string; message: string }> = [];
  for (const r of set.remediations) {
    try {
      if (r.when(ctxOf(ctx, r.def.params ?? {})) === true) {
        applicable.push({
          key: r.key,
          pack: r.pack,
          id: r.def.id,
          category: r.def.category,
          repository: r.def.repository,
        });
      }
    } catch (err) {
      errors.push({ key: r.key, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applicable, errors };
}

function format(msg: CompiledMessage, vars: Record<string, unknown>): LocalizedText {
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

/** inputs.entity 的结果：null，或带 kind、name（namespace 可为 null）的映射；集群 id 沿用根因 */
function entityOf(v: unknown, ctx: RemediationContext): RenderEntity | null {
  const p = toPlain(v) as Record<string, unknown> | null;
  if (p === null) {
    return null;
  }
  if (typeof p !== 'object' || typeof p.kind !== 'string' || typeof p.name !== 'string') {
    throw new TypeError(`实体需要字符串 kind 与 name：${JSON.stringify(p)}`);
  }
  const ns = p.namespace ?? null;
  if (ns !== null && typeof ns !== 'string') {
    throw new TypeError(`实体的 namespace 必须是字符串或 null：${JSON.stringify(p)}`);
  }
  return {
    cluster_id: ctx.root?.cluster_id ?? String(ctx.incident.cluster_id ?? ''),
    kind: p.kind,
    namespace: ns,
    name: p.name,
  };
}

function isGlob(path: string): boolean {
  return /[*?]/.test(path);
}

function formatPatch(path: string, before: string, after: string): string {
  const p = structuredPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const h of p.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
  }
  return lines.join('\n') + '\n';
}

export async function planRemediation(
  set: PackSet,
  key: string,
  ctx: RemediationContext,
  target: RemediationTarget,
  ds: EvidenceDataSource | null,
  at: number,
): Promise<RemediationPlan | RemediationSkip> {
  const r = set.remediations.find((x) => x.key === key);
  if (!r) {
    throw new Error(`没有修复模板 ${key}`);
  }
  const def = r.def;
  const params = { ...(def.params ?? {}) };
  const base = ctxOf(ctx, params);
  try {
    if (r.when(base) !== true) {
      return skip(key, 'not_applicable', both('适用条件不成立', 'The template does not apply'));
    }
  } catch (err) {
    return skip(
      key,
      'evaluation_error',
      both(`适用条件求值出错：${String(err)}`, `Evaluating when failed: ${String(err)}`),
    );
  }

  const roles = [...new Set([...r.edits.map((e) => e.file), ...(def.history ? [def.history.file] : [])])];
  const missing = roles.filter((f) => !target.layout[f]);
  if (missing.length) {
    return skip(
      key,
      'layout_missing',
      both(
        `仓库布局没有文件角色 ${missing.join('、')}`,
        `The repository layout has no file role ${missing.join(', ')}`,
      ),
    );
  }

  // 读文件：路径 → 解析结果（修改后替换）
  const loaded = new Map<string, ParsedFile>();
  const original = new Map<string, string>();
  const load = async (path: string, fmt: FileFormat): Promise<ParsedFile | null> => {
    const hit = loaded.get(path);
    if (hit) {
      return hit;
    }
    const text = await target.repo.read(path);
    if (text === null) {
      return null;
    }
    const f = parseFile(path, fmt, text);
    loaded.set(path, f);
    original.set(path, text);
    return f;
  };
  const pathsOf = async (role: string) => {
    const l = target.layout[role]!;
    return isGlob(l.path) ? await target.repo.list(l.path) : [l.path];
  };
  // files.<角色> 总是文档列表：glob 匹配的全部文件、多文档 YAML 的全部文档按路径顺序展开，
  // 同一模板因此不依赖布局把内容放在一个文件还是多个文件里
  const files: Record<string, unknown[]> = {};
  for (const role of roles) {
    const l = target.layout[role]!;
    const docs: unknown[] = [];
    for (const p of await pathsOf(role)) {
      const f = await load(p, l.format);
      if (f) {
        docs.push(...f.docs.map((d) => d.js));
      }
    }
    files[role] = docs;
  }
  const fields = Object.fromEntries(roles.map((role) => [role, target.layout[role]!.fields ?? {}]));

  let history: unknown[] = [];
  if (def.history) {
    const l = target.layout[def.history.file]!;
    if (isGlob(l.path)) {
      return skip(
        key,
        'layout_missing',
        both('history 的文件角色不能是 glob', 'The history file role must not be a glob'),
      );
    }
    history = (await target.repo.history(l.path, def.history.depth)).map((c) => {
      let doc: unknown = null;
      if (c.content !== null) {
        try {
          doc = parseFile(l.path, l.format, c.content).docs[0]?.js ?? null;
        } catch {
          // 历史版本无法解析时按缺失处理，模板的 CEL 会跳过它
          doc = null;
        }
      }
      return { commit: c.commit, author: c.author, time: c.time, message: c.message, doc };
    });
  }

  const inputs: Record<string, unknown> = {};
  for (const i of r.inputs) {
    let entity: RenderEntity | null;
    try {
      entity = i.entity ? entityOf(i.entity(base), ctx) : ctx.root;
    } catch (err) {
      return skip(
        key,
        'evaluation_error',
        both(
          `inputs.${i.name}.entity 求值出错：${String(err)}`,
          `Evaluating inputs.${i.name}.entity failed: ${String(err)}`,
        ),
      );
    }
    if (!ds || !ds.labelProfile || !entity) {
      return skip(
        key,
        'input_failed',
        both(`没有可用的数据源或实体，无法查询 ${i.name}`, `No data source or entity to query ${i.name}`),
      );
    }
    const sig = set.signals.get(`${r.pack}/${i.signal}`)!.signal;
    const engine = await loadPromqlEngine();
    let got: unknown[] | null = null;
    let lastErr = '';
    for (const alt of sig.alternatives) {
      const dialect = alt.dialect === 'metricsql' ? 'metricsql' : 'promql';
      if (!ds.metricsDialects.has(dialect)) {
        continue;
      }
      try {
        const expr = renderMetrics(engine, alt, {
          entity,
          params: params as Record<string, string>,
          windowSeconds: 1800,
          profile: ds.labelProfile,
        });
        const res = await ds.query({
          expr,
          dialect,
          time: toIso(at),
          clock_window: { from: toIso(at - 2 * 3600_000), to: toIso(at) },
          timeout_ms: 10_000,
        });
        if (res.series.length) {
          got = res.series.map(toCelSeries);
          break;
        }
        got = [];
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (got === null) {
      return skip(
        key,
        'input_failed',
        both(`查询 ${i.name} 失败：${lastErr}`, `Querying ${i.name} failed: ${lastErr}`),
      );
    }
    inputs[i.name] = got;
  }

  const vars: Record<string, unknown> = { ...base, files, fields, history, ...inputs };
  const letValues: Record<string, unknown> = {};
  try {
    for (const l of r.lets) {
      const v = l.run(vars);
      vars[l.name] = v;
      letValues[l.name] = v;
    }
    for (const s of r.skips) {
      if (s.run(vars) === true) {
        return skip(key, 'skip_if', format(s.say, { ...params, ...letValues }));
      }
    }
  } catch (err) {
    return skip(key, 'evaluation_error', both(`求值出错：${String(err)}`, `Evaluation failed: ${String(err)}`));
  }

  const subst = { ...params, ...Object.fromEntries(Object.entries(letValues).map(([k, v]) => [k, toPlain(v)])) };
  try {
    for (const [ei, e] of r.edits.entries()) {
      const l = target.layout[e.file]!;
      const fieldPath = (name: string) => {
        const p = l.fields?.[name];
        if (!p) {
          throw new Error(`文件角色 ${e.file} 的布局没有逻辑字段 ${name}`);
        }
        return p;
      };
      const setPaths = e.set.map((s) => substitutePath(s.path ?? fieldPath(s.field!), subst));
      const locate =
        e.locate !== null
          ? substitutePath(e.locate, subst)
          : setPaths.length
            ? parentPath(setPaths[0]!)
            : substitutePath(e.append[0]!.path, subst);
      const kind = e.document?.kind !== undefined ? substitutePath(e.document.kind, subst) : undefined;
      const name = e.document?.name !== undefined ? substitutePath(e.document.name, subst) : undefined;
      const candidates: Array<{ path: string; doc: number }> = [];
      for (const p of await pathsOf(e.file)) {
        const f = await load(p, l.format);
        if (!f) {
          continue;
        }
        f.docs.forEach((d, i) => {
          const js = d.js as { kind?: unknown; metadata?: { name?: unknown } } | null;
          if (kind !== undefined && js?.kind !== kind) {
            return;
          }
          if (name !== undefined && js?.metadata?.name !== name) {
            return;
          }
          if (locate === null || resolvePath(d.js, locate).length > 0) {
            candidates.push({ path: p, doc: i });
          }
        });
      }
      if (candidates.length !== 1) {
        const where = `${e.file}${locate ? ` ${locate}` : ''}`;
        return skip(
          key,
          candidates.length ? 'ambiguous_target' : 'target_not_found',
          candidates.length
            ? both(
                `edits[${ei}]：${where} 匹配到 ${candidates.length} 处`,
                `edits[${ei}]: ${where} matched ${candidates.length} places`,
              )
            : both(`edits[${ei}]：仓库中找不到 ${where}`, `edits[${ei}]: ${where} was not found in the repository`),
        );
      }
      const { path, doc } = candidates[0]!;
      let file = loaded.get(path)!;
      for (const [si, s] of e.set.entries()) {
        let at: Concrete;
        try {
          at = resolveSetTarget(file.docs[doc]!.js, setPaths[si]!);
        } catch (err) {
          if (!(err instanceof PathError)) {
            throw err;
          }
          // 同名告警有多条规则、数组元素不存在等：目标不唯一或不存在，模板跳过
          return skip(
            key,
            'ambiguous_target',
            both(`edits[${ei}].set[${si}]：${err.message}`, `edits[${ei}].set[${si}]: ${err.message}`),
          );
        }
        const current = getAt(file.docs[doc]!.js, at) ?? null;
        const value = toPlain(s.value({ ...vars, current }));
        if (JSON.stringify(value) !== JSON.stringify(current)) {
          file = setValue(file, doc, at, value);
        }
      }
      for (const a of e.append) {
        const hits = resolvePath(file.docs[doc]!.js, substitutePath(a.path, subst));
        if (hits.length !== 1) {
          throw new Error(`append 路径 ${a.path} 匹配到 ${hits.length} 处`);
        }
        file = appendValue(file, doc, hits[0]!, toPlain(a.value(vars)));
      }
      loaded.set(path, file);
    }
  } catch (err) {
    return skip(key, 'evaluation_error', both(`修改文件出错：${String(err)}`, `Editing files failed: ${String(err)}`));
  }

  const changed = [...loaded.entries()]
    .filter(([p, f]) => f.text !== original.get(p))
    .map(([path, f]) => ({ path, before: original.get(path)!, after: f.text }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!changed.length) {
    return skip(key, 'no_change', both('文件已经是目标状态，没有需要修改的内容', 'The files already match the target'));
  }
  const msgVars = { ...params, ...letValues };
  return {
    kind: 'plan',
    key,
    pack: r.pack,
    id: def.id,
    category: def.category,
    repository: def.repository,
    title: def.title,
    base: await target.repo.head(),
    files: changed,
    patch: changed.map((c) => formatPatch(c.path, c.before, c.after)).join(''),
    change: format(r.change, msgVars),
    verify: { say: format(r.verify, msgVars), cards: def.verify.cards ?? [], within: def.verify.within ?? null },
    rollback: { say: format(r.rollback, msgVars) },
  };
}
