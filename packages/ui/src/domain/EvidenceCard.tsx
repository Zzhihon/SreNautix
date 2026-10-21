// 证据卡（DESIGN §6.1、§12.2）。默认显示研判当时的快照；"实时重跑"的结果并排显示，并标注
// "非模型所见"。卡片里的日志、标签值等原文一律作为文本显示，放在注明来源的引用块里（不变量 9）。

import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EvidenceRef, EvidenceResult } from '../contract';
import { useRerunEvidence, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Button, ErrorBox, Mono } from '../primitives/basic';
import { Chart } from '../primitives/Chart';
import { EmptyState } from '../primitives/EmptyState';
import { Collapsible } from '../primitives/overlays';
import { Status, StatusPill } from '../primitives/Status';
import { countEvidence, sortEvidence } from './model';
import styles from './EvidenceCard.module.css';

/**
 * 页内锚点：card:3 → card-3。假设与提议里的引用据此跳转；通知与 issue 中证据卡的链接是
 * /incidents/<id>?tab=evidence#card-<n>（ADR 0125）。
 */
export function evidenceAnchor(ref: string): string {
  return ref.replace(':', '-');
}

export function evidenceTitle(r: EvidenceResult, locale: string): string {
  const t = r.title as Record<string, string | undefined>;
  return t[locale] ?? t['zh-CN'] ?? t['en'] ?? r.card_id;
}

function entityText(r: EvidenceResult): string | null {
  if (!r.entity) {
    return null;
  }
  const e = r.entity;
  return e.namespace ? `${e.kind} ${e.namespace}/${e.name}` : `${e.kind} ${e.name}`;
}

const VERDICT_TONE = { abnormal: 'bad', normal: 'ok', undeterminable: 'nodata', capability_missing: 'nodata' } as const;

