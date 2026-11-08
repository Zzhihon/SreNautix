import type { Alert, Incident } from '@srenautix/contract';

type Member = Incident['members'][number];

/**
 * 头条告警组（ADR 0190）：正在触发的 symptom 告警；没有时取正在触发的 critical 告警；再没有时取传入的全部告警。
 * 通知标题的症状短语与收件箱一行的问题陈述都从这一组取。调用方只传仍在事件中的成员（left_version 为 null）。
 */
export function headlineMembers<M extends Pick<Member, 'role' | 'status' | 'severity'>>(members: readonly M[]): M[] {
  const firing = members.filter((m) => m.status === 'firing');
  const symptoms = firing.filter((m) => m.role === 'symptom');
  if (symptoms.length) {
    return symptoms;
  }
  const critical = firing.filter((m) => m.severity === 'critical');
  return critical.length ? critical : [...members];
}

/** 头条告警：头条告警组里开始时间最早的一条，同时开始时取 alert_id 较小的；事件没有仍在其中的成员时为 null */
export function headlineMember(incident: Pick<Incident, 'members'>): Member | null {
  const group = headlineMembers(incident.members.filter((m) => m.left_version === null));
  const sorted = group.sort(
    (a, b) =>
      Date.parse(a.starts_at) - Date.parse(b.starts_at) ||
      (a.alert_id < b.alert_id ? -1 : a.alert_id > b.alert_id ? 1 : 0),
  );
  return sorted[0] ?? null;
}

/** 告警注解里的问题陈述：summary 注解，没有时取 description 注解；空字符串按没有处理 */
export function alertStatement(alert: Pick<Alert, 'annotations'>): string | null {
  return alert.annotations.summary || alert.annotations.description || null;
}
