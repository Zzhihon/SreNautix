// 空状态：必须写明原因（DESIGN §12.4）。"没有事件"和"接入在 14:02 中断"由 tone 与 because
// 区分开：前者是 neutral，后者是 bad 并带出影响它的条件。

import { CircleSlash, Filter, Lock, PlugZap, Inbox, AlertOctagon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export type EmptyKind = 'none' | 'filtered' | 'degraded' | 'not_configured' | 'forbidden' | 'not_applicable';

const ICONS: Record<EmptyKind, LucideIcon> = {
  none: Inbox,
  filtered: Filter,
  degraded: AlertOctagon,
  not_configured: PlugZap,
  forbidden: Lock,
  not_applicable: CircleSlash,
};

export function EmptyState({
  kind,
  title,
  because,
  action,
}: {
  kind: EmptyKind;
  title: ReactNode;
  /** 为什么是空的：数据确实为零的依据，或者造成空白的条件。 */
  because: ReactNode;
  action?: ReactNode;
}) {
  const Icon = ICONS[kind];
  return (
    <div className={styles.empty} data-kind={kind} role={kind === 'degraded' ? 'alert' : 'status'}>
      <Icon className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        <div className={styles.title}>{title}</div>
        <div className={styles.because}>{because}</div>
        {action && <div className={styles.action}>{action}</div>}
      </div>
    </div>
  );
}
