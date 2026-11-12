// 证据卡与证据标签页（DESIGN §6.1、§12.2）。标签页先给出证据链的概要（关键时刻、结论和它依据的卡、其他假设的去向），
// 再把卡按它们在论证里的位置分组；与结论无关的正常卡、平时也成立的异常收成一行，点开才展开。
// 一张卡回答四个问题：判定是什么（主值对阈值、命中的条件）、和平时比怎样（证据基线）、随时间怎样变化（按查询归并的
// 图，带阈值、异常时段与告警触发时刻）、被哪个假设引用。默认显示研判当时的快照；"实时重跑"的结果并排显示，并标注
// "非模型所见"。卡片里的日志、标签值等原文一律作为文本显示，放在注明来源的引用块里（不变量 9）。

import { Bot, ChevronRight, CircleHelp, Eye, EyeOff, RefreshCw, Repeat, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EvidenceRef, EvidenceResult, Incident, ResearchOutput } from '../contract';
import { useRerunEvidence, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Button, ErrorBox, Mono } from '../primitives/basic';
import { Chart, type ChartBand, type ChartMark } from '../primitives/Chart';
import { EmptyState } from '../primitives/EmptyState';
import { Collapsible } from '../primitives/overlays';
import { Status, StatusIcon, StatusPill } from '../primitives/Status';
import {
  buildEvidenceChain,
  cardCharts,
  expandedByDefault,
  formatValue,
  keyMoments,
  parseOffset,
  type ChainGroupId,
  type EvidenceRole,
  type KeyMoment,
} from './evidence-chain';
import { EvidenceNavProvider, EvidenceRefChip, evidenceAnchor, evidenceTitle, type EvidenceNav } from './evidence-nav';
import { CONSISTENCY_KEYS } from './HypothesisList';
import { componentLabel, countEvidence } from './model';
import { useComponentNames } from './names';
import styles from './EvidenceCard.module.css';

/** 重跑接口一次最多接受的卡数。 */
const RERUN_LIMIT = 50;
const SYNC_KEY = 'srenautix-evidence';

function entityText(r: EvidenceResult): string | null {
  if (!r.entity) {
    return null;
  }
  const e = r.entity;
  return e.namespace ? `${e.kind} ${e.namespace}/${e.name}` : `${e.kind} ${e.name}`;
}

const VERDICT_TONE = { abnormal: 'bad', normal: 'ok', undeterminable: 'nodata', capability_missing: 'nodata' } as const;
const NOVELTY = {
  novel: { tone: 'warn', icon: TrendingUp },
  routine: { tone: 'neutral', icon: Repeat },
  unknown: { tone: 'nodata', icon: CircleHelp },
} as const;

/** 证据基线：这次的主值和事件之前同样长度的几个时段相比。 */
function Novelty({ r }: { r: EvidenceResult }) {
  const { t, fmt } = useI18n();
  const n = r.novelty;
  if (!n) {
    return null;
  }
  const def = NOVELTY[n.status];
  const past = [...n.comparisons].reverse();
  return (
    <div className={styles.novelty}>
      <div className={styles.noveltyHead}>
        <StatusPill tone={def.tone} icon={def.icon}>
          {t(`evidence.novelty.${n.status}`)}
        </StatusPill>
        <span>{n.reason}</span>
      </div>
      {past.length > 0 && (
        <ol className={styles.compare} aria-label={t('evidence.compare')}>
          {past.map((c) => {
            const o = parseOffset(c.offset);
            return (
              <li key={c.offset}>
                <span className={styles.compareWhen}>{o ? t(`evidence.offset.${o.unit}`, { n: o.n }) : c.offset}</span>
                <span className={styles.compareValue}>
                  <StatusIcon domain="verdict" value={c.verdict} />
                  {c.value === null ? t(`status.verdict.${c.verdict}`) : formatValue(c.value, r.unit, fmt)}
                </span>
              </li>
            );
          })}
          <li data-now="">
            <span className={styles.compareWhen}>{t('evidence.compare_now')}</span>
            <span className={styles.compareValue}>
              <StatusIcon domain="verdict" value={r.display_state} />
              {n.value === null ? t(`status.verdict.${r.display_state}`) : formatValue(n.value, r.unit, fmt)}
            </span>
          </li>
        </ol>
      )}
    </div>
  );
}

