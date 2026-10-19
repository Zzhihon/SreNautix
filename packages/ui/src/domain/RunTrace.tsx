// 研判运行明细（DESIGN §12.2）：状态机瀑布图、每次模型调用（路由、模型、提示词版本、token、成本、
// 延迟、回退原因）、脱敏提示词与命中次数、工具调用（查询、生效上限、返回量、是否截断）、预算账本、
// 出境清单。原始提示词只对 auditor 与 admin 可见，由宿主通过 rawPromptHref 决定是否给出入口。

import { useMemo, type ReactNode } from 'react';
import type { LlmCall, ResearchManifest, ResearchRun, ToolCall } from '../contract';
import { useI18n } from '../i18n';
import { KeyValue, Mono, Panel } from '../primitives/basic';
import { DataTable, type ColumnDef } from '../primitives/DataTable';
import { EmptyState } from '../primitives/EmptyState';
import { Tip } from '../primitives/overlays';
import { Status } from '../primitives/Status';
import styles from './RunTrace.module.css';

export type BarKind = 'step' | 'llm' | 'tool';

export interface Bar {
  id: string;
  kind: BarKind;
  label: string;
  start: number;
  end: number;
  detail: string;
}

/** 瀑布图的条：状态机步骤、模型调用与工具调用，按开始时间排序。 */
export function waterfall(run: ResearchRun, now: number, stepLabel: (state: string) => string): Bar[] {
  const bars: Bar[] = [];
  for (const s of run.steps) {
    const start = Date.parse(s.started_at);
    const end = s.finished_at ? Date.parse(s.finished_at) : now;
    bars.push({ id: `s-${s.state}-${start}`, kind: 'step', start, end, label: stepLabel(s.state), detail: '' });
  }
  for (const c of run.llm_calls) {
    const start = Date.parse(c.at);
    bars.push({
      id: `l-${c.seq}`,
      kind: 'llm',
      start,
      end: start + c.duration_ms,
      label: `${c.phase} · ${c.route_id}`,
      detail: `${c.model} · ${c.outcome}`,
    });
  }
  for (const c of run.tool_calls) {
    const start = Date.parse(c.at);
    bars.push({
      id: `t-${c.seq}`,
      kind: 'tool',
      start,
      end: start + c.duration_ms,
      label: c.tool,
      detail: c.error ?? '',
    });
  }
  // 同一时刻开始时，状态机步骤排在它内部的模型调用和工具调用之前
  const rank: Record<BarKind, number> = { step: 0, llm: 1, tool: 2 };
  return bars.sort((a, b) => a.start - b.start || rank[a.kind] - rank[b.kind] || a.end - b.end);
}

function Waterfall({ run, now }: { run: ResearchRun; now: number }) {
  const { t, fmt } = useI18n();
  const bars = useMemo(() => waterfall(run, now, (state) => t(`research.state.${state}`)), [run, now, t]);
  if (!bars.length) {
    return <EmptyState kind="none" title={t('run.no_steps_title')} because={t('run.no_steps_because')} />;
  }
  const t0 = Date.parse(run.started_at);
  const t1 = Math.max(run.finished_at ? Date.parse(run.finished_at) : now, ...bars.map((b) => b.end));
  const span = Math.max(1, t1 - t0);
  return (
    <div className={styles.waterfall} role="table" aria-label={t('run.waterfall')}>
      {bars.map((b) => (
        <div key={b.id} className={styles.wrow} role="row">
          <span className={styles.wlabel} role="rowheader">
            {b.label}
          </span>
          <span className={styles.wtrack} role="cell">
            <Tip text={`${b.label}\n${fmt.duration(b.end - b.start)} ${b.detail}`}>
              <span
                className={styles.wbar}
                data-kind={b.kind}
                tabIndex={0}
                style={{
                  left: `${((b.start - t0) / span) * 100}%`,
                  width: `max(2px, ${((b.end - b.start) / span) * 100}%)`,
                }}
              />
            </Tip>
          </span>
          <span className={styles.wdur} role="cell">
            {fmt.duration(b.end - b.start)}
          </span>
        </div>
      ))}
      <div className={styles.legend}>
        <span data-kind="step">{t('run.kind.step')}</span>
        <span data-kind="llm">{t('run.kind.llm')}</span>
        <span data-kind="tool">{t('run.kind.tool')}</span>
      </div>
    </div>
  );
}

