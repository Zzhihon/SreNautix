// 事件收件箱（DESIGN §12.2）。过滤条件由宿主保存在 URL 中；被抑制的事件折叠成计数，不隐藏；
// 盲区色带标出接入中断与观测失明的时段；空状态写明是"确实没有事件"还是"接入中断"。

import { EyeOff } from 'lucide-react';
import type { BlindSpan, Disposition } from '../contract';
import { useConditions, useIncidents } from '../data';
import { activeConditions } from '../domain/ConditionStrip';
import { IncidentRow } from '../domain/IncidentRow';
import { useI18n } from '../i18n';
import { Button, ErrorBox, Loading, PageHeader, Panel, Toolbar } from '../primitives/basic';
import { EmptyState } from '../primitives/EmptyState';
import { Segmented, SelectField } from '../primitives/form';
import type { IncidentQuery } from '../port';
import styles from './views.module.css';

export interface InboxFilters {
  state: 'firing' | 'resolved' | 'all';
  severity?: 'critical' | 'warning' | 'info';
  feedback: 'pending' | 'given' | 'all';
  disposition?: Disposition;
  suppressed: boolean;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = { state: 'firing', feedback: 'all', suppressed: false };

/** 盲区色带的时段：最近 6 小时。 */
export const BAND_MS = 6 * 3_600_000;

function BlindBand({ spans, from, to }: { spans: readonly BlindSpan[]; from: number; to: number }) {
  const { t, fmt } = useI18n();
  const pos = (ms: number) => `${((Math.min(to, Math.max(from, ms)) - from) / (to - from)) * 100}%`;
  const text = (s: BlindSpan) =>
    t('inbox.band_span', {
      kind: t(`inbox.blind.${s.kind}`),
      cluster: s.cluster_id,
      from: fmt.clock(s.from, to),
      to: s.to ? fmt.clock(s.to, to) : t('inbox.band_ongoing'),
      reason: s.reason,
    });
  return (
    <div className={styles.band}>
      <div className={styles.bandLabel}>
        {t('inbox.band', { h: BAND_MS / 3_600_000 })}
        {spans.length === 0 && <span className={styles.dim}> · {t('inbox.band_ok')}</span>}
      </div>
      <div className={styles.bandTrack} role="img" aria-label={t('inbox.band_aria', { n: spans.length })}>
        {spans.map((s, i) => {
          const a = Date.parse(s.from);
          const b = s.to ? Date.parse(s.to) : to;
          return (
            <span
              key={i}
              className={styles.bandBlind}
              data-kind={s.kind}
              style={{ left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` }}
              title={text(s)}
            />
          );
        })}
      </div>
      {spans.length > 0 && (
        <ul className={styles.bandList}>
          {spans.map((s, i) => (
            <li key={i}>{text(s)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InboxView({
  cluster,
  filters,
  onFilters,
  now,
}: {
  cluster?: string;
  filters: InboxFilters;
  onFilters: (f: InboxFilters) => void;
  /** 当前时间，按分钟取整后用作查询窗口的终点。 */
  now: number;
}) {
  const { t, fmt } = useI18n();
  const to = Math.floor(now / 60_000) * 60_000;
  const from = to - BAND_MS;
  const q: IncidentQuery = {
    cluster_id: cluster,
    state: filters.state,
    severity: filters.severity,
    disposition: filters.disposition,
    feedback: filters.feedback,
    suppressed: filters.suppressed,
  };
  const list = useIncidents(q);
  const conds = useConditions(cluster);
  const rows = list.data?.items ?? [];
  const silent = activeConditions(conds.data ?? []).find(
    (c) => c.type === 'IngestSilent' || c.type === 'StateStoreDegraded',
  );
  const filtered = filters.severity !== undefined || filters.disposition !== undefined || filters.feedback !== 'all';
  const spans = (list.data?.blind_spans ?? []).filter((s) => (s.to ? Date.parse(s.to) : to) > from);

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('inbox.title')}
        meta={list.data ? t('inbox.meta', { n: rows.length, suppressed: list.data.suppressed_count }) : undefined}
      />
      <Toolbar label={t('inbox.filters')}>
        <Segmented
          label={t('inbox.f.state')}
          value={filters.state}
          onChange={(state) => onFilters({ ...filters, state })}
          options={[
            { value: 'firing', label: t('inbox.state.firing') },
            { value: 'resolved', label: t('inbox.state.resolved') },
            { value: 'all', label: t('inbox.state.all') },
          ]}
        />
        <Segmented
          label={t('inbox.f.feedback')}
          value={filters.feedback}
          onChange={(feedback) => onFilters({ ...filters, feedback })}
          options={[
            { value: 'all', label: t('inbox.feedback.all') },
            { value: 'pending', label: t('inbox.feedback.pending') },
            { value: 'given', label: t('inbox.feedback.given') },
          ]}
        />
        <div className={styles.filterSelect}>
          <SelectField
            label={t('inbox.f.severity')}
            value={filters.severity ?? ''}
            placeholder={t('inbox.any')}
            onChange={(e) =>
              onFilters({ ...filters, severity: (e.currentTarget.value || undefined) as InboxFilters['severity'] })
            }
            options={(['critical', 'warning', 'info'] as const).map((s) => ({
              value: s,
              label: t(`status.severity.${s}`),
            }))}
          />
        </div>
        <div className={styles.filterSelect}>
          <SelectField
            label={t('inbox.f.disposition')}
            value={filters.disposition ?? ''}
            placeholder={t('inbox.any')}
            onChange={(e) =>
              onFilters({ ...filters, disposition: (e.currentTarget.value || undefined) as Disposition | undefined })
            }
            options={(['act', 'escalate', 'ignore', 'undetermined'] as const).map((d) => ({
              value: d,
              label: t(`status.disposition.${d}`),
            }))}
          />
        </div>
      </Toolbar>
      {list.data && <BlindBand spans={spans} from={from} to={to} />}
      <Panel label={t('inbox.list')}>
        {list.isPending ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox title={t('inbox.load_failed')} error={list.error} />
        ) : rows.length === 0 ? (
          silent ? (
            <EmptyState
              kind="degraded"
              title={t('inbox.empty_degraded_title')}
              because={t('inbox.empty_degraded', {
                cond: t(`condition.${silent.type}`),
                at: fmt.clock(silent.since, now),
                msg: silent.message,
              })}
            />
          ) : filtered ? (
            <EmptyState
              kind="filtered"
              title={t('inbox.empty_filtered_title')}
              because={t('inbox.empty_filtered')}
              action={
                <Button size="sm" onClick={() => onFilters({ ...DEFAULT_INBOX_FILTERS, state: filters.state })}>
                  {t('inbox.clear_filters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              kind="none"
              title={t(`inbox.empty_none_title.${filters.state}`)}
              because={t('inbox.empty_none', { at: fmt.clock(list.dataUpdatedAt, now) })}
            />
          )
        ) : (
          <ul className={styles.rows} aria-label={t('inbox.list')}>
            {rows.map((s) => (
              <li key={s.incident_id}>
                <IncidentRow s={s} now={now} />
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.suppressed_count > 0 && !filters.suppressed && (
          <div className={styles.suppressed}>
            <EyeOff aria-hidden="true" width={14} height={14} />
            <span>{t('inbox.suppressed', { n: list.data.suppressed_count })}</span>
            <Button size="sm" variant="link" onClick={() => onFilters({ ...filters, suppressed: true })}>
              {t('inbox.show_suppressed')}
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
