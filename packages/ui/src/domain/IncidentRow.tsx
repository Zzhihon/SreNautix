// 收件箱的一行（DESIGN §12.2、ADR 0190）：标题是问题陈述（头条告警的注解，其次告警名），副行是开始时刻、根因组件与集群，
// 再下一行是最近一次完成的研判的一句话结论；右侧是处置判断、结论阶梯、严重度、持续时长、研判新鲜度、待审批数、反馈状态，
// 以及"合并自 N"或"拆分自"。组件键与事件标签只在悬停提示里。标题前是事件的主服务（ADR 0193），按命名空间推定的标出推定。

import { Bot, Clock, GitMerge, Hourglass, Split } from 'lucide-react';
import type { IncidentSummary } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Status, StatusPill } from '../primitives/Status';
import { Truncate } from '../primitives/overlays';
import { componentLabel, displayComponent, feedbackState, incidentDuration, lineage } from './model';
import styles from './IncidentRow.module.css';

/** 一行的问题陈述：头条告警的注解，其次告警名；没有头条告警时取根因组件名 */
export function incidentProblem(s: IncidentSummary, rootName: string | null, noRoot: string): string {
  if (s.headline) {
    return s.headline.summary ?? s.headline.alertname;
  }
  return rootName ?? noRoot;
}

/** 一行的主服务：名称由宿主按 GET /v1/business-domains 取出；presumed 为按默认命名空间推定 */
export interface RowService {
  title: string;
  presumed: boolean;
}

export function IncidentRow({ s, now, service }: { s: IncidentSummary; now: number; service?: RowService | null }) {
  const { t, fmt } = useI18n();
  const { links } = useUiEnv();
  const root = s.root_component ? componentLabel(s.root_component, s.component_names) : null;
  const fb = feedbackState(s.feedback, s.disposition !== null);
  const problem = incidentProblem(s, root?.name ?? null, t('incident.no_root'));
  const since = t('incident.since', { t: fmt.clock(s.headline?.started_at ?? s.first_firing_at) });
  const rootText = root ? root.name : t('incident.no_root');
  const hover = [
    s.headline && s.headline.summary !== null ? t('incident.hover_alert', { name: s.headline.alertname }) : null,
    s.root_component ? t('incident.hover_component', { key: displayComponent(s.root_component) }) : null,
    t('incident.hover_label', { label: s.label }),
    t('incident.hover_id', { id: s.incident_id }),
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
  const research = s.headline?.research_summary ?? null;
  return (
    <AppLink
      href={links.incident(s.incident_id)}
      className={styles.row}
      title={hover}
      aria-label={t('incident.row_label', {
        title: service ? `${service.title} · ${problem}` : problem,
        since,
        root: rootText,
        cluster: s.cluster_id,
      })}
    >
      <span className={styles.sev} data-severity={s.severity}>
        <Status domain="severity" value={s.severity} />
      </span>
      <span className={styles.main}>
        <span className={styles.title}>
          {service && (
            <span
              className={styles.service}
              data-presumed={service.presumed || undefined}
              title={service.presumed ? t('incident.service_presumed') : undefined}
            >
              {service.title}
            </span>
          )}
          <Truncate text={problem} />
          {s.ambiguous && <span className={styles.flag}>{t('incident.ambiguous')}</span>}
          {s.research_root?.mismatch && <span className={styles.flag}>{t('incident.root_mismatch')}</span>}
        </span>
        <span className={styles.sub}>
          <span className={styles.since}>{since}</span>
          <span>{rootText}</span>
          <span className={styles.cluster}>{s.cluster_id}</span>
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
        {research !== null && (
          <span className={styles.research} data-testid="research-summary">
            <Bot aria-hidden="true" className={styles.icon} />
            <Truncate text={t('incident.research_line', { s: research })} className={styles.researchText} />
          </span>
        )}
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
