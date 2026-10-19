/** 风暴判定：同一渠道目标 5 分钟内有 3 个以上事件消息要发出时开启汇总，期间的新事件静默发送。 */
export const STORM_WINDOW_MS = 5 * 60_000;
export const STORM_THRESHOLD = 3;

export type StormDecision = 'none' | 'start' | 'join';

/**
 * existingCreated 是本目标已有事件消息的创建时间，newCount 是本轮新增的事件消息数，activeStorm 表示
 * 窗口内仍有新成员并入的风暴。
 */
export function decideStorm(
  now: number,
  existingCreated: readonly number[],
  newCount: number,
  activeStorm: boolean,
): StormDecision {
  if (newCount === 0) {
    return 'none';
  }
  if (activeStorm) {
    return 'join';
  }
  const recent = existingCreated.filter((t) => t >= now - STORM_WINDOW_MS).length;
  return recent + newCount >= STORM_THRESHOLD ? 'start' : 'none';
}