/** 一侧的结果：主值、理由、与平时的对比、图、表。 */
function Side({
  r,
  live,
  paired,
  marks,
}: {
  r: EvidenceResult;
  live: boolean;
  paired: boolean;
  marks: readonly ChartMark[] | undefined;
}) {
  const { t, fmt } = useI18n();
  const charts = useMemo(() => cardCharts(r), [r]);
  const range = useMemo(
    () => [Date.parse(r.window.from) / 1000, Date.parse(r.window.to) / 1000] as const,
    [r.window.from, r.window.to],
  );
  const band = useMemo<ChartBand | null>(
    () =>
      r.display_state === 'abnormal' && r.anomaly_started_at
        ? { from: Date.parse(r.anomaly_started_at) / 1000, to: null, tone: 'bad' }
        : null,
    [r.display_state, r.anomaly_started_at],
  );
  const inWindow = useMemo(() => marks?.filter((m) => m.t >= range[0] && m.t <= range[1]), [marks, range]);
  const unitFormat = useCallback((v: number) => formatValue(v, r.unit, fmt), [r.unit, fmt]);
  const scaledChart = charts.some((c) => c.scaled);
  return (
    <div className={styles.side} data-live={live ? '' : undefined}>
      {paired && (
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
      )}
      <div className={styles.lead}>
        {paired && <Status domain="verdict" value={r.display_state} />}
        {r.value !== null && <span className={styles.value}>{r.value}</span>}
        {r.threshold !== null && (
          <span className={styles.bound}>{t('evidence.threshold', { v: formatValue(r.threshold, r.unit, fmt) })}</span>
        )}
        {r.baseline !== undefined && r.baseline !== null && (
          <span className={styles.bound}>{t('evidence.baseline', { v: formatValue(r.baseline, r.unit, fmt) })}</span>
        )}
      </div>
      <p className={styles.reason}>
        {r.reason.kind === 'model_judged' ? (
          <StatusPill tone="model" icon={Bot}>
            {t('evidence.reason.model_judged')}
          </StatusPill>
        ) : (
          r.reason.kind !== 'rule' && <span className={styles.reasonKind}>{t(`evidence.reason.${r.reason.kind}`)}</span>
        )}
        {r.reason.text}
      </p>
      <Novelty r={r} />
      {charts.map((c) => (
        <div key={c.ref} className={styles.plot}>
          <div className={styles.plotHead}>
            <Mono>{c.ref}</Mono>
            {c.lines.length > 1 && <span>{t('evidence.series_count', { n: c.lines.length + c.folded })}</span>}
            {c.folded > 0 && <span>{t('evidence.series_folded', { shown: c.lines.length })}</span>}
          </div>
          <Chart
            series={c.lines}
            tone={VERDICT_TONE[r.display_state]}
            threshold={c.scaled ? r.threshold : null}
            format={c.scaled ? unitFormat : undefined}
            band={band}
            marks={inWindow}
            range={range}
            syncKey={SYNC_KEY}
            height={132}
            axes
            label={t('evidence.chart_label', { ref: c.ref, n: c.lines[0]?.t.length ?? 0 })}
          />
        </div>
      ))}
      {charts.length > 0 && (band || (inWindow?.length ?? 0) > 0 || (scaledChart && r.threshold !== null)) && (
        <ul className={styles.plotKey}>
          {band && (
            <li>
              <span className={styles.keyBand} />
              {t('evidence.key_onset', { at: fmt.clock(band.from * 1000, range[0] * 1000) })}
            </li>
          )}
          {inWindow?.map((m) => (
            <li key={`${m.t}:${m.label}`}>
              <span className={styles.keyMark} data-tone={m.tone} />
              {m.label} {fmt.clock(m.t * 1000, range[0] * 1000)}
            </li>
          ))}
          {scaledChart && r.threshold !== null && (
            <li>
              <span className={styles.keyThreshold} />
              {t('evidence.threshold', { v: formatValue(r.threshold, r.unit, fmt) })}
            </li>
          )}
        </ul>
      )}
      {r.table && r.table.rows.length > 0 && (
        <figure className={styles.quote}>
          <figcaption>
            {t('evidence.table_source', { source: [...new Set(r.queries.map((q) => q.integration))].join(', ') })}
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

/** 这张卡被哪些假设引用。 */
function Roles({ roles }: { roles: readonly EvidenceRole[] }) {
  const { t } = useI18n();
  const names = useComponentNames();
  return (
    <ul className={styles.roles}>
      {roles.map((x) => (
        <li key={x.hypothesis.id} data-kind={x.kind} data-leader={x.leader ? '' : undefined}>
          <span className={styles.roleKind}>{t(`evidence.role.${x.kind}`)}</span>
          <Mono>{x.hypothesis.id}</Mono>
          <span>{componentLabel(x.hypothesis.root_component, names).name}</span>
          <span className={styles.roleStatus}>
            {x.leader ? t('hypothesis.leader') : t(`status.hypothesis.${x.hypothesis.status}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 判定依据：求值过的条件、观测值与生效的参数。 */
function Basis({ r }: { r: EvidenceResult }) {
  const { t } = useI18n();
  const conditions = r.conditions ?? [];
  const pairs = (o: Record<string, unknown> | undefined) => Object.entries(o ?? {}).filter(([, v]) => v !== null);
  const observed = pairs(r.observations);
  const params = pairs(r.params);
  if (!conditions.length && !observed.length && !params.length) {
    return null;
  }
  return (
    <Collapsible summary={t('evidence.basis', { n: conditions.length })}>
      <div className={styles.basis}>
        {conditions.length > 0 && (
          <ul className={styles.conditions}>
            {conditions.map((c, i) => (
              <li key={i} data-outcome={c.outcome}>
                <span className={styles.outcome}>{t(`evidence.condition_outcome.${c.outcome}`)}</span>
                <span className={styles.dim}>{t(`evidence.condition_kind.${c.kind}`)}</span>
                {c.say && <span>{c.say}</span>}
                <Mono className={styles.cel}>{c.cel}</Mono>
              </li>
            ))}
          </ul>
        )}
        {[[t('evidence.observations'), observed] as const, [t('evidence.params'), params] as const].map(
          ([name, list]) =>
            list.length > 0 && (
              <dl key={name} className={styles.kv}>
                <dt>{name}</dt>
                {list.map(([k, v]) => (
                  <dd key={k}>
                    <Mono>{k}</Mono> {String(v)}
                  </dd>
                ))}
              </dl>
            ),
        )}
      </div>
    </Collapsible>
  );
}

export function EvidenceCard({
  r,
  live,
  roles,
  marks,
  open = true,
  onToggle,
}: {
  r: EvidenceResult;
  live?: EvidenceResult;
  roles?: readonly EvidenceRole[];
  /** 画在每张图上的时刻（告警触发）。 */
  marks?: readonly ChartMark[];
  /** 收起时只有一行：判定、标题、实体、主值与理由。 */
  open?: boolean;
  /** 给出时标题行可以点击展开与收起。 */
  onToggle?: () => void;
}) {
  const { t, locale, fmt } = useI18n();
  const entity = entityText(r);
  const title = evidenceTitle(r, locale);
  const changed = live !== undefined && live.display_state !== r.display_state;
  return (
    <article
      className={styles.card}
      id={evidenceAnchor(r.ref)}
      data-state={r.display_state}
      data-open={open ? '' : undefined}
      aria-label={title}
    >
      <header className={styles.head} data-clickable={onToggle ? '' : undefined} onClick={onToggle}>
        <StatusIcon domain="verdict" value={r.display_state} />
        <h3 className={styles.title}>{title}</h3>
        {entity && <span className={styles.entity}>{entity}</span>}
        {!open && (
          <span className={styles.brief}>
            {r.value !== null && <strong>{r.value}</strong>}
            <span>{r.reason.text}</span>
          </span>
        )}
        <Mono className={styles.ref}>{r.ref}</Mono>
        {onToggle && (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-label={t(open ? 'evidence.collapse' : 'evidence.expand', { title })}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </header>
      {open && (
        <div className={styles.body}>
          {roles && roles.length > 0 && <Roles roles={roles} />}
          {changed && (
            <div className={styles.changed} role="status">
              {t('evidence.changed_since', {
                then: t(`status.verdict.${r.display_state}`),
                now: t(`status.verdict.${live.display_state}`),
              })}
            </div>
          )}
          <div className={live ? styles.pair : undefined}>
            <Side r={r} live={false} paired={live !== undefined} marks={marks} />
            {live && <Side r={live} live paired marks={marks} />}
          </div>
          <Basis r={r} />
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
          <footer className={styles.meta}>
            <span>{t('evidence.window', { from: fmt.clock(r.window.from), to: fmt.clock(r.window.to) })}</span>
            {!live && <span>{t('evidence.evaluated_at', { at: fmt.dateTime(r.evaluated_at) })}</span>}
            <StatusPill tone={r.egress === 'allow' ? 'neutral' : 'info'} icon={r.egress === 'never' ? EyeOff : Eye}>
              {t(`evidence.egress.${r.egress}`)}
            </StatusPill>
          </footer>
        </div>
      )}
    </article>
  );
}

function Moments({ moments }: { moments: readonly KeyMoment[] }) {
  const { t, fmt } = useI18n();
  const day0 = moments[0]?.at;
  return (
    <ol className={styles.moments} aria-label={t('evidence.moments')}>
      {moments.map((m) => (
        <li key={m.kind} data-kind={m.kind}>
          <time dateTime={new Date(m.at).toISOString()}>{fmt.clock(m.at, m === moments[0] ? undefined : day0)}</time>
          <span className={styles.momentLabel}>{t(`evidence.moment.${m.kind}`)}</span>
          {m.card && <EvidenceRefChip refId={m.card.ref} />}
        </li>
      ))}
    </ol>
  );
}

/** 证据链概要：关键时刻；结论、它采用的假设与依据的卡；其他假设的去向。 */
function ChainSummary({
  output,
  moments,
  onShowHypotheses,
}: {
  output: ResearchOutput | null;
  moments: readonly KeyMoment[];
  onShowHypotheses?: () => void;
}) {
  const { t } = useI18n();
  const names = useComponentNames();
  const leader = output?.hypotheses.find((h) => h.id === output.conclusion.hypothesis_id) ?? null;
  const rivals = output?.hypotheses.filter((h) => h !== leader) ?? [];
  const unmet = output ? CONSISTENCY_KEYS.filter((k) => !output.conclusion.consistency[k]) : [];
  const checks = output && leader ? output.next_checks.filter((c) => c.hypothesis_id === leader.id) : [];
  const cited = new Set([...(leader?.supporting ?? []), ...(leader?.refuting ?? [])]);
  const checked = checks.flatMap((c) => (c.result_ref && !cited.has(c.result_ref) ? [c.result_ref] : []));
  const row = (label: string, refs: readonly string[]): ReactNode =>
    refs.length > 0 && (
      <div className={styles.claimRow}>
        <span className={styles.claimLabel}>{label}</span>
        <span className={styles.chips}>
          {refs.map((x) => (
            <EvidenceRefChip key={x} refId={x} />
          ))}
        </span>
      </div>
    );
  return (
    <section className={styles.summary} aria-label={t('evidence.chain')}>
      <Moments moments={moments} />
      {output && (
        <div className={styles.claim}>
          <div className={styles.claimHead}>
            <Status domain="conclusion" value={output.conclusion.level} />
            {leader ? (
              <>
                <strong>{t('hypothesis.root', { root: componentLabel(leader.root_component, names).name })}</strong>
                <span className={styles.dim}>{componentLabel(leader.root_component, names).sub}</span>
              </>
            ) : (
              <span>{output.conclusion.undetermined_reason ?? t('evidence.no_leader')}</span>
            )}
          </div>
          {leader && (
            <>
              <p className={styles.mechanism}>
                <StatusPill tone="model" icon={Bot}>
                  {t('common.model_generated')}
                </StatusPill>{' '}
                {leader.mechanism}
              </p>
              {row(t('hypothesis.supporting'), leader.supporting)}
              {row(t('evidence.role.refutes'), leader.refuting)}
              {row(t('evidence.role.checked'), checked)}
            </>
          )}
          {unmet.length > 0 && (
            <div className={styles.claimRow}>
              <span className={styles.claimLabel}>{t('evidence.unmet')}</span>
              <span className={styles.unmet}>{unmet.map((k) => t(`hypothesis.consistency.${k}`)).join(' · ')}</span>
            </div>
          )}
          {rivals.length > 0 && (
            <div className={styles.claimRow}>
              <span className={styles.claimLabel}>{t('evidence.rivals')}</span>
              <ul className={styles.rivals}>
                {rivals.map((h) => (
                  <li key={h.id}>
                    <StatusIcon domain="hypothesis" value={h.status} />
                    <span>{componentLabel(h.root_component, names).name}</span>
                    <span className={styles.dim}>{t(`status.hypothesis.${h.status}`)}</span>
                  </li>
                ))}
                {onShowHypotheses && (
                  <li>
                    <button type="button" className={styles.link} onClick={onShowHypotheses}>
                      {t('evidence.show_hypotheses')}
                    </button>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 证据标签页：证据链概要在前，卡按在论证里的位置分组；有重跑权限时可以把同一批卡实时重跑一次，结果与快照并排。
 */
export function EvidenceList({
  incidentRef,
  runId,
  results,
  output = null,
  incident,
  concludedAt = null,
  focus,
  onShowHypotheses,
}: {
  incidentRef: string;
  /** 结果所属的研判；为 null 时是阶段 A 报告的卡。 */
  runId: string | null;
  results: readonly EvidenceResult[];
  /** 研判输出：给出时卡按假设的引用分组，并显示结论的证据链。 */
  output?: ResearchOutput | null;
  /** 事件的起止时间：用于关键时刻与图上的告警触发标记。 */
  incident?: Pick<Incident, 'first_firing_at' | 'ended_at'>;
  concludedAt?: string | null;
  /** 要展开并滚动到的卡；seq 变化时重新定位。 */
  focus?: { ref: string; seq: number } | null;
  onShowHypotheses?: () => void;
}) {
  const { t } = useI18n();
  const { caps } = useUiEnv();
  const rerun = useRerunEvidence(incidentRef);
  const [live, setLive] = useState<Map<string, EvidenceResult> | null>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const chain = useMemo(() => buildEvidenceChain(results, output), [results, output]);
  const byRef = useMemo(() => new Map(results.map((r) => [r.ref, r])), [results]);
  const moments = useMemo(
    () => (incident ? keyMoments(results, incident, concludedAt) : []),
    [results, incident, concludedAt],
  );
  const marks = useMemo<ChartMark[] | undefined>(
    () =>
      incident && [
        { t: Date.parse(incident.first_firing_at) / 1000, tone: 'bad' as const, label: t('evidence.moment.firing') },
      ],
    [incident, t],
  );
  const c = countEvidence(results);

  const reveal = useCallback((ref: string) => {
    setToggled((m) => new Map(m).set(ref, true));
    // 展开后卡片的高度才确定，下一帧再滚动
    requestAnimationFrame(() => document.getElementById(evidenceAnchor(ref))?.scrollIntoView({ block: 'start' }));
  }, []);
  const nav = useMemo<EvidenceNav>(() => ({ card: (ref) => byRef.get(ref), open: reveal }), [byRef, reveal]);
  // 从通知或 issue 打开带 #card-<n> 的链接时，卡片在数据加载之后才出现：加载后展开并滚动到这张卡
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const ref = id.replace('-', ':');
    if (id && byRef.has(ref)) {
      reveal(ref);
    }
  }, [byRef, reveal]);
  useEffect(() => {
    if (focus && byRef.has(focus.ref)) {
      reveal(focus.ref);
    }
  }, [focus, byRef, reveal]);

  if (!results.length) {
    return <EmptyState kind="none" title={t('evidence.empty_title')} because={t('evidence.empty_because')} />;
  }
  const isOpen = (group: ChainGroupId, r: EvidenceResult) => toggled.get(r.ref) ?? expandedByDefault(group, r);
  const setAll = (open: boolean) => setToggled(new Map(results.map((r) => [r.ref, open])));
  const ordered = chain.groups.flatMap((g) => g.cards);
  return (
    <EvidenceNavProvider nav={nav}>
      <div className={styles.list}>
        {(moments.length > 0 || output) && (
          <ChainSummary output={output} moments={moments} onShowHypotheses={onShowHypotheses} />
        )}
        <div className={styles.toolbar}>
          <span>
            {t('evidence.counts', { abnormal: c.abnormal, undeterminable: c.undeterminable, normal: c.normal })}
          </span>
          <span className={styles.grow} />
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t('evidence.expand_all')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAll(false)}>
            {t('evidence.collapse_all')}
          </Button>
          {caps.rerun ? (
            <Button
              size="sm"
              busy={rerun.isPending}
              onClick={() =>
                rerun.mutate(
                  {
                    run_id: runId,
                    refs: ordered.slice(0, RERUN_LIMIT).map((r) => r.ref as EvidenceRef),
                    window_to: new Date().toISOString(),
                  },
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
        {chain.groups.map((g) => (
          <section key={g.id} className={styles.group} data-group={g.id} aria-label={t(`evidence.group.${g.id}`)}>
            <div className={styles.groupHead}>
              <h3>{t(`evidence.group.${g.id}`)}</h3>
              <span className={styles.groupCount}>{g.cards.length}</span>
              <span className={styles.groupHint}>{t(`evidence.group_hint.${g.id}`)}</span>
            </div>
            <div className={styles.cards}>
              {g.cards.map((r) => (
                <EvidenceCard
                  key={r.ref}
                  r={r}
                  live={live?.get(r.ref)}
                  roles={chain.roles.get(r.ref)}
                  marks={marks}
                  open={isOpen(g.id, r)}
                  onToggle={() => setToggled((m) => new Map(m).set(r.ref, !isOpen(g.id, r)))}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </EvidenceNavProvider>
  );
}
