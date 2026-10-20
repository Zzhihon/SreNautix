// 回放与评测（DESIGN §12.2、§14.4）：按"模型 × 用例集"的成绩单。快照成绩与重建成绩分开列出，
// 每个比例都同时给出分子、分母和自助法置信区间；发布门禁写出配对差下界与阈值。

import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { HubComponents, HubOperations } from '@srenautix/contract';
import { useState } from 'react';
import {
  Button,
  displayComponent,
  EmptyState,
  ErrorBox,
  KeyValue,
  Loading,
  Mono,
  PageHeader,
  Panel,
  Segmented,
  SelectField,
  StatusPill,
  TextField,
  useI18n,
  type EvalReport,
} from '@srenautix/ui';
import { CheckCircle2, OctagonX } from 'lucide-react';
import { hub, ok } from '../api';
import styles from './pages.module.css';

type Ratio = EvalReport['rows'][number]['top1'];
export type EvalMode = 'snapshot' | 'reconstructed';

function RatioCell({ r, gate, lowerIsBetter }: { r: Ratio; gate?: number; lowerIsBetter?: boolean }) {
  const { fmt, t } = useI18n();
  if (r.value === null) {
    return <span className={styles.dim}>{t('eval.no_denominator', { d: r.denominator })}</span>;
  }
  const miss = gate !== undefined && (lowerIsBetter ? r.value > gate : r.value < gate);
  return (
    <span className={styles.stack}>
      <span className={miss ? styles.bad : undefined}>
        {fmt.percent(r.value)}{' '}
        <span className={styles.dim}>
          ({fmt.number(r.numerator, 1)}/{fmt.number(r.denominator, 1)})
        </span>
      </span>
      {r.ci_low !== null && r.ci_high !== null && (
        <span className={styles.dim}>{t('eval.ci', { lo: fmt.percent(r.ci_low), hi: fmt.percent(r.ci_high) })}</span>
      )}
    </span>
  );
}

