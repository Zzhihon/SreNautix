import { jsonrepair } from 'jsonrepair';
import type { EvidenceResult, HypothesizeOutput } from '@srenautix/contract';
import { formatErrors, validatorOf } from '../llm/schema.js';
import type { ModelSession } from '../llm/session.js';
import type { Language } from '../prompts/index.js';
import type { ToolBox, ToolCallRecord } from '../tools/box.js';
import type { Window } from '../tools/limits.js';
import type { CheckTemplate } from './catalog.js';
import type { CardEntry, EvidenceBook } from './evidence.js';
import { judgeItems, JUDGE_SCHEMA } from './judge.js';
import type { Ledger, LedgerEntry } from './ledger.js';
import { targets } from './targeting.js';
import { parseCardCheckId } from '../stage-a/card-checks.js';
import { parseStoredKey } from '../topology/keys.js';

// 区分性检查（DESIGN §7.2 discriminate）：由控制器执行模型给出的 next_checks，把结果判定成新的证据卡。
// - type=query：领域包的查询模板，按模板附带的卡定义用 CEL 判定（判定方式 rule）；
// - type=tool：只读工具（内置或 MCP 白名单工具），结果由小模型对照 refutes_if 判定（判定方式 model）。
// 事件研判与主动优化共用（ADR 0146 §2.7），只依赖检查目录与账本，不依赖事件。

export type NextCheck = HypothesizeOutput['next_checks'][number];

export interface QueryRunContext {
  hypothesisId: string;
  rootComponent: string;
  bounds: Window;
  signal: AbortSignal;
}

/** 查询模板的执行与判定（由领域包运行时提供）；返回的卡 ref 由证据簿重新分配 */
export interface QueryRunner {
  run(template: CheckTemplate, args: Record<string, unknown>, ctx: QueryRunContext): Promise<EvidenceResult>;
}

export interface ExecutedCheck {
  check: NextCheck;
  args: Record<string, unknown>;
  outcome: 'supports' | 'refutes' | 'inconclusive' | 'failed';
  card: CardEntry | null;
  tool: ToolCallRecord | null;
  error: string | null;
}

const CARD_CHECK_ID = /cardcheck:[^\s"'`,，。;；()（）[\]{}<>]+/g;

/**
 * hypothesize 输出的 next_checks 在本地校验之前的补全（ADR 0127）：条目缺少 template、或 template 不是可用的模板与工具时，
 * 从条目里出现的检查 id 推断。
 * - 条目任何字段（包括多余字段，例如 id、check_id）的字符串里有可用的模板名或工具名时直接用它；
 * - 有 `cardcheck:<包>/<链>/<卡>@<组件>` 时：完全相同的可用检查优先；组件不在列表中、或 id 没有写组件时，取同一张卡在
 *   假设根因上的检查，再取这张卡唯一的检查；
 * - 推断出卡片检查、或 type 缺失时 type 补为 query。
 * 推断不出的条目保持原样，按字段挽救时只删除这一条。每处补全写入 notes。
 */
export function inferCheckTemplates(value: unknown, templates: readonly string[], notes: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.next_checks)) {
    return value;
  }
  const available = new Set(templates);
  const hypotheses = Array.isArray(v.hypotheses) ? (v.hypotheses as Array<Record<string, unknown>>) : [];
  const rootOf = (id: unknown) => {
    const h = hypotheses.find((x) => x && x.id === id);
    return typeof h?.root_component === 'string' ? h.root_component : null;
  };
  const strings = (x: unknown, out: string[] = []): string[] => {
    if (typeof x === 'string') {
      out.push(x);
    } else if (Array.isArray(x)) {
      x.forEach((y) => strings(y, out));
    } else if (x && typeof x === 'object') {
      Object.values(x).forEach((y) => strings(y, out));
    }
    return out;
  };
  const byCard = (card: string) => templates.filter((t) => parseCardCheckId(t)?.card === card);
  const next_checks = (v.next_checks as unknown[]).map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }
    const c = item as Record<string, unknown>;
    if (typeof c.template === 'string' && available.has(c.template)) {
      return item;
    }
    const texts = strings(c);
    let found = texts.find((s) => available.has(s.trim()))?.trim() ?? null;
    let from: string | null = found;
    if (!found) {
      for (const id of texts.flatMap((s) => [...s.matchAll(CARD_CHECK_ID)].map((m) => m[0]))) {
        const at = id.indexOf('@');
        const card = (at < 0 ? id : id.slice(0, at)).slice('cardcheck:'.length);
        const same = byCard(card);
        const root = rootOf(c.hypothesis_id);
        found = available.has(id)
          ? id
          : (same.find((t) => root !== null && parseCardCheckId(t)?.component === root) ??
            (same.length === 1 ? same[0]! : null));
        if (found) {
          from = id;
          break;
        }
      }
    }
    if (!found) {
      return item;
    }
    notes.push(
      `/next_checks[${i}]：template ${typeof c.template === 'string' ? `${JSON.stringify(c.template)} 不可用` : '缺失'}，按检查 id ${from} 补为 ${found}`,
    );
    // type 缺失或不合法时补为 query（vetCheck 会把指向只读工具的 query 改为 tool）；卡片检查总是 query
    const typeOk = c.type === 'query' || c.type === 'tool';
    return { ...c, template: found, ...(!typeOk || parseCardCheckId(found) ? { type: 'query' } : {}) };
  });
  return { ...v, next_checks };
}

