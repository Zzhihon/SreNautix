import { jsonrepair } from 'jsonrepair';
import { formatErrors, salvage, validatorOf } from './schema.js';
import type { LlmTurn } from './types.js';

// 修复阶梯（DESIGN §8.2）：解析 → jsonrepair → 校验 → 按字段挽救 → 带上错误重新请求一次 → 换下一条路由 →
// 只出确定性报告并标注"模型输出无效"。本文件实现单次输出上的前四级；后三级由 session.ts 驱动。
// 级别名与契约 LlmCall.repair_step 一致：记录最终成功或失败的那一级。

export type RepairStep =
  'parse' | 'jsonrepair' | 'validate' | 'field_salvage' | 'reask' | 'next_route' | 'deterministic_only';

/** 一次输出在本地修复后的结果 */
export type LocalOutcome =
  | { ok: true; value: unknown; step: 'validate' | 'jsonrepair' | 'field_salvage'; notes: string[] }
  | { ok: false; step: 'parse' | 'jsonrepair' | 'field_salvage'; refusal: boolean; error: string };

export function repairLocally(turn: LlmTurn, schema: Record<string, unknown>): LocalOutcome {
  if (turn.refusal) {
    return { ok: false, step: 'parse', refusal: true, error: `模型拒绝输出：${turn.refusal.slice(0, 300)}` };
  }
  if (turn.incomplete) {
    return { ok: false, step: 'parse', refusal: false, error: `模型输出不完整：${turn.incomplete}` };
  }
  const text = turn.text?.trim() ?? '';
  if (!text) {
    return { ok: false, step: 'parse', refusal: false, error: '模型没有输出文本' };
  }
  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    let fixed: string;
    try {
      fixed = jsonrepair(text);
    } catch (r) {
      return {
        ok: false,
        step: 'jsonrepair',
        refusal: false,
        error: `输出不是 JSON（${(e as Error).message}），jsonrepair 也无法修复（${(r as Error).message}）`,
      };
    }
    parsed = JSON.parse(fixed);
    repaired = true;
  }
  const validate = validatorOf(schema);
  if (validate(parsed)) {
    return repaired
      ? { ok: true, value: parsed, step: 'jsonrepair', notes: ['模型输出经 jsonrepair 修复后才能解析'] }
      : { ok: true, value: parsed, step: 'validate', notes: [] };
  }
  const firstErrors = formatErrors(validate.errors);
  const notes: string[] = [];
  const s = salvage(schema, parsed, notes);
  if (s.ok && validate(s.value)) {
    return {
      ok: true,
      value: s.value,
      step: 'field_salvage',
      notes: [`模型输出不符合 schema（${firstErrors}），按字段挽救`, ...notes],
    };
  }
  return { ok: false, step: 'field_salvage', refusal: false, error: `输出不符合 schema：${firstErrors}` };
}

/** "重新请求"附加的用户消息 */
export function reaskText(error: string, language: 'zh' | 'en'): string {
  return language === 'zh'
    ? `上一次的输出无法使用：${error}\n请重新输出完整的 JSON 对象，严格符合给定的 schema，不要输出任何其他文字。`
    : `The previous output could not be used: ${error}\nOutput the complete JSON object again, strictly conforming to the schema, with no other text.`;
}
