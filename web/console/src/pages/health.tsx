// Agent 健康与成本（DESIGN §12.2、附录 A）：P0 记分卡与阈值对照、运行指标、按天/事件/模型的成本、出境账本。

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  DataTable,
  EmptyState,
  KeyValue,
  Mono,
  PageHeader,
  Panel,
  Segmented,
  Stat,
  useI18n,
  type ColumnDef,
} from '@srenautix/ui';
import type { HubComponents, HubOperations } from '@srenautix/contract';
import { useMemo } from 'react';
import { hub, ok } from '../api';
import { useNow } from '../now';
import { Loaded, ROLES_ALL } from './common';
import styles from './pages.module.css';

type Health = HubComponents['schemas']['AgentHealth'];
type Cost = HubOperations['getAgentCost']['responses'][200]['content']['application/json'];
type Ledger = HubOperations['getEgressLedger']['responses'][200]['content']['application/json'];
export type CostGroup = 'day' | 'incident' | 'model';

const CMP: Record<Health['scorecard'][number]['comparator'], string> = { lt: '<', le: '≤', ge: '≥', eq: '=' };
const RATIO_METRICS = new Set([
  'untested_competitor_ratio',
  'replay_top1',
  'benign_false_positive',
  'portability_top1',
  'zero_tool_ratio',
]);

function Scorecard({ h }: { h: Health }) {
  const { t, fmt } = useI18n();
  const show = (metric: string, v: number) => (RATIO_METRICS.has(metric) ? fmt.percent(v) : fmt.number(v, 1));
  return (
    <Panel
      title={t('health.scorecard')}
      meta={t('health.streak', {
        days: h.consecutive_days_met,
        required: h.required_days,
        since: fmt.dateTime(h.since),
      })}
    >
      <div className={styles.statGrid}>
        {h.scorecard.map((s) => (
          <Stat
            key={s.metric}
            label={t(`health.metric.${s.metric}`)}
            value={s.value === null ? t('health.not_measured') : show(s.metric, s.value)}
            tone={s.diagnostic ? 'neutral' : s.met === null ? 'nodata' : s.met ? 'ok' : 'bad'}
            threshold={
              s.diagnostic
                ? t('health.diagnostic')
                : t('health.threshold', { cmp: CMP[s.comparator], v: show(s.metric, s.threshold) }) +
                  (s.met === null ? '' : s.met ? ` · ${t('health.met')}` : ` · ${t('health.not_met')}`)
            }
            hint={
              s.numerator !== null && s.denominator !== null
                ? `${fmt.number(s.numerator, 1)} / ${fmt.number(s.denominator, 1)}`
                : undefined
            }
          />
        ))}
      </div>
    </Panel>
  );
}

function Runtime({ h }: { h: Health }) {
  const { t, fmt } = useI18n();
  const p = (v: number | null) => (v === null ? t('health.not_measured') : fmt.percent(v));
  return (
    <Panel title={t('health.runtime')}>
      <KeyValue
        items={[
          { k: t('health.rt.zero_tool'), v: p(h.runtime.zero_tool_ratio) },
          { k: t('health.rt.untested'), v: p(h.runtime.untested_competitor_ratio) },
          {
            k: t('health.rt.rerun_p95'),
            v: h.runtime.rerun_p95 === null ? t('health.not_measured') : fmt.number(h.runtime.rerun_p95, 1),
          },
          { k: t('health.rt.budget_cutoff'), v: p(h.runtime.budget_cutoff_ratio) },
          { k: t('health.rt.fallback'), v: p(h.runtime.fallback_ratio) },
        ]}
      />
    </Panel>
  );
}

