// 收件箱的一行（DESIGN §12.2）：处置判断、结论阶梯、根因组件与集群、严重度、持续时长、
// 研判新鲜度、待审批数、反馈状态，以及"合并自 N"或"拆分自"。

import { Clock, GitMerge, Hourglass, Split } from 'lucide-react';
import type { IncidentSummary } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Status, StatusPill } from '../primitives/Status';
import { Truncate } from '../primitives/overlays';
import { componentLabel, feedbackState, incidentDuration, lineage } from './model';
import styles from './IncidentRow.module.css';

export function IncidentRow({ s, now }: { s: IncidentSummary; now: number }) {
  const { t, fmt } = useI18n();
  const { links } = useUiEnv();
  const root = s.root_component ? componentLabel(s.root_component) : null;
  const fb = feedbackState(s.feedback, s.disposition !== null);
  const title = root ? root.name : s.label;
  return (
    <AppLink
      href={links.incident(s.incident_id)}
      className={styles.row}
      aria-label={t('incident.row_label', { title, label: s.label })}
    >
      <span className={styles.sev} data-severity={s.severity}>
        <Status domain="severity" value={s.severity} />
      </span>
      <span className={styles.main}>
        <span className={styles.title}>
          <Truncate text={root ? `${root.name}` : t('incident.no_root')} />
          {s.ambiguous && <span className={styles.flag}>{t('incident.ambiguous')}</span>}
        </span>
        <span className={styles.sub}>
          {root && <span>{root.sub}</span>}
          <span className={styles.cluster}>{s.cluster_id}</span>
          <span className={styles.mono}>{s.label}</span>
          {lineage(s).map((l) =>
            l === 'merged' ? (
              <StatusPill key="m" tone="neutral" icon={GitMerge}>
                {t('incident.merged_from', { n: s.merged_from_count })}
              </StatusPill>
            ) : (
              <StatusPill key="s" tone="neutral" icon={Split}>
                {t('incident.split_from')}
              </StatusPill>
            ),
          )}
          {s.suppressed && <Status domain="incident" value="suppressed" />}
          {s.observability_blind && <Status domain="incident" value="blind" />}
        </span>
      </span>
      <span className={styles.verdict}>
        {s.disposition ? (
          <Status domain="disposition" value={s.disposition} />
        ) : (
          <span className={styles.dim}>{t('incident.no_disposition')}</span>
        )}
        {s.conclusion_level && <Status domain="conclusion" value={s.conclusion_level} />}
      </span>
      <span className={styles.meta}>
        <span title={fmt.dateTime(s.first_firing_at)}>
          <Clock aria-hidden="true" className={styles.icon} />
          {s.state === 'firing'
            ? t('incident.firing_for', { d: fmt.duration(incidentDuration(s, now)) })
            : t('incident.lasted', { d: fmt.duration(incidentDuration(s, now)) })}
        </span>
        <span className={styles.dim}>
          {s.research_fresh_at
            ? t('incident.fresh', { ago: fmt.relative(s.research_fresh_at, now) })
            : t('incident.not_researched')}
        </span>
      </span>
      <span className={styles.tail}>
        {s.pending_approvals > 0 && (
          <StatusPill tone="warn" icon={Hourglass}>
            {t('incident.pending_approvals', { n: s.pending_approvals })}
          </StatusPill>
        )}
        <Status domain="feedback" value={fb} />
      </span>
    </AppLink>
  );
}
