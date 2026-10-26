// 状态条（DESIGN §12.4）：每个页面顶部、不可关闭。列出正在发生的条件；没有条件时也占位，
// 写明"各角色条件正常"及检查时间，让"没有问题"和"读不到条件"区分开。

import type { Condition } from '../contract';
import { useI18n } from '../i18n';
import { Status, StatusPill, STATUS } from '../primitives/Status';
import styles from './ConditionStrip.module.css';

export type ConditionType = Condition['type'];

/** 条件的严重程度：会让判定失真或写操作失控的为 critical。控制台不认识的类型按 warning 显示。 */
export const CONDITION_SEVERITY: Record<ConditionType, 'critical' | 'warning'> = {
  IngestSilent: 'critical',
  WatchdogMissing: 'critical',
  DatasourceUnavailable: 'warning',
  ModelRouteBreakerOpen: 'warning',
  AdmissionSelfTestFailed: 'critical',
  PackLoadFailed: 'warning',
  BudgetCutoffHigh: 'warning',
  ChannelDeliveryFailed: 'warning',
  NotifyAbandoned: 'warning',
  AuditExportLagging: 'critical',
  ClockSkew: 'critical',
  StateStoreDegraded: 'critical',
  Restored: 'warning',
  Frozen: 'critical',
  StormMode: 'warning',
  InformersFresh: 'warning',
  TunnelConnected: 'warning',
  QueryManifest: 'warning',
  Datasource: 'warning',
  AlertReconcile: 'warning',
};

/** 条件的严重程度；不认识的类型（较新的 server 上报的类型）按 warning */
export function conditionSeverity(type: string): 'critical' | 'warning' {
  return (CONDITION_SEVERITY as Record<string, 'critical' | 'warning'>)[type] ?? 'warning';
}

/** 让集群只提议、不执行的条件（DESIGN §12.2 集群：所有页面红色"仅提议"）。 */
export const PROPOSE_ONLY: ReadonlySet<ConditionType> = new Set(['AdmissionSelfTestFailed', 'Frozen']);

export function activeConditions(list: readonly Condition[]): Condition[] {
  const rank = (c: Condition) => (conditionSeverity(c.type) === 'critical' ? 0 : 1);
  return list.filter((c) => c.status === 'true').sort((a, b) => rank(a) - rank(b) || a.since.localeCompare(b.since));
}

export function ConditionStrip({
  conditions,
  checkedAt,
  now,
  error,
}: {
  conditions: readonly Condition[] | undefined;
  /** 最近一次读取条件的时间。 */
  checkedAt: number | null;
  /** 当前时间：当天的时刻只写时分。 */
  now: number;
  /** 读取条件失败时的错误：状态条本身也要显性失败。 */
  error?: unknown;
}) {
  const { t, fmt, has } = useI18n();
  if (error) {
    return (
      <div className={styles.strip} data-level="critical" role="alert" aria-label={t('conditions.label')}>
        <StatusPill tone="bad" icon={STATUS.condition.critical.icon}>
          {t('conditions.unreadable')}
        </StatusPill>
        <span className={styles.msg}>{error instanceof Error ? error.message : String(error)}</span>
      </div>
    );
  }
  if (!conditions) {
    return (
      <div className={styles.strip} data-level="pending" aria-label={t('conditions.label')}>
        <span className={styles.msg}>{t('conditions.loading')}</span>
      </div>
    );
  }
  const active = activeConditions(conditions);
  const proposeOnly = [...new Set(active.filter((c) => PROPOSE_ONLY.has(c.type)).map((c) => c.cluster_id ?? '*'))];
  if (!active.length) {
    return (
      <div className={styles.strip} data-level="ok" role="status" aria-label={t('conditions.label')}>
        <Status domain="condition" value="ok" />
        <span className={styles.msg}>
          {t('conditions.all_clear', { at: checkedAt === null ? '' : fmt.clock(checkedAt, now) })}
        </span>
      </div>
    );
  }
  const level = active.some((c) => conditionSeverity(c.type) === 'critical') ? 'critical' : 'warning';
  return (
    <div className={styles.strip} data-level={level} role="alert" aria-label={t('conditions.label')}>
      {proposeOnly.map((cl) => (
        <StatusPill key={cl} tone="bad" icon={STATUS.condition.frozen.icon} strong>
          {cl === '*' ? t('conditions.propose_only_all') : t('conditions.propose_only', { cluster: cl })}
        </StatusPill>
      ))}
      <ul className={styles.list}>
        {active.map((c) => (
          <li key={`${c.type}/${c.role}/${c.cluster_id ?? ''}/${c.subject ?? ''}`} className={styles.item}>
            <Status
              domain="condition"
              value={c.type === 'Frozen' ? 'frozen' : conditionSeverity(c.type)}
              title={c.reason}
            />
            <span className={styles.type}>{has(`condition.${c.type}`) ? t(`condition.${c.type}`) : c.type}</span>
            {c.subject && <span className={styles.subject}>{c.subject}</span>}
            <span className={styles.msg}>{c.message}</span>
            <span className={styles.since}>
              {t('conditions.since', { at: fmt.clock(c.since, now), role: c.role, cluster: c.cluster_id ?? '-' })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
