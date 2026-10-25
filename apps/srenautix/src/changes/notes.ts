import type { ChangeEvent } from '@srenautix/contract';

// 变更的补充说明（ADR 0161）：计划内的退役（之前合并的 Git 提交）与已合并、尚未同步的提交。阶段 A 时间线与通知共用；
// 提交说明是不可信文本，只作为文本显示。

const short = (key: string) => key.slice(key.indexOf(':') + 1);
const rev = (r: string | null) => (r ? r.slice(0, 12) : null);

export interface ChangeNote {
  kind: 'planned' | 'pending_sync';
  /** 计划依据的提交版本（前 12 位）；pending_sync 时为 null */
  revision: string | null;
  link: string | null;
  text: string;
}

export function changeNotes(c: ChangeEvent): ChangeNote[] {
  const out: ChangeNote[] = [];
  for (const p of c.planned_by ?? []) {
    out.push({
      kind: 'planned',
      revision: rev(p.revision),
      link: p.link,
      text: `计划内退役：${[rev(p.revision), p.summary].filter(Boolean).join(' ')}`,
    });
  }
  for (const p of c.pending_sync ?? []) {
    out.push({
      kind: 'pending_sync',
      revision: null,
      link: null,
      text: `已合并、尚未同步到 ${short(p.application)}${p.out_of_sync_since ? `（${p.out_of_sync_since} 起 OutOfSync）` : ''}`,
    });
  }
  return out;
}
