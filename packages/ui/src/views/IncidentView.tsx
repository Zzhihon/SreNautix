// 事件详情（DESIGN §12.2）。首屏回答"10 分钟内怎么办"：结论头、内联的待审批提议、根因子图、
// 固定的反馈框；下方四个标签页：证据、假设、时间线、运行。当前标签由宿主保存在 URL 中。

import { Bot, Gavel } from 'lucide-react';
import { useMemo } from 'react';
import type { Proposal, Recommendation, ResearchRunSummary } from '../contract';
import {
  AppLink,
  useConditions,
  useEvidence,
  useFeedback,
  useIncident,
  useProposals,
  useRun,
  useRuns,
  useStageA,
  useSubgraph,
  useTimeline,
  useUiEnv,
  type IncidentTab,
} from '../data';
import { EvidenceList } from '../domain/EvidenceCard';
import { FeedbackControl } from '../domain/FeedbackControl';
import { HypothesisList } from '../domain/HypothesisList';
import { componentLabel, feedbackState } from '../domain/model';
import { Subgraph } from '../domain/Subgraph';
import { TimelineLane } from '../domain/TimelineLane';
import { VerdictHeader } from '../domain/VerdictHeader';
import { useI18n } from '../i18n';
import { ErrorBox, Loading, Mono, Panel } from '../primitives/basic';
import { EmptyState } from '../primitives/EmptyState';
import { Tabs } from '../primitives/overlays';
import { Status, StatusPill } from '../primitives/Status';
import styles from './views.module.css';

