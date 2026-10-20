import { jsonrepair } from 'jsonrepair';
import type { EvidenceResult, HypothesizeOutput } from '@srenautix/contract';
import { formatErrors, validatorOf } from '../llm/schema.js';
import type { ModelSession } from '../llm/session.js';
import type { Language } from '../prompts/index.js';
import type { ToolBox, ToolCallRecord } from '../tools/box.js';
import type { Window } from '../tools/limits.js';
import type { CardEntry, EvidenceBook } from './evidence.js';
import type { Ledger } from './ledger.js';
import { judgeItems, JUDGE_SCHEMA } from './prompt.js';
import type { CheckTemplate, ResearchCase } from './types.js';
import { parseStoredKey } from '../topology/keys.js';

// 区分性检查（DESIGN §7.2 discriminate）：由控制器执行模型给出的 next_checks，把结果判定成新的证据卡。
// - type=query：领域包的查询模板，按模板附带的卡定义用 CEL 判定（判定方式 rule）；
// - type=tool：只读工具（内置或 MCP 白名单工具），结果由小模型对照 refutes_if 判定（判定方式 model）。

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

/** 检查的去重键 */
export function checkKey(c: NextCheck): string {
  return `${c.hypothesis_id}:${c.template}:${c.args_json.trim()}`;
}

/**
 * 校验一项检查：目标存在、参数是合法 JSON 且符合 schema；不合格时返回原因。
 * type 与目标不符（例如 type=query 却写了只读工具名）时按目标所在的列表改正，并返回说明。
 */
export function vetCheck(
  raw: NextCheck,
  rc: ResearchCase,
  box: ToolBox,
): { check: NextCheck; args: Record<string, unknown>; note: string | null } | { error: string } {
  let c = raw;
  let note: string | null = null;
  const isTemplate = rc.templates.some((x) => x.id === c.template);
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
    const t = rc.templates.find((x) => x.id === c.template);
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
  rc: ResearchCase;
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
    const t = env.rc.templates.find((x) => x.id === check.template) as CheckTemplate;
    const result = await env.query.run(t, args, {
      hypothesisId: h.id,
      rootComponent: h.rootComponent,
      bounds: env.bounds,
      signal: env.signal,
    });
    const card = env.book.addCheckCard({ ...result, card_id: `check/${h.id}/${seq}` }, h.id, 'rule');
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
      entity: entityOf(env.rc.incident.cluster_id, h.rootComponent),
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
  );
  const record = { ...res.record, result_ref: card.ref };
  await env.onTool(record);
  return { check, args, outcome: judged.value.outcome, card, tool: record, error: null };
}
