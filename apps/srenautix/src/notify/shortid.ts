import { createHash } from 'node:crypto';
import type { ButtonTarget } from './ports.js';

/**
 * 按钮的 short id：由渠道、渠道目标、按钮种类与作用对象决定，同一个按钮每次渲染得到同一个 id（16 个 base64url 字符）。
 * owner 只用于只允许某个人点击的跟进按钮（例如选择正确的处置判断）。
 */
export function shortId(
  channel: string,
  chat: string,
  kind: string,
  t: ButtonTarget,
  owner: string | null = null,
): string {
  const parts = [
    channel,
    chat,
    kind,
    t.incidentId,
    String(t.incidentVersion),
    t.proposalId ?? '',
    t.researchRunId ?? '',
    t.rootComponent ?? '',
    t.disposition ?? '',
    owner ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest().subarray(0, 12).toString('base64url');
}
