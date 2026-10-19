import type { KnowledgeItem, ReferenceCase } from '../research/types.js';
import type { Tool } from './box.js';
import { shape, ToolArgError } from './limits.js';

// 内置的只读工具：只读本次研判已经检索到的知识条目与参考案例，不发出任何外部请求。

function id(args: Record<string, unknown>): string {
  const v = args.id;
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolArgError('缺少字符串参数 id');
  }
  return v.trim();
}

const ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string' } },
};

export function builtinTools(knowledge: readonly KnowledgeItem[], cases: readonly ReferenceCase[]): Tool[] {
  return [
    {
      name: 'knowledge_entry',
      description: '读取一个已检索到的知识条目全文（领域包 knowledge）。',
      parameters: ID_PARAMS,
      source: 'builtin',
      live: false,
      async run(args) {
        const k = knowledge.find((x) => x.id === id(args));
        if (!k) {
          throw new ToolArgError(`没有知识条目 ${id(args)}`);
        }
        return { ...shape(k, []), window: null, limitApplied: null };
      },
    },
    {
      name: 'reference_case',
      description: '读取一个参考案例：事件开始之前已解决、经人工确认的历史事件（按 incident_id）。',
      parameters: ID_PARAMS,
      source: 'builtin',
      live: false,
      async run(args) {
        const c = cases.find((x) => x.incident_id === id(args));
        if (!c) {
          throw new ToolArgError(`没有参考案例 ${id(args)}`);
        }
        return { ...shape(c, []), window: null, limitApplied: null };
      },
    },
  ];
}
