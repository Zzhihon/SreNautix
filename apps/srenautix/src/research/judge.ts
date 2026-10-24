import { PROMPTS, type Language } from '../prompts/index.js';
import type { Item, Segment } from '../llm/types.js';

// 只读工具结果的小模型判定（DESIGN §7.2 discriminate，type=tool）：对照 refutes_if 给出支持、推翻或无法判定。
// 事件研判与主动优化共用（ADR 0146 §2.7）。

function seg(text: string, categories: Segment['categories'], egress: Segment['egress']): Segment {
  return { text, categories, egress };
}

export function judgeItems(
  language: Language,
  input: { hypothesis: string; purpose: string; refutesIf: string; tool: string; result: string },
  /** 工具结果携带的出境类别；事件研判的只读工具为 metrics、logs、events */
  categories: Segment['categories'] = ['metrics', 'logs', 'events'],
): Item[] {
  return [
    { type: 'system', segments: [seg(PROMPTS[language].judge, [], 'allow')] },
    {
      type: 'user',
      segments: [
        seg(
          `## 检查\n\`\`\`json\n${JSON.stringify({
            hypothesis: input.hypothesis,
            purpose: input.purpose,
            refutes_if: input.refutesIf,
            tool: input.tool,
          })}\n\`\`\``,
          [],
          'redact',
        ),
        seg(`## 工具结果\n${input.result}`, categories, 'redact'),
      ],
    },
  ];
}

/** 小模型判定只读工具结果的输出 schema（可移植子集） */
export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'] },
    summary: { type: 'string', maxLength: 400 },
  },
} as const;
