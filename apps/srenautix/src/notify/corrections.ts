import type { Correction } from '../store/corrections.js';

/**
 * 通知层的数据修正（ADR 0176）。
 *
 * notify/ended-edit-cap-final-edit（ADR 0173 §4）：ADR 0173 之前的版本在已结束事件的消息编辑次数用完时直接放弃
 * （ended_edit_cap），没有尝试最后一次编辑。这些放弃清除后，消息由最后一次编辑补上。本版本自己写的 ended_edit_cap
 * 是最后一次编辑被渠道拒绝，带一条同一内容的终态记录（once 键为 <消息 id>:<期望内容哈希>），不清除：
 * 清除会让被拒绝的编辑再请求一次、再放弃一次。
 */
export const notifyCorrections: readonly Correction[] = [
  {
    name: 'notify/ended-edit-cap-final-edit',
    run: async (c) =>
      (
        await c.query(
          `UPDATE server.notify_messages m SET abandoned_at = NULL, abandoned_reason = NULL, next_attempt_at = now()
            WHERE m.abandoned_reason = 'ended_edit_cap' AND m.final_edited_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM server.incident_reasons r
                               WHERE r.incident_id = m.incident_id AND r.stage = 'notify' AND r.code = 'ended_edit_cap'
                                 AND r.once_key = m.id || ':' || m.desired_hash)`,
        )
      ).rowCount ?? 0,
  },
];
