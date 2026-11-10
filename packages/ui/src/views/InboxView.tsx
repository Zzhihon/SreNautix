// 事件收件箱（DESIGN §12.2）。过滤条件由宿主保存在 URL 中；被抑制的事件折叠成计数，不隐藏；
// 盲区色带标出接入中断与观测失明的时段；空状态写明是"确实没有事件"还是"接入中断"。
// 部署方声明了业务领域时（ADR 0193）默认按业务领域分组，组按声明顺序，没有业务领域的事件在最后；每行标出主服务。

import { EyeOff } from 'lucide-react';
import type { BlindSpan, BusinessDomainList, Disposition, IncidentSummary } from '../contract';
import { useBusinessDomains, useConditions, useIncidents } from '../data';
import { activeConditions } from '../domain/ConditionStrip';
import { IncidentRow, type RowService } from '../domain/IncidentRow';
import { localizedText, useI18n } from '../i18n';
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
  /** 只看这个业务领域（ADR 0193） */
  business_domain?: string;
  /** domain：按业务领域分组（默认）；none：不分组 */
  group: 'domain' | 'none';
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  state: 'firing',
  feedback: 'all',
  suppressed: false,
  group: 'domain',
};

interface DomainGroup {
  id: string | null;
  title: string;
  rows: IncidentSummary[];
}

/**
 * 收件箱的分组：业务领域按声明顺序，组内保持列表的顺序；主业务领域为空或不在声明里的事件归入最后的"未归属"组。
 * 没有声明任何业务领域时返回 null（不分组）
 */
export function groupByDomain(
  rows: readonly IncidentSummary[],
  domains: BusinessDomainList | undefined,
  titleOf: (d: BusinessDomainList['items'][number]) => string,
  unassigned: string,
): DomainGroup[] | null {
  if (!domains || domains.items.length === 0) {
    return null;
  }
  const groups = domains.items.map((d): DomainGroup => ({ id: d.id, title: titleOf(d), rows: [] }));
  const rest: DomainGroup = { id: null, title: unassigned, rows: [] };
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const r of rows) {
    (byId.get(r.business_domain ?? '') ?? rest).rows.push(r);
  }
  return [...groups, rest].filter((g) => g.rows.length > 0);
}

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
  const { t, fmt, locale } = useI18n();
  const to = Math.floor(now / 60_000) * 60_000;
  const from = to - BAND_MS;
  const q: IncidentQuery = {
    cluster_id: cluster,
    state: filters.state,
    severity: filters.severity,
    disposition: filters.disposition,
    feedback: filters.feedback,
    suppressed: filters.suppressed,
    business_domain: filters.business_domain ? [filters.business_domain] : undefined,
  };
  const list = useIncidents(q);
  const domains = useBusinessDomains(cluster);
  const serviceTitle = new Map(
    (domains.data?.items ?? []).flatMap((d) => d.services.map((s) => [s.id, localizedText(s.title, locale)] as const)),
  );
  const rowService = (s: IncidentSummary): RowService | null => {
    const title = s.primary_service ? serviceTitle.get(s.primary_service) : undefined;
    return title ? { title, presumed: s.primary_service_source === 'namespace' } : null;
  };
  const conds = useConditions(cluster);
  const rows = list.data?.items ?? [];
  const silent = activeConditions(conds.data ?? []).find(
    (c) => c.type === 'IngestSilent' || c.type === 'StateStoreDegraded',
  );
  const filtered =
    filters.severity !== undefined ||
    filters.disposition !== undefined ||
    filters.business_domain !== undefined ||
    filters.feedback !== 'all';
  const groups =
    filters.group === 'domain'
      ? groupByDomain(rows, domains.data, (d) => localizedText(d.title, locale), t('inbox.domain_unassigned'))
      : null;
  const renderRows = (items: readonly IncidentSummary[]) => (
    <ul className={styles.rows} aria-label={t('inbox.list')}>
      {items.map((s) => (
        <li key={s.incident_id}>
          <IncidentRow s={s} now={now} service={rowService(s)} />
        </li>
      ))}
    </ul>
  );
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
        {(domains.data?.items.length ?? 0) > 0 && (
          <Segmented
            label={t('inbox.f.group')}
            value={filters.group}
            onChange={(group) => onFilters({ ...filters, group })}
            options={[
              { value: 'domain', label: t('inbox.group.domain') },
              { value: 'none', label: t('inbox.group.none') },
            ]}
          />
        )}
        {(domains.data?.items.length ?? 0) > 0 && (
          <div className={styles.filterSelect}>
            <SelectField
              label={t('inbox.f.business_domain')}
              value={filters.business_domain ?? ''}
              placeholder={t('inbox.any')}
              onChange={(e) => onFilters({ ...filters, business_domain: e.currentTarget.value || undefined })}
              options={(domains.data?.items ?? []).map((d) => ({ value: d.id, label: localizedText(d.title, locale) }))}
            />
          </div>
        )}
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
        ) : groups ? (
          groups.map((g) => (
            <section key={g.id ?? ''} className={styles.domainGroup} aria-label={g.title}>
              <h3 className={styles.domainTitle}>{t('inbox.domain_group', { title: g.title, n: g.rows.length })}</h3>
              {renderRows(g.rows)}
            </section>
          ))
        ) : (
          renderRows(rows)
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
