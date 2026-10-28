// 事件详情首屏的结论头（DESIGN §12.2）：一句结论、处置判断、结论阶梯、证据计数与降级的数据源，
// 以及影响这个判定的条件。阶段 B 还没有结论时用阶段 A 的确定性判断，并写明"模型研判中"或原因。

import { Bot, GitMerge, Layers, Scale, Split } from 'lucide-react';
import type { Condition, EvidenceResult, Incident, ResearchRunSummary, StageAReport } from '../contract';
import { AppLink, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Mono } from '../primitives/basic';
import { Status, StatusPill } from '../primitives/Status';
import { activeConditions } from './ConditionStrip';
import { componentLabel, countEvidence, degradedSources, incidentDuration } from './model';
import styles from './VerdictHeader.module.css';
import { useComponentNames } from './names';

const RUNNING: ReadonlySet<ResearchRunSummary['state']> = new Set([
  'queued',
  'hypothesize',
  'discriminate',
  'conclude',
]);

/** 影响判定的条件：与本事件同集群、或不分集群的条件。 */
export function affectingConditions(conditions: readonly Condition[], clusterId: string): Condition[] {
  return activeConditions(conditions).filter((c) => c.cluster_id === null || c.cluster_id === clusterId);
}

export function VerdictHeader({
  incident,
  stageA,
  latestRun,
  evidence,
  conditions,
  now,
}: {
  incident: Incident;
  stageA: StageAReport | null;
  /** 最近一次研判（新的在前的第一项）；没有时为 null。 */
  latestRun: ResearchRunSummary | null;
  /** 首屏计数用的证据：最近一次完成的研判，没有时为阶段 A 的卡。 */
  evidence: readonly EvidenceResult[];
  conditions: readonly Condition[];
  now: number;
}) {
  const { t, fmt, locale } = useI18n();
  const { links } = useUiEnv();
  const concluded = latestRun && latestRun.state === 'completed' ? latestRun : null;
  // 没有模型结论时显示阶段 A 的规则判定（ADR 0178），标明“规则判定”
  const rule = concluded ? null : (stageA?.rule_conclusions?.[0] ?? null);
  const disposition = concluded?.disposition ?? stageA?.disposition ?? null;
  const level = concluded?.conclusion_level ?? rule?.level ?? null;
  const root = concluded?.root_component ?? rule?.root_component ?? incident.root.component;
  const names = useComponentNames();
  const rootL = root ? componentLabel(root, names) : null;
  const counts = countEvidence(evidence);
  const degraded = degradedSources(evidence);
  const affecting = affectingConditions(conditions, incident.cluster_id);
  const running = latestRun !== null && RUNNING.has(latestRun.state);
  const localized = (v: Record<string, string | undefined>) => v[locale] ?? v['zh-CN'] ?? v.en ?? '';

  const sentence =
    concluded?.summary ??
    (rule
      ? t('verdict.rule', {
          root: rootL?.name ?? '-',
          title: localized(rule.title),
          mechanism: localized(rule.mechanism),
        })
      : stageA
        ? t(`verdict.stage_a.${stageA.disposition_reason}`, { root: rootL?.name ?? '-' })
        : t('verdict.no_report'));

  return (
    <section className={styles.head} aria-label={t('verdict.label')}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{rootL ? rootL.name : incident.label}</h1>
        {rootL && <span className={styles.sub}>{rootL.sub}</span>}
        <Status domain="incident" value={incident.state} />
        <Status domain="severity" value={incident.severity} />
        <span className={styles.meta}>
          <Mono>{incident.label}</Mono>
          <span>{t('verdict.version', { v: incident.incident_version, topo: incident.topology_version })}</span>
          <span>{incident.cluster_id}</span>
          <span title={fmt.dateTime(incident.first_firing_at)}>
            {t('verdict.duration', { d: fmt.duration(incidentDuration(incident, now)) })}
          </span>
        </span>
      </div>

      <div className={styles.verdictRow}>
        {disposition ? (
          <Status domain="disposition" value={disposition} strong />
        ) : (
          <Status domain="disposition" value="undetermined" strong />
        )}
        {level && <Status domain="conclusion" value={level} />}
        {incident.root.ambiguous && (
          <span className={styles.flag}>
            {t('verdict.ambiguous', { margin: fmt.number(incident.root.margin ?? 0, 2) })}
          </span>
        )}
        {incident.root.silent_root && <span className={styles.flag}>{t('verdict.silent_root')}</span>}
        {incident.research_root?.mismatch && (
          <span className={styles.flag}>
            {t('verdict.root_mismatch', { root: componentLabel(incident.research_root.component, names).name })}
          </span>
        )}
      </div>

      <p className={styles.sentence}>
        {concluded?.summary && (
          <StatusPill tone="model" icon={Bot}>
            {t('common.model_generated')}
          </StatusPill>
        )}
        {!concluded && rule && (
          <StatusPill tone="neutral" icon={Scale} title={rule.rule_id}>
            {t('verdict.rule_judgement')}
          </StatusPill>
        )}{' '}
        {sentence}
      </p>

      <div className={styles.facts}>
        <span>
          {running
            ? t('verdict.researching', { step: t(`research.state.${latestRun.state}`) })
            : concluded?.finished_at
              ? t('verdict.researched_ago', { ago: fmt.relative(concluded.finished_at, now) })
              : latestRun
                ? t(`research.state.${latestRun.state}`)
                : t('verdict.stage_a_only')}
        </span>
        <span>
          {t('evidence.counts', {
            abnormal: counts.abnormal,
            undeterminable: counts.undeterminable,
            normal: counts.normal,
          })}
        </span>
        {degraded.map((d) => (
          <span key={d.integration} className={styles.degraded} title={d.reason}>
            {t('verdict.degraded_source', { source: d.integration, n: d.cards })}
          </span>
        ))}
        {incident.observability_blind && <Status domain="incident" value="blind" />}
        {stageA?.degraded && <span className={styles.degraded}>{t('verdict.state_store_degraded')}</span>}
      </div>

      {(incident.aliases.length > 0 || incident.split_from || incident.merged_into) && (
        <div className={styles.lineage}>
          {incident.aliases.length > 0 && (
            <StatusPill tone="neutral" icon={GitMerge} title={incident.aliases.map((a) => a.from_label).join('\n')}>
              {t('incident.merged_from', { n: incident.aliases.length })}
            </StatusPill>
          )}
          {incident.split_from && (
            <AppLink href={links.incident(incident.split_from)}>
              <StatusPill tone="neutral" icon={Split}>
                {t('incident.split_from')}
              </StatusPill>
            </AppLink>
          )}
          {incident.merged_into && (
            <AppLink href={links.incident(incident.merged_into)}>
              <StatusPill tone="neutral" icon={Layers}>
                {t('verdict.merged_into')}
              </StatusPill>
            </AppLink>
          )}
        </div>
      )}

      {affecting.length > 0 && (
        <ul className={styles.affecting} aria-label={t('verdict.affecting')}>
          {affecting.map((c) => (
            <li key={`${c.type}/${c.subject ?? ''}`}>
              <strong>{t(`condition.${c.type}`)}</strong> {c.subject ?? ''} · {c.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