function PendingApprovals({ list, now }: { list: readonly Proposal[]; now: number }) {
  const { t, fmt } = useI18n();
  const { links } = useUiEnv();
  const pending = list.filter((p) => p.state === 'awaiting_approval');
  if (!pending.length) {
    return null;
  }
  return (
    <Panel title={t('detail.pending', { n: pending.length })}>
      <ul className={styles.pendingList}>
        {pending.map((p) => (
          <li key={p.proposal_id} className={styles.pendingItem}>
            <Gavel aria-hidden="true" width={16} height={16} />
            <span className={styles.pendingText}>
              <Mono>{p.action}</Mono> · {p.target.display} · {t(`approval.level.${p.level}`)} ·{' '}
              {t(`approval.tier.${p.tier}`)}
              {p.ttl_expires_at && <> · {t('detail.ttl', { d: fmt.duration(Date.parse(p.ttl_expires_at) - now) })}</>}
            </span>
            {links.approvalExternal ? (
              <a href={links.approval(p.proposal_id)} target="_blank" rel="noopener noreferrer">
                {t('detail.open_approval_console')}
              </a>
            ) : (
              <AppLink href={links.approval(p.proposal_id)}>{t('detail.open_approval')}</AppLink>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Recommendations({ recs }: { recs: readonly Recommendation[] }) {
  const { t } = useI18n();
  if (!recs.length) {
    return null;
  }
  return (
    <Panel title={t('detail.recommendations')}>
      <ul className={styles.recs}>
        {recs.map((r) => (
          <li key={r.id} className={styles.rec}>
            <div className={styles.recHead}>
              <span>{t(`detail.rec_kind.${r.kind}`)}</span>
              <span>{r.title}</span>
              {r.generated_by === 'model' && (
                <StatusPill tone="model" icon={Bot}>
                  {t('common.model_generated')}
                </StatusPill>
              )}
              <span className={styles.dim}>{t(`detail.risk.${r.risk}`)}</span>
            </div>
            <ol>
              {r.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** 运行标签页：各次研判，以及与上一次相比变化的字段。 */
function RunsTab({ runs }: { runs: readonly ResearchRunSummary[] }) {
  const { t, fmt } = useI18n();
  const { links } = useUiEnv();
  if (!runs.length) {
    return <EmptyState kind="none" title={t('detail.no_runs_title')} because={t('detail.no_runs_because')} />;
  }
  return (
    <table className={styles.runsTable}>
      <thead>
        <tr>
          <th scope="col">{t('detail.col.started')}</th>
          <th scope="col">{t('detail.col.reason')}</th>
          <th scope="col">{t('detail.col.state')}</th>
          <th scope="col">{t('detail.col.disposition')}</th>
          <th scope="col">{t('detail.col.level')}</th>
          <th scope="col">{t('detail.col.root')}</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r, i) => {
          const prev = runs[i + 1];
          const diff = (k: 'disposition' | 'conclusion_level' | 'root_component') =>
            prev !== undefined && prev[k] !== r[k];
          return (
            <tr key={r.run_id}>
              <td>
                <AppLink href={links.run(r.run_id)}>{fmt.dateTime(r.started_at)}</AppLink>
                <div className={styles.dim}>v{r.incident_version}</div>
              </td>
              <td>{t(`research.reason.${r.reason}`)}</td>
              <td>
                <Status domain="research" value={r.state} />
              </td>
              <td className={diff('disposition') ? styles.changed : undefined}>
                {r.disposition ? t(`status.disposition.${r.disposition}`) : '-'}
              </td>
              <td className={diff('conclusion_level') ? styles.changed : undefined}>
                {r.conclusion_level ? t(`status.conclusion.${r.conclusion_level}`) : '-'}
              </td>
              <td className={diff('root_component') ? styles.changed : undefined}>
                {r.root_component ? componentLabel(r.root_component).name : '-'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function IncidentView({
  incidentRef,
  tab,
  onTab,
  now,
}: {
  incidentRef: string;
  tab: IncidentTab;
  onTab: (tab: IncidentTab) => void;
  now: number;
}) {
  const { t } = useI18n();
  const incident = useIncident(incidentRef);
  const stageA = useStageA(incidentRef);
  const runs = useRuns(incidentRef);
  const latest = runs.data?.[0] ?? null;
  const concludedId = runs.data?.find((r) => r.state === 'completed')?.run_id ?? null;
  const run = useRun(concludedId);
  const evidence = useEvidence(incidentRef, concludedId);
  const timeline = useTimeline(incidentRef);
  const subgraph = useSubgraph(incidentRef);
  const feedback = useFeedback(incidentRef);
  const conditions = useConditions(incident.data?.cluster_id);
  const proposals = useProposals({ incident_id: incident.data?.incident_id });

  const components = useMemo(
    () => subgraph.data?.nodes.map((n) => n.component) ?? incident.data?.components ?? [],
    [subgraph.data, incident.data],
  );

  if (incident.isPending) {
    return <Loading />;
  }
  if (incident.error) {
    return <ErrorBox title={t('detail.load_failed')} error={incident.error} />;
  }
  const i = incident.data;
  const firstErr = [stageA, runs, evidence, timeline, feedback].find((q) => q.error)?.error;
  const latestFb = feedback.data?.[0] ?? null;
  const disposition = (run.data?.disposition ?? stageA.data?.disposition) || null;
  const root = run.data?.root_component ?? i.root.component;
  const end = i.ended_at ? Date.parse(i.ended_at) : now;
  const start = Date.parse(i.first_firing_at) - 30 * 60_000;

  return (
    <div className={styles.page}>
      <div className={styles.detail}>
        <div className={styles.detailMain}>
          <Panel>
            <VerdictHeader
              incident={i}
              stageA={stageA.data ?? null}
              latestRun={latest}
              evidence={evidence.data ?? []}
              conditions={conditions.data ?? []}
              now={now}
            />
          </Panel>
          {firstErr !== undefined && <ErrorBox title={t('detail.partial_failed')} error={firstErr} />}
          <PendingApprovals list={proposals.data ?? []} now={now} />
          <Panel
            title={t('detail.subgraph')}
            meta={subgraph.data ? t('detail.topology_v', { v: subgraph.data.topology_version }) : undefined}
          >
            {subgraph.error ? (
              <ErrorBox title={t('detail.subgraph_failed')} error={subgraph.error} />
            ) : subgraph.data ? (
              <Subgraph graph={subgraph.data} />
            ) : (
              <Loading />
            )}
          </Panel>
          <Tabs
            label={t('detail.tabs')}
            value={tab}
            onChange={(v) => onTab(v as IncidentTab)}
            tabs={[
              {
                id: 'evidence',
                label: t('detail.tab.evidence'),
                badge: evidence.data?.length,
                content: evidence.data ? (
                  <EvidenceList incidentRef={incidentRef} runId={concludedId} results={evidence.data} />
                ) : (
                  <Loading />
                ),
              },
              {
                id: 'hypotheses',
                label: t('detail.tab.hypotheses'),
                badge: run.data?.output?.hypotheses.length,
                content:
                  concludedId === null ? (
                    <HypothesisList output={null} />
                  ) : run.data ? (
                    <HypothesisList output={run.data.output} />
                  ) : run.error ? (
                    <ErrorBox title={t('detail.run_failed')} error={run.error} />
                  ) : (
                    <Loading />
                  ),
              },
              {
                id: 'timeline',
                label: t('detail.tab.timeline'),
                badge: timeline.data?.length,
                content: timeline.data ? <TimelineLane items={timeline.data} from={start} to={end} /> : <Loading />,
              },
              {
                id: 'runs',
                label: t('detail.tab.runs'),
                badge: runs.data?.length,
                content: runs.data ? <RunsTab runs={runs.data} /> : <Loading />,
              },
            ]}
          />
        </div>
        <aside className={styles.detailSide} aria-label={t('detail.side')}>
          <Panel title={t('feedback.title')}>
            <FeedbackControl
              incidentRef={incidentRef}
              runId={concludedId}
              disposition={disposition}
              rootComponent={root}
              components={components}
              latest={latestFb}
              state={feedbackState(latestFb, disposition !== null)}
              firing={i.state === 'firing'}
            />
          </Panel>
          {run.data?.output && <Recommendations recs={run.data.output.recommendations} />}
        </aside>
      </div>
    </div>
  );
}
