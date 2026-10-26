// 时间线（DESIGN §12.2）：一条泳道。告警、变更、异常起点、阶段 A、研判、提议、执行与反馈画成标记，
// 盲区画成斜纹；每条记录的说明列在泳道下方的有序列表里，图表与注解不叠加。来源于告警、日志或变更的
// 原文（untrusted）放进注明来源的引用样式，只作为文本显示（不变量 9）。
// 变更记录带有代码计算的关联分级与依据（ADR 0169），写在原文之前。

import {
  AlertOctagon,
  Bot,
  CheckCircle2,
  GitCommitHorizontal,
  GitMerge,
  Gavel,
  Link2,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Play,
  Split,
  TrendingUp,
} from 'lucide-react';
import type { TimelineEntry } from '../contract';
import { useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Tip } from '../primitives/overlays';
import { StatusPill, type Tone } from '../primitives/Status';
import styles from './TimelineLane.module.css';

type Kind = TimelineEntry['kind'];
type ChangeLink = NonNullable<TimelineEntry['change_link']>;

const GRADE_TONE: Record<ChangeLink['grade'], Tone> = { high: 'warn', medium: 'info', low: 'neutral' };

/** 变更与事件的关联：分级、依据与回退 */
function ChangeLinkPill({ link }: { link: ChangeLink }) {
  const { t } = useI18n();
  const parts = [
    t(`timeline.change_grade.${link.grade}`),
    ...link.basis.map((b) => t(`timeline.change_basis.${b}`)),
    ...(link.rollback ? [t('timeline.change_rollback')] : []),
  ];
  return (
    <StatusPill tone={GRADE_TONE[link.grade]} icon={Link2} title={t('timeline.change_link_title')}>
      {parts.join(' · ')}
    </StatusPill>
  );
}

const KIND: Record<Kind, { icon: LucideIcon; tone: Tone }> = {
  alert_firing: { icon: AlertOctagon, tone: 'bad' },
  alert_resolved: { icon: CheckCircle2, tone: 'ok' },
  change: { icon: GitCommitHorizontal, tone: 'info' },
  card_abnormal: { icon: TrendingUp, tone: 'bad' },
  incident_merged: { icon: GitMerge, tone: 'neutral' },
  incident_split: { icon: Split, tone: 'neutral' },
  stage_a: { icon: ListChecks, tone: 'neutral' },
  research_concluded: { icon: Bot, tone: 'model' },
  proposal: { icon: Gavel, tone: 'warn' },
  execution: { icon: Play, tone: 'info' },
  feedback: { icon: MessageSquare, tone: 'ok' },
};

export function TimelineLane({
  items,
  from,
  to,
  blind = [],
}: {
  items: readonly TimelineEntry[];
  from: number;
  to: number;
  /** 盲区（接入中断或观测失明）。 */
  blind?: ReadonlyArray<[number, number]>;
}) {
  const { t, fmt } = useI18n();
  if (!items.length) {
    return <EmptyState kind="none" title={t('timeline.empty_title')} because={t('timeline.empty_because')} />;
  }
  const span = Math.max(1, to - from);
  const pos = (ms: number) => `${Math.min(100, Math.max(0, ((ms - from) / span) * 100))}%`;
  const ticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);
  return (
    <div className={styles.wrap}>
      <div className={styles.lane} role="img" aria-label={t('timeline.lane_label', { n: items.length })}>
        {blind.map(([a, b], i) => (
          <span
            key={`b${i}`}
            className={styles.blind}
            style={{ left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` }}
            title={t('timeline.blind', { from: fmt.clock(a), to: fmt.clock(b) })}
          />
        ))}
        {items.map((it, i) => {
          const k = KIND[it.kind];
          const Icon = k.icon;
          return (
            <Tip key={i} text={`${fmt.clock(it.at)} ${t(`timeline.kind.${it.kind}`)}\n${it.text}`}>
              <a className={styles.mark} data-tone={k.tone} style={{ left: pos(Date.parse(it.at)) }} href={`#tl-${i}`}>
                <Icon aria-hidden="true" />
              </a>
            </Tip>
          );
        })}
      </div>
      <div className={styles.axis} aria-hidden="true">
        {ticks.map((tk, i) => (
          <span key={i} style={{ left: pos(tk) }}>
            {fmt.clock(tk)}
          </span>
        ))}
      </div>
      <ol className={styles.list}>
        {items.map((it, i) => {
          const k = KIND[it.kind];
          const Icon = k.icon;
          return (
            <li key={i} id={`tl-${i}`} className={styles.item}>
              <time dateTime={it.at} className={styles.time}>
                {fmt.clock(it.at)}
              </time>
              <span className={styles.kind} data-tone={k.tone}>
                <Icon aria-hidden="true" />
                {t(`timeline.kind.${it.kind}`)}
              </span>
              <div className={styles.body}>
                {it.change_link && <ChangeLinkPill link={it.change_link} />}
                {it.untrusted ? (
                  <blockquote className={styles.quote}>
                    <span className={styles.quoteSrc}>{t('timeline.untrusted_source')}</span>
                    {it.text}
                  </blockquote>
                ) : (
                  <span className={styles.text}>{it.text}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