/** 检查的去重键 */
/** hypothesize 没有给出任何 next_checks 时，控制器补选的检查数上限（ADR 0137） */
export const SUPPLEMENT_LIMIT = 3;

/**
 * hypothesize 的 next_checks 为空时由控制器补选检查（ADR 0137）：
 * - 只取卡片检查（`cardcheck:`），并且检查的组件（按组件粒度）属于研判对象的组件 subjectComponents
 *   （事件研判为根因、候选根因与成员告警的组件，见 incident.ts 的 incidentSupplement）；
 * - 依次为待检验的假设（open，按账本排名）各取一项：组件就是假设的根因组件、测的信号与假设机制对应（ADR 0133）、
 *   本次运行没有执行过的检查中，按候选清单的顺序（清单已按相关性排列，ADR 0116）取第一项；
 * - 最多 SUPPLEMENT_LIMIT 项，参数全部取卡片默认值（窗口取卡片定义）。
 */
export function supplementChecks(
  templates: readonly CheckTemplate[],
  subjectComponents: ReadonlySet<string>,
  ledger: Ledger,
  open: readonly LedgerEntry[],
  done: ReadonlySet<string>,
  language: Language,
): NextCheck[] {
  const offered = templates.flatMap((t) => {
    const p = parseCardCheckId(t.id);
    if (!p) {
      return [];
    }
    const component = ledger.componentOf(p.component);
    return subjectComponents.has(component) ? [{ id: t.id, component }] : [];
  });
  const out: NextCheck[] = [];
  const used = new Set<string>();
  for (const e of open) {
    if (out.length >= SUPPLEMENT_LIMIT) {
      break;
    }
    const defs = ledger.supportDefinitions(e);
    const pick = offered.find(
      (t) =>
        t.component === e.rootComponent &&
        !used.has(t.id) &&
        !done.has(`${e.id}:${t.id}:{}`) &&
        targets(t.id, e.mechanism, defs, ledger.rules, e.symptoms).related,
    );
    if (!pick) {
      continue;
    }
    used.add(pick.id);
    out.push({
      hypothesis_id: e.id as NextCheck['hypothesis_id'],
      type: 'query',
      template: pick.id,
      args_json: '{}',
      refutes_if:
        language === 'zh' ? `这张卡在 ${pick.component} 上判为正常` : `The card is judged normal on ${pick.component}`,
      purpose:
        language === 'zh'
          ? `hypothesize 没有给出检查，控制器按相关性补选，检验假设 ${e.id} 的根因 ${pick.component}`
          : `hypothesize gave no checks; picked by the controller by relevance to test ${e.id} on ${pick.component}`,
    });
  }
  return out;
}

export function checkKey(c: NextCheck): string {
  return `${c.hypothesis_id}:${c.template}:${c.args_json.trim()}`;
}

/**
 * 校验一项检查：目标存在、参数是合法 JSON 且符合 schema；不合格时返回原因。
 * type 与目标不符（例如 type=query 却写了只读工具名）时按目标所在的列表改正，并返回说明。
 */
export function vetCheck(
  raw: NextCheck,
  templates: readonly CheckTemplate[],
  box: ToolBox,
): { check: NextCheck; args: Record<string, unknown>; note: string | null } | { error: string } {
  let c = raw;
  let note: string | null = null;
  const isTemplate = templates.some((x) => x.id === c.template);
  if (c.type === 'query' && !isTemplate && box.has(c.template)) {
    c = { ...c, type: 'tool' };
    note = `检查 ${c.template}（假设 ${c.hypothesis_id}）：type 写成 query，目标是只读工具，已改为 tool`;
  } else if (c.type === 'tool' && !box.has(c.template) && isTemplate) {
    c = { ...c, type: 'query' };
    note = `检查 ${c.template}（假设 ${c.hypothesis_id}）：type 写成 tool，目标是查询模板，已改为 query`;
  }
  let args: unknown;
  try {
    args = c.args_json.trim() ? JSON.parse(c.args_json) : {};
  } catch (e) {
    // 修复阶梯的 jsonrepair 一级同样适用于参数文本（常见的是多转义了一层引号）
    let fixed: string;
    try {
      fixed = jsonrepair(c.args_json.replaceAll('\\"', '"'));
    } catch {
      return { error: `args_json 不是合法 JSON（${(e as Error).message}）` };
    }
    args = JSON.parse(fixed);
    const n = `检查 ${c.template}（假设 ${c.hypothesis_id}）：args_json 经 jsonrepair 修复`;
    note = note ? `${note}；${n}` : n;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { error: 'args_json 必须是 JSON 对象' };
  }
  if (c.type === 'query') {
    const t = templates.find((x) => x.id === c.template);
    if (!t) {
      return { error: `查询模板 ${c.template} 不存在` };
    }
    const v = validatorOf(t.args);
    if (!v(args)) {
      return { error: `参数不符合模板 schema：${formatErrors(v.errors)}` };
    }
    return { check: c, args: args as Record<string, unknown>, note };
  }
  if (!box.has(c.template)) {
    return { error: `只读工具 ${c.template} 不可用` };
  }
  return { check: c, args: args as Record<string, unknown>, note };
}