function CostPanel({ group }: { group: CostGroup }) {
  const { t, fmt } = useI18n();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const from = new Date(day - 13 * 86_400_000).toISOString();
  const to = new Date(day + 86_400_000).toISOString();
  const q = useQuery({
    queryKey: ['agent', 'cost', group, from],
    queryFn: async () =>
      ok<Cost>('getAgentCost', await hub.GET('/v1/agent/cost', { params: { query: { group_by: group, from, to } } })),
  });
  const cols = useMemo<ColumnDef<Cost['items'][number]>[]>(
    () => [
      { header: t(`health.cost.key.${group}`), accessorKey: 'label' },
      { header: t('health.cost.runs'), accessorKey: 'runs', enableSorting: true },
      { header: t('health.cost.input'), cell: ({ row }) => fmt.number(row.original.input_tokens, 0) },
      { header: t('health.cost.output'), cell: ({ row }) => fmt.number(row.original.output_tokens, 0) },
      {
        id: 'cost',
        header: t('health.cost.cost'),
        accessorKey: 'cost',
        enableSorting: true,
        cell: ({ row }) => fmt.money(row.original.cost, q.data?.currency ?? 'CNY'),
      },
    ],
    [t, fmt, group, q.data?.currency],
  );
  return (
    <Panel
      title={t('health.cost.title')}
      meta={
        q.data?.daily_budget != null
          ? t('health.cost.budget', { b: fmt.money(q.data.daily_budget, q.data.currency) })
          : undefined
      }
      actions={
        <Segmented
          label={t('health.cost.group')}
          value={group}
          onChange={(g) =>
            void navigate({ to: '/health', search: (p: { cluster?: string }) => ({ cluster: p.cluster, cost: g }) })
          }
          options={(['day', 'incident', 'model'] as const).map((g) => ({ value: g, label: t(`health.cost.by.${g}`) }))}
        />
      }
    >
      <Loaded q={q} what={t('health.cost.failed')} roles={ROLES_ALL}>
        {(d) => (
          <DataTable
            data={d.items}
            columns={cols}
            getRowId={(r) => r.key}
            label={t('health.cost.title')}
            initialSort={group === 'day' ? [] : [{ id: 'cost', desc: true }]}
            empty={<EmptyState kind="none" title={t('health.cost.empty_title')} because={t('health.cost.empty')} />}
          />
        )}
      </Loaded>
    </Panel>
  );
}

function EgressLedger() {
  const { t, fmt } = useI18n();
  const now = useNow(60_000);
  const from = new Date(Math.floor(now / 3_600_000) * 3_600_000 - 7 * 86_400_000).toISOString();
  const q = useQuery({
    queryKey: ['egress', from],
    queryFn: async () =>
      ok<Ledger>('getEgressLedger', await hub.GET('/v1/egress/ledger', { params: { query: { from } } })),
  });
  const cols = useMemo<ColumnDef<Ledger[number]>[]>(
    () => [
      { header: t('health.egress.at'), cell: ({ row }) => fmt.clock(row.original.at, now) },
      { header: t('health.egress.route'), accessorKey: 'route_id' },
      {
        header: t('health.egress.domain'),
        cell: ({ row }) => (row.original.in_domain ? t('run.in_domain') : t('run.out_of_domain')),
      },
      {
        header: t('health.egress.categories'),
        cell: ({ row }) => row.original.categories.map((c) => t(`run.category.${c}`)).join('、'),
      },
      { header: t('health.egress.bytes'), cell: ({ row }) => fmt.number(row.original.bytes, 0) },
      { header: t('health.egress.hits'), accessorKey: 'redaction_hits' },
      {
        header: t('health.egress.run'),
        cell: ({ row }) => (
          <Link to="/runs/$runId" params={{ runId: row.original.run_id }}>
            <Mono>{row.original.run_id.slice(0, 8)}</Mono>
          </Link>
        ),
      },
    ],
    [t, fmt, now],
  );
  return (
    <Panel title={t('health.egress.title')} meta={t('health.egress.window')}>
      <Loaded q={q} what={t('health.egress.failed')} roles={ROLES_ALL}>
        {(d) => (
          <DataTable
            data={d}
            columns={cols}
            getRowId={(r) => `${r.run_id}/${r.at}/${r.route_id}`}
            label={t('health.egress.title')}
            rowTone={(r) => (r.in_domain ? undefined : 'warn')}
            empty={<EmptyState kind="none" title={t('health.egress.empty_title')} because={t('health.egress.empty')} />}
          />
        )}
      </Loaded>
    </Panel>
  );
}

export function HealthPage({ cost }: { cost: CostGroup }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['agent', 'health'],
    queryFn: async () =>
      ok<Health>('getAgentHealth', await hub.GET('/v1/agent/health', { params: { query: { window: '14d' } } })),
  });
  return (
    <div className={styles.page}>
      <PageHeader title={t('health.title')} />
      <Loaded q={q} what={t('health.failed')} roles={ROLES_ALL}>
        {(h) => (
          <>
            <Scorecard h={h} />
            <Runtime h={h} />
          </>
        )}
      </Loaded>
      <CostPanel group={cost} />
      <EgressLedger />
    </div>
  );
}