function Scorecard({ report }: { report: EvalReport }) {
  const { t, fmt } = useI18n();
  return (
    <div className={styles.page}>
      <Panel
        title={t('eval.scorecard', { suite: report.case_set, mode: t(`eval.mode.${report.mode}`) })}
        meta={t('eval.meta', {
          runs: report.runs_per_case,
          sha: report.code_sha.slice(0, 10),
          at: fmt.dateTime(report.created_at),
        })}
      >
        {report.rows.length === 0 ? (
          <EmptyState kind="none" title={t('eval.no_rows_title')} because={t('eval.no_rows')} />
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('eval.col.model')}</th>
                  <th scope="col">{t('eval.col.pack_timing')}</th>
                  <th scope="col">{t('eval.col.top1')}</th>
                  <th scope="col">{t('eval.col.recall3')}</th>
                  <th scope="col">{t('eval.col.passk', { k: report.runs_per_case })}</th>
                  <th scope="col">{t('eval.col.disposition')}</th>
                  <th scope="col">{t('eval.col.benign_fp')}</th>
                  <th scope="col">{t('eval.col.undetermined')}</th>
                  <th scope="col">{t('eval.col.structured')}</th>
                  <th scope="col">{t('eval.col.cost')}</th>
                  {report.mode === 'snapshot' && <th scope="col">{t('eval.col.miss')}</th>}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={`${r.route_id}/${r.pack_timing}`}>
                    <th scope="row">
                      {r.route_id}
                      <div className={styles.dim}>
                        <Mono>{r.model}</Mono>
                      </div>
                    </th>
                    <td>{t(`eval.pack_timing.${r.pack_timing}`)}</td>
                    <td>
                      <RatioCell r={r.top1} gate={0.6} />
                    </td>
                    <td>
                      <RatioCell r={r.recall_at_3} />
                    </td>
                    <td>
                      <RatioCell r={r.pass_pow_k} />
                    </td>
                    <td>
                      <RatioCell r={r.disposition_accuracy} />
                    </td>
                    <td>
                      <RatioCell r={r.benign_false_positive} gate={0.1} lowerIsBetter />
                    </td>
                    <td>
                      <RatioCell r={r.undetermined_ratio} />
                    </td>
                    <td>
                      <RatioCell r={r.structured_output_failure} />
                    </td>
                    <td>
                      {fmt.money(r.cost_per_case.mean, r.cost_per_case.currency)}
                      <div className={styles.dim}>p90 {fmt.money(r.cost_per_case.p90, r.cost_per_case.currency)}</div>
                    </td>
                    {report.mode === 'snapshot' && (
                      <td>{r.snapshot_miss_rate === null ? '-' : fmt.percent(r.snapshot_miss_rate)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.dim}>{t('eval.gates_note')}</p>
      </Panel>
      <Panel title={t('eval.gate')}>
        {report.gate === null ? (
          <EmptyState kind="not_applicable" title={t('eval.no_gate_title')} because={t('eval.no_gate')} />
        ) : (
          <>
            <StatusPill
              tone={report.gate.passed ? 'ok' : 'bad'}
              icon={report.gate.passed ? CheckCircle2 : OctagonX}
              strong
            >
              {report.gate.passed ? t('eval.gate_passed') : t('eval.gate_failed')}
            </StatusPill>
            <KeyValue
              items={[
                {
                  k: t('eval.paired_delta'),
                  tone: report.gate.paired_delta_low < report.gate.threshold ? 'bad' : undefined,
                  v: t('eval.paired_delta_v', {
                    low: fmt.number(report.gate.paired_delta_low * 100, 1),
                    th: fmt.number(report.gate.threshold * 100, 1),
                  }),
                },
                {
                  k: t('eval.regressed'),
                  tone: report.gate.regressed_cases.length ? 'bad' : undefined,
                  v: report.gate.regressed_cases.length ? report.gate.regressed_cases.join(', ') : t('common.none'),
                },
                {
                  k: t('eval.waived'),
                  v: report.gate.waived_cases.length ? report.gate.waived_cases.join(', ') : t('common.none'),
                },
                { k: t('eval.baseline'), v: <Mono>{report.gate.baseline_report_id}</Mono> },
              ]}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

type EvalCase = HubComponents['schemas']['EvalCase'];
type Trend = HubOperations['getEvalTrend']['responses'][200]['content']['application/json'];
type Estimate = HubOperations['estimateEval']['responses'][200]['content']['application/json'];

/** 用例浏览器：标准答案、领域包时间、被排除的材料（防泄漏）与最近的结果。 */
function CaseBrowser({ suite, mode }: { suite: string; mode: EvalMode }) {
  const { t, fmt } = useI18n();
  const q = useQuery({
    queryKey: ['eval', 'cases', suite, mode],
    queryFn: async () =>
      ok<{ items: EvalCase[]; next_cursor: string | null }>(
        'listEvalCases',
        await hub.GET('/v1/eval/cases', { params: { query: { suite, mode, limit: 200 } } }),
      ),
  });
  return (
    <Panel title={t('eval.cases')} meta={suite}>
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox title={t('eval.cases_failed')} error={q.error} />
      ) : q.data.items.length === 0 ? (
        <EmptyState kind="none" title={t('eval.no_cases_title')} because={t('eval.no_cases')} />
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('eval.case')}</th>
                <th scope="col">{t('eval.truth')}</th>
                <th scope="col">{t('eval.col.pack_timing')}</th>
                <th scope="col">{t('eval.excluded')}</th>
                <th scope="col">{t('eval.results')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.case_id}>
                  <th scope="row">
                    {c.label}
                    <div className={styles.dim}>
                      {t(`eval.case_type.${c.type}`)} · {t(`eval.snapshot.${c.snapshot_status}`)} ·{' '}
                      {fmt.dateTime(c.created_at)}
                    </div>
                  </th>
                  <td>
                    {c.truth.root_components.map(displayComponent).join(', ') || '-'}
                    <div className={styles.dim}>
                      {c.truth.granularity ? t(`eval.granularity.${c.truth.granularity}`) : '-'} ·{' '}
                      {c.truth.disposition ? t(`status.disposition.${c.truth.disposition}`) : '-'}
                    </div>
                  </td>
                  <td>{t(`eval.pack_timing.${c.pack_timing}`)}</td>
                  <td>
                    {c.excluded.length === 0 ? (
                      t('common.none')
                    ) : (
                      <ul className={styles.stack}>
                        {c.excluded.map((x, i) => (
                          <li key={i}>
                            {t(`eval.excluded_kind.${x.kind}`)} · <Mono>{x.ref}</Mono> · {x.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {c.last_results.map((r) => (
                      <div key={r.route_id}>
                        {r.route_id}: {r.passes}/{r.runs}
                        {r.top1_hit === null ? '' : r.top1_hit ? ` · ${t('eval.hit')}` : ` · ${t('eval.miss')}`}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function TrendPanel({ suite, mode }: { suite: string; mode: EvalMode }) {
  const { t, fmt } = useI18n();
  const q = useQuery({
    queryKey: ['eval', 'trend', suite, mode],
    queryFn: async () =>
      ok<Trend>('getEvalTrend', await hub.GET('/v1/eval/trend', { params: { query: { suite, mode } } })),
  });
  return (
    <Panel title={t('eval.trend')}>
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox title={t('eval.trend_failed')} error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyState kind="none" title={t('eval.no_trend_title')} because={t('eval.no_trend')} />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('eval.version')}</th>
              <th scope="col">{t('eval.col.top1')}</th>
              <th scope="col">{t('eval.gate')}</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((v) => (
              <tr key={`${v.version}/${v.code_sha}`}>
                <th scope="row">
                  {v.version}
                  <div className={styles.dim}>
                    <Mono>{v.code_sha.slice(0, 10)}</Mono> · {fmt.dateTime(v.created_at)}
                  </div>
                </th>
                <td>
                  {v.rows.map((r) => (
                    <div key={r.route_id}>
                      {r.route_id}: {r.top1.value === null ? '-' : fmt.percent(r.top1.value)} (
                      {fmt.number(r.top1.numerator, 1)}/{fmt.number(r.top1.denominator, 1)})
                    </div>
                  ))}
                </td>
                <td>{v.gate_passed === null ? '-' : v.gate_passed ? t('eval.gate_passed') : t('eval.gate_failed')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** 运行前显示成本估算（DESIGN §12.2）。 */
function EstimatePanel({ suite, routes }: { suite: string; routes: string[] }) {
  const { t, fmt } = useI18n();
  const [runs, setRuns] = useState('3');
  const est = useMutation({
    mutationFn: async () =>
      ok<Estimate>(
        'estimateEval',
        await hub.POST('/v1/eval/estimate', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: { suite, routes, runs_per_case: Number(runs) },
        }),
      ),
  });
  return (
    <Panel title={t('eval.estimate')} meta={t('eval.estimate_note')}>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          est.mutate();
        }}
      >
        <TextField
          label={t('eval.runs_per_case')}
          inputMode="numeric"
          pattern="[1-9]|10"
          value={runs}
          onChange={(e) => setRuns(e.currentTarget.value)}
        />
        <Button type="submit" busy={est.isPending} disabled={routes.length === 0}>
          {t('eval.do_estimate', { n: routes.length })}
        </Button>
      </form>
      {est.data && (
        <p role="status">
          {t('eval.estimate_v', {
            cases: est.data.cases,
            calls: est.data.calls,
            tokens: fmt.number(est.data.input_tokens, 0),
            cost: fmt.money(est.data.cost, est.data.currency),
          })}
        </p>
      )}
      {est.error && <ErrorBox title={t('eval.estimate_failed')} error={est.error} />}
    </Panel>
  );
}

export function EvalPage({ mode, reportId }: { mode: EvalMode; reportId?: string }) {
  const { t, fmt } = useI18n();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['eval', 'reports', mode],
    queryFn: async () =>
      ok<EvalReport[]>(
        'listEvalReports',
        await hub.GET('/v1/eval/reports', { params: { query: { mode, limit: 50 } } }),
      ),
  });
  const chosen = reportId ?? list.data?.[0]?.report_id;
  const report = list.data?.find((r) => r.report_id === chosen);
  return (
    <div className={styles.page}>
      <PageHeader
        title={t('eval.title')}
        actions={
          <Segmented
            label={t('eval.mode_label')}
            value={mode}
            onChange={(m) =>
              void navigate({ to: '/eval', search: (p: { cluster?: string }) => ({ cluster: p.cluster, mode: m }) })
            }
            options={[
              { value: 'snapshot', label: t('eval.mode.snapshot') },
              { value: 'reconstructed', label: t('eval.mode.reconstructed') },
            ]}
          />
        }
      />
      <p className={styles.dim}>{t(`eval.mode_note.${mode}`)}</p>
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox title={t('eval.failed')} error={list.error} />
      ) : list.data.length === 0 ? (
        <EmptyState kind="none" title={t('eval.empty_title')} because={t(`eval.empty.${mode}`)} />
      ) : (
        <>
          <div className={styles.filterSelect}>
            <SelectField
              label={t('eval.report')}
              value={chosen ?? ''}
              onChange={(e) =>
                void navigate({
                  to: '/eval',
                  search: (p: { cluster?: string }) => ({ cluster: p.cluster, mode, report: e.currentTarget.value }),
                })
              }
              options={list.data.map((r) => ({
                value: r.report_id,
                label: `${r.case_set} · ${fmt.dateTime(r.created_at)}`,
              }))}
            />
          </div>
          {report ? (
            <>
              <Scorecard report={report} />
              <TrendPanel suite={report.case_set} mode={mode} />
              <EstimatePanel suite={report.case_set} routes={[...new Set(report.rows.map((r) => r.route_id))]} />
              <CaseBrowser suite={report.case_set} mode={mode} />
            </>
          ) : (
            <EmptyState kind="filtered" title={t('eval.not_found_title')} because={t('eval.not_found')} />
          )}
        </>
      )}
    </div>
  );
}
