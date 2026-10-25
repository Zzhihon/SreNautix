import type { Incident } from '@srenautix/contract';

// 事件的计时起点（ADR 0159）：阶段 A 时延与首条消息时延都从这里算。
// 新事件从首个成员告警的触发时刻算；从已有事件拆分出的事件从拆分时刻（事件自己的 created_at）算，
// 拆分前这些告警已经随原事件发出过阶段 A 和消息。

export type IncidentOrigin = 'new' | 'split';

export function incidentOrigin(inc: Pick<Incident, 'split_from'>): IncidentOrigin {
  return inc.split_from === null ? 'new' : 'split';
}

/** 计时起点的毫秒时间戳 */
export function incidentOnsetMs(inc: Pick<Incident, 'split_from' | 'first_firing_at' | 'created_at'>): number {
  return Date.parse(inc.split_from === null ? inc.first_firing_at : inc.created_at);
}