/** 一侧的结果：判定、理由、主值、图、表。 */
function Side({ r, live }: { r: EvidenceResult; live: boolean }) {
  const { t, fmt } = useI18n();
  return (
    <div className={styles.side} data-live={live ? '' : undefined}>
      <div className={styles.sideHead}>
        {live ? (
          <StatusPill tone="model" icon={EyeOff}>
            {t('evidence.live_not_model')}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral" icon={Eye}>
            {t('evidence.snapshot_model_saw')}
          </StatusPill>
        )}
        <span className={styles.when}>{t('evidence.evaluated_at', { at: fmt.dateTime(r.evaluated_at) })}</span>
      </div>
      <div className={styles.verdictLine}>
        <Status domain="verdict" value={r.display_state} />
        {r.value !== null && <span className={styles.value}>{r.value}</span>}
      </div>
      <p className={styles.reason}>
        <span className={styles.reasonKind}>{t(`evidence.reason.${r.reason.kind}`)}</span>
        {r.reason.text}
      </p>
      {r.series.map((s) => (
        <Chart
          key={s.ref}
          series={{ t: s.points.map((p) => p[0]), v: s.points.map((p) => p[1]) }}
          tone={VERDICT_TONE[r.display_state]}
          threshold={r.threshold}
          label={t('evidence.chart_label', { ref: s.ref, n: s.points.length })}
        />
      ))}
      {r.table && r.table.rows.length > 0 && (
        <figure className={styles.quote}>
          <figcaption>
            {t('evidence.table_source', { source: r.queries.map((q) => q.integration).join(', ') })}
          </figcaption>
          <table className={styles.table}>
            <thead>
              <tr>
                {r.table.head.map((h, i) => (
                  <th key={i} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}
    </div>
  );
}

export function EvidenceCard({ r, live }: { r: EvidenceResult; live?: EvidenceResult }) {
  const { t, locale, fmt } = useI18n();
  const entity = entityText(r);
  const changed = live !== undefined && live.display_state !== r.display_state;
  return (
    <article
      className={styles.card}
      id={evidenceAnchor(r.ref)}
      data-state={r.display_state}
      aria-label={evidenceTitle(r, locale)}
    >
      <header className={styles.head}>
        <Mono className={styles.ref}>{r.ref}</Mono>
        <h3 className={styles.title}>{evidenceTitle(r, locale)}</h3>
        {entity && <span className={styles.entity}>{entity}</span>}
        <span className={styles.window}>
          {t('evidence.window', { from: fmt.clock(r.window.from), to: fmt.clock(r.window.to) })}
        </span>
        <StatusPill tone={r.egress === 'allow' ? 'neutral' : 'info'} icon={r.egress === 'never' ? EyeOff : Eye}>
          {t(`evidence.egress.${r.egress}`)}
        </StatusPill>
      </header>
      {changed && (
        <div className={styles.changed} role="status">
          {t('evidence.changed_since', {
            then: t(`status.verdict.${r.display_state}`),
            now: t(`status.verdict.${live.display_state}`),
          })}
        </div>
      )}
      <div className={live ? styles.pair : undefined}>
        <Side r={r} live={false} />
        {live && <Side r={live} live />}
      </div>
      <Collapsible summary={t('evidence.queries', { n: r.queries.length })}>
        <ul className={styles.queries}>
          {r.queries.map((q) => (
            <li key={q.name}>
              <div className={styles.qhead}>
                <strong>{q.name}</strong>
                <span>{q.integration}</span>
                <span>{q.capability}</span>
                <span>{t('evidence.samples', { n: q.sample_count })}</span>
                {q.truncated && <span className={styles.warn}>{t('evidence.truncated')}</span>}
                <span>{fmt.duration(q.duration_ms)}</span>
              </div>
              <Mono className={styles.query}>{q.query}</Mono>
              {q.error && <div className={styles.qerr}>{q.error}</div>}
            </li>
          ))}
        </ul>
      </Collapsible>
    </article>
  );
}

/**
 * 证据标签页：按"异常、无法判定、正常"排序；有重跑权限时可以把同一批卡实时重跑一次，
 * 结果与快照并排。
 */
export function EvidenceList({
  incidentRef,
  runId,
  results,
}: {
  incidentRef: string;
  /** 结果所属的研判；为 null 时是阶段 A 报告的卡。 */
  runId: string | null;
  results: readonly EvidenceResult[];
}) {
  const { t } = useI18n();
  const { caps } = useUiEnv();
  const rerun = useRerunEvidence(incidentRef);
  const [live, setLive] = useState<Map<string, EvidenceResult> | null>(null);
  const sorted = useMemo(() => sortEvidence(results), [results]);
  const c = countEvidence(results);
  // 从通知或 issue 打开带 #card-<n> 的链接时，卡片在数据加载之后才出现：加载后滚动到这张卡
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    }
  }, [sorted]);
  if (!results.length) {
    return <EmptyState kind="none" title={t('evidence.empty_title')} because={t('evidence.empty_because')} />;
  }
  return (
    <div className={styles.list}>
      <div className={styles.toolbar}>
        <span>
          {t('evidence.counts', { abnormal: c.abnormal, undeterminable: c.undeterminable, normal: c.normal })}
        </span>
        {caps.rerun ? (
          <Button
            size="sm"
            busy={rerun.isPending}
            onClick={() =>
              rerun.mutate(
                { run_id: runId, refs: results.map((r) => r.ref as EvidenceRef), window_to: new Date().toISOString() },
                { onSuccess: (rows) => setLive(new Map(rows.map((r) => [r.ref, r]))) },
              )
            }
          >
            <RefreshCw aria-hidden="true" width={14} height={14} />
            {live ? t('evidence.rerun_again') : t('evidence.rerun')}
          </Button>
        ) : (
          <span className={styles.dim}>{t('evidence.rerun_forbidden')}</span>
        )}
      </div>
      {rerun.error && <ErrorBox title={t('evidence.rerun_failed')} error={rerun.error} />}
      {sorted.map((r) => (
        <EvidenceCard key={r.ref} r={r} live={live?.get(r.ref)} />
      ))}
    </div>
  );
}