function verdictOf(outcome: 'supports' | 'refutes' | 'inconclusive'): EvidenceResult['verdict'] {
  return outcome === 'supports' ? 'abnormal' : outcome === 'refutes' ? 'normal' : 'undeterminable';
}

/** 组件键 → EntityRef */
export function entityOf(clusterId: string, component: string): EvidenceResult['entity'] {
  // 名称段解码为原始对象名（ADR 0034），数据源查询用原始名称
  const p = parseStoredKey(component);
  return { cluster_id: clusterId, kind: p.kind, namespace: p.namespace, name: p.name, uid: null };
}

export interface CheckEnv {
  /** 本次运行的查询模板 */
  templates: readonly CheckTemplate[];
  /** 工具结果卡的实体所在的集群 */
  clusterId: string;
  book: EvidenceBook;
  ledger: Ledger;
  box: ToolBox;
  query: QueryRunner | null;
  session: ModelSession;
  language: Language;
  bounds: Window;
  signal: AbortSignal;
  onTool(r: ToolCallRecord): Promise<void>;
}

const JUDGE_OUTPUT = {
  name: 'check_judgement',
  schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
  full: JUDGE_SCHEMA as unknown as Record<string, unknown>,
};

export async function runCheck(
  env: CheckEnv,
  check: NextCheck,
  args: Record<string, unknown>,
  seq: number,
): Promise<ExecutedCheck> {
  const h = env.ledger.entries.get(check.hypothesis_id);
  if (!h) {
    return { check, args, outcome: 'failed', card: null, tool: null, error: `假设 ${check.hypothesis_id} 不存在` };
  }
  if (check.type === 'query') {
    if (!env.query) {
      return { check, args, outcome: 'failed', card: null, tool: null, error: '查询模板的运行时不可用' };
    }
    const t = env.templates.find((x) => x.id === check.template) as CheckTemplate;
    const result = await env.query.run(t, args, {
      hypothesisId: h.id,
      rootComponent: h.rootComponent,
      bounds: env.bounds,
      signal: env.signal,
    });
    const card = env.book.addCheckCard({ ...result, card_id: `check/${h.id}/${seq}` }, h.id, 'rule', check.template);
    const outcome =
      result.verdict === 'abnormal' ? 'supports' : result.verdict === 'normal' ? 'refutes' : 'inconclusive';
    return { check, args, outcome, card, tool: null, error: null };
  }
  const res = await env.box.invoke(check.template, JSON.stringify(args), { bounds: env.bounds, signal: env.signal });
  if (res.text === null) {
    await env.onTool(res.record);
    return { check, args, outcome: 'failed', card: null, tool: res.record, error: res.record.error };
  }
  const judged = await env.session.structured<{ outcome: 'supports' | 'refutes' | 'inconclusive'; summary: string }>(
    'compress',
    {
      items: judgeItems(env.language, {
        hypothesis: `${h.id} ${h.rootComponent}: ${h.mechanism}`,
        purpose: check.purpose,
        refutesIf: check.refutes_if,
        tool: check.template,
        result: res.text,
      }),
      maxOutputTokens: 1024,
      temperature: 0,
    },
    JUDGE_OUTPUT,
  );
  if (!judged.ok) {
    await env.onTool(res.record);
    return {
      check,
      args,
      outcome: 'failed',
      card: null,
      tool: res.record,
      error: `工具结果判定失败：${judged.detail}`,
    };
  }
  const now = new Date().toISOString();
  const verdict = verdictOf(judged.value.outcome);
  const window = res.record.window ?? {
    from: new Date(env.bounds.from).toISOString(),
    to: new Date(env.bounds.to).toISOString(),
  };
  const card = env.book.addCheckCard(
    {
      ref: 'card:1',
      card_id: `check/${h.id}/${seq}`,
      title: { 'zh-CN': `区分性检查：${check.template}`, en: `Discriminating check: ${check.template}` },
      threshold: null,
      series: [],
      entity: entityOf(env.clusterId, h.rootComponent),
      window,
      verdict,
      display_state: verdict,
      reason: { kind: 'model_judged', text: judged.value.summary },
      value: null,
      table: null,
      queries: [
        {
          name: check.template,
          integration: check.template.split('.')[0] as string,
          capability: 'tool',
          query: JSON.stringify(args),
          sample_count: 0,
          truncated: res.record.truncated,
          error: null,
          duration_ms: res.record.duration_ms,
        },
      ],
      egress: 'redact',
      anomaly_started_at: null,
      evaluated_at: now,
    } as EvidenceResult,
    h.id,
    'model',
    check.template,
  );
  const record = { ...res.record, result_ref: card.ref };
  await env.onTool(record);
  return { check, args, outcome: judged.value.outcome, card, tool: record, error: null };
}
