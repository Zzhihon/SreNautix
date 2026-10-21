// 卡片作为阶段 B 区分性检查时的参数（ADR 0116，契约 2.17.0 的卡片 check 块）。server 与评测共用这里的 schema 与合并规则：
// - 参数全部可选：window_before、window_after（相对检查锚点的时长；锚点与阶段 A 相同，是事件首次触发，或这个组件上之后才
//   升级的成员告警的开始时间，ADR 0131）与卡片 params 的键；
// - 卡片声明了 check.args 时 params 的取值范围按它约束，否则类型取默认值的类型；
// - 合并：给出的 params 覆盖卡片默认值；只给出一个窗口端点时另一个取卡片定义。

import type { CardDefinition } from './types.js';

export const CHECK_WINDOW_KEYS = ['window_before', 'window_after'] as const;

const DURATION = { type: 'string', pattern: '^([0-9]+(ms|s|m|h|d|w))+$' } as const;
const DEFAULT_WINDOW = { before: '30m', after: '10m' };

/** 卡片作为检查时的参数 schema：全部可选，不允许其他字段 */
export function checkArgsSchema(card: CardDefinition): Record<string, unknown> {
  const declared = (card.check?.args?.properties as Record<string, unknown> | undefined) ?? {};
  const properties: Record<string, unknown> = {
    window_before: {
      ...DURATION,
      description:
        '窗口起点：锚点之前多久（锚点是事件首次触发，或这个组件上之后才升级的告警的开始时间；默认取卡片定义）',
    },
    window_after: { ...DURATION, description: '窗口终点：锚点之后多久，不晚于当前时间（默认取卡片定义）' },
  };
  for (const [k, v] of Object.entries(card.params ?? {})) {
    properties[k] = declared[k] ?? {
      type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string',
    };
  }
  return { type: 'object', additionalProperties: false, properties };
}

/** 检查参数 → 卡片参数（覆盖默认值的部分）与窗口覆盖；没有给出窗口端点时 window 为 undefined */
export function applyCheckArgs(
  card: CardDefinition,
  args: Record<string, unknown>,
): { params: Record<string, number | string | boolean>; window: { before: string; after: string } | undefined } {
  const params: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!(CHECK_WINDOW_KEYS as readonly string[]).includes(k) && ['number', 'string', 'boolean'].includes(typeof v)) {
      params[k] = v as number | string | boolean;
    }
  }
  const before = typeof args.window_before === 'string' ? args.window_before : undefined;
  const after = typeof args.window_after === 'string' ? args.window_after : undefined;
  const def = card.window ?? DEFAULT_WINDOW;
  return { params, window: before || after ? { before: before ?? def.before, after: after ?? def.after } : undefined };
}