export function RunTrace({
  run,
  manifest,
  now,
  promptHref,
  actions,
}: {
  run: ResearchRun;
  manifest: ResearchManifest | null;
  now: number;
  /** 某次模型调用的脱敏提示词页面；raw=true 时为原始提示词（只对 auditor、admin 给出）。 */
  promptHref: (seq: number, raw: boolean) => string | null;
  /** 页面级操作，例如"加入评测用例"。 */
  actions?: ReactNode;
}) {
  const { t, fmt } = useI18n();
  const llmCols = useMemo<ColumnDef<LlmCall>[]>(
    () => [
      { header: '#', accessorKey: 'seq' },
      { header: t('run.col.phase'), accessorKey: 'phase' },
      {
        header: t('run.col.route'),
        cell: ({ row }) => (
          <span>
            {row.original.route_id}
            <br />
            <Mono>{row.original.model}</Mono>
          </span>
        ),
      },
      {
        header: t('run.col.prompt'),
        cell: ({ row }) => <Mono title={row.original.prompt_hash}>{row.original.prompt_hash.slice(7, 19)}</Mono>,
      },
      {
        header: t('run.col.tokens'),
        cell: ({ row }) =>
          t('run.tokens', {
            in: row.original.usage.input_tokens,
            cached: row.original.usage.cached_input_tokens,
            out: row.original.usage.output_tokens,
            reasoning: row.original.usage.reasoning_tokens,
          }),
      },
      { header: t('run.col.cost'), cell: ({ row }) => fmt.money(row.original.cost, run.budget.currency) },
      { header: t('run.col.latency'), cell: ({ row }) => fmt.duration(row.original.duration_ms) },
      {
        header: t('run.col.outcome'),
        cell: ({ row }) => (
          <span>
            {t(`run.outcome.${row.original.outcome}`)}
            {row.original.repair_step && (
              <span className={styles.dim}> · {t(`run.repair.${row.original.repair_step}`)}</span>
            )}
          </span>
        ),
      },
      {
        header: t('run.col.redaction'),
        cell: ({ row }) => {
          const red = promptHref(row.original.seq, false);
          const raw = promptHref(row.original.seq, true);
          return (
            <span>
              {t('run.redaction_hits', { n: row.original.redaction_hits })}
              {red && (
                <>
                  {' · '}
                  <a href={red}>{t('run.redacted_prompt')}</a>
                </>
              )}
              {raw && (
                <>
                  {' · '}
                  <a href={raw}>{t('run.raw_prompt')}</a>
                </>
              )}
            </span>
          );
        },
      },
    ],
    [t, fmt, run.budget.currency, promptHref],
  );
  const toolCols = useMemo<ColumnDef<ToolCall>[]>(
    () => [
      { header: '#', accessorKey: 'seq' },
      { header: t('run.col.tool'), accessorKey: 'tool' },
      { header: t('run.col.args'), cell: ({ row }) => <Mono>{JSON.stringify(row.original.arguments)}</Mono> },
      {
        header: t('run.col.window'),
        cell: ({ row }) =>
          row.original.window ? `${fmt.clock(row.original.window.from)}–${fmt.clock(row.original.window.to)}` : '-',
      },
      { header: t('run.col.limit'), cell: ({ row }) => row.original.limit_applied ?? t('common.none') },
      {
        header: t('run.col.result'),
        cell: ({ row }) => (
          <span>
            {t('run.result_size', { n: row.original.result_size })}
            {row.original.truncated && <span className={styles.warn}> · {t('evidence.truncated')}</span>}
            {row.original.error && <span className={styles.bad}> · {row.original.error}</span>}
          </span>
        ),
      },
      { header: t('run.col.card'), cell: ({ row }) => row.original.result_ref ?? '-' },
      { header: t('run.col.latency'), cell: ({ row }) => fmt.duration(row.original.duration_ms) },
    ],
    [t, fmt],
  );
  const b = run.budget;
  return (
    <div className={styles.wrap}>
      <div className={styles.summary}>
        <Status domain="research" value={run.state} />
        <span>{t('run.reason', { reason: t(`research.reason.${run.reason}`) })}</span>
        <span>
          {t('run.total', {
            d: fmt.duration((run.finished_at ? Date.parse(run.finished_at) : now) - Date.parse(run.started_at)),
          })}
        </span>
        {run.stop_reason && <span>{t('run.stop', { reason: t(`run.stop_reason.${run.stop_reason}`) })}</span>}
        {actions}
      </div>
      {run.error && (
        <p className={styles.bad} role="alert">
          {run.error.kind}: {run.error.message}
        </p>
      )}
      <Panel title={t('run.waterfall')}>
        <Waterfall run={run} now={now} />
      </Panel>
      <Panel title={t('run.llm_calls')} meta={t('run.count', { n: run.llm_calls.length })}>
        <DataTable
          data={run.llm_calls}
          columns={llmCols}
          getRowId={(r) => String(r.seq)}
          label={t('run.llm_calls')}
          empty={
            <EmptyState
              kind="none"
              title={t('run.no_llm_title')}
              because={t('run.no_llm_because', { state: run.state })}
            />
          }
        />
      </Panel>
      <Panel title={t('run.tool_calls')} meta={t('run.count', { n: run.tool_calls.length })}>
        <DataTable
          data={run.tool_calls}
          columns={toolCols}
          getRowId={(r) => String(r.seq)}
          label={t('run.tool_calls')}
          empty={<EmptyState kind="none" title={t('run.no_tools_title')} because={t('run.no_tools_because')} />}
        />
      </Panel>
      <div className={styles.grid}>
        <Panel title={t('run.budget')}>
          <KeyValue
            items={[
              { k: t('run.b.estimated'), v: fmt.number(b.estimated_input_tokens, 0) },
              {
                k: t('run.b.actual'),
                v: t('run.b.actual_v', { in: fmt.number(b.input_tokens, 0), out: fmt.number(b.output_tokens, 0) }),
              },
              { k: t('run.b.cost'), v: fmt.money(b.cost, b.currency) },
              { k: t('run.b.stop'), v: run.stop_reason ? t(`run.stop_reason.${run.stop_reason}`) : t('common.none') },
            ]}
          />
        </Panel>
        <Panel title={t('run.egress')}>
          {!manifest ? (
            <EmptyState
              kind="not_applicable"
              title={t('run.no_manifest_title')}
              because={t('run.no_manifest_because')}
            />
          ) : manifest.egress.length === 0 ? (
            <EmptyState kind="none" title={t('run.no_egress_title')} because={t('run.no_egress_because')} />
          ) : (
            <ul className={styles.egress}>
              {manifest.egress.map((e, i) => (
                <li key={i}>
                  <strong>{e.route_id}</strong>
                  <span>{e.in_domain ? t('run.in_domain') : t('run.out_of_domain')}</span>
                  <span>{e.categories.map((c) => t(`run.category.${c}`)).join('、')}</span>
                  <span>{t('run.egress_bytes', { bytes: fmt.number(e.bytes, 0), hits: e.redaction_hits })}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {manifest && (
          <Panel title={t('run.manifest')}>
            <KeyValue
              items={[
                { k: 'code_sha', v: <Mono>{manifest.code_sha.slice(0, 12)}</Mono> },
                { k: 'pack.lock', v: <Mono>{manifest.pack_lock.slice(7, 19)}</Mono> },
                { k: t('run.m.contract'), v: manifest.contract_version },
                { k: t('run.m.topology'), v: manifest.topology_version },
                { k: t('run.m.redaction'), v: manifest.redaction_version },
                {
                  k: t('run.m.routes'),
                  v: manifest.routes
                    .map((r) => `${r.phase}: ${r.route_id} (${r.model}, ${r.dialect_profile})`)
                    .join('\n'),
                },
              ]}
            />
          </Panel>
        )}
      </div>
    </div>
  );
}
