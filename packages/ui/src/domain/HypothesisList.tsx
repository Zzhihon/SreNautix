// 假设标签页（DESIGN §7.3、§12.2）：假设树、每个假设的支持与推翻证据、区分性检查及结果、
// 结论阶梯的四个条件，以及代码校验的修改记录。机制描述由模型给出，标注"模型生成"。

import { Bot, Check, X } from 'lucide-react';
import type { Hypothesis, NextCheck, ResearchOutput } from '../contract';
import { useI18n } from '../i18n';
import { Mono } from '../primitives/basic';
import { EmptyState } from '../primitives/EmptyState';
import { Status, StatusPill } from '../primitives/Status';
import { evidenceAnchor } from './EvidenceCard';
import { componentLabel } from './model';
import styles from './HypothesisList.module.css';
import { useComponentNames } from './names';

function RefChips({ refs, label }: { refs: readonly string[]; label: string }) {
  if (!refs.length) {
    return null;
  }
  return (
    <span className={styles.refs} aria-label={label}>
      <span className={styles.refsLabel}>{label}</span>
      {refs.map((r) => (
        <a key={r} href={`#${evidenceAnchor(r)}`} className={styles.ref}>
          {r}
        </a>
      ))}
    </span>
  );
}

function Check1({ c }: { c: NextCheck }) {
  const { t } = useI18n();
  return (
    <li className={styles.check}>
      <Status domain="check" value={c.outcome} />
      <span className={styles.checkPurpose}>{c.purpose}</span>
      <span className={styles.checkMeta}>
        <Mono>{`${c.type}:${c.template}`}</Mono>
        {t('hypothesis.refutes_if', { cond: c.refutes_if })}
        {c.result_ref && (
          <a href={`#${evidenceAnchor(c.result_ref)}`} className={styles.ref}>
            {c.result_ref}
          </a>
        )}
      </span>
    </li>
  );
}

function Node({
  h,
  byParent,
  checks,
  leader,
}: {
  h: Hypothesis;
  byParent: (id: string | null) => Hypothesis[];
  checks: (id: string) => NextCheck[];
  leader: string | null;
}) {
  const { t } = useI18n();
  const names = useComponentNames();
  const root = componentLabel(h.root_component, names);
  const own = checks(h.id);
  const kids = byParent(h.id);
  return (
    <li className={styles.node} data-status={h.status}>
      <div className={styles.nodeHead}>
        <Mono className={styles.hid}>{h.id}</Mono>
        <Status domain="hypothesis" value={h.status} />
        <strong className={styles.root}>{root.name}</strong>
        <span className={styles.sub}>{root.sub}</span>
        {leader === h.id && <span className={styles.leader}>{t('hypothesis.leader')}</span>}
      </div>
      <p className={styles.mechanism}>
        <StatusPill tone="model" icon={Bot}>
          {t('common.model_generated')}
        </StatusPill>{' '}
        {h.mechanism}
      </p>
      <div className={styles.refRow}>
        <RefChips refs={h.supporting} label={t('hypothesis.supporting')} />
        <RefChips refs={h.refuting} label={t('hypothesis.refuting')} />
      </div>
      {own.length > 0 && (
        <ul className={styles.checks}>
          {own.map((c, i) => (
            <Check1 key={i} c={c} />
          ))}
        </ul>
      )}
      {kids.length > 0 && (
        <ul className={styles.tree}>
          {kids.map((c) => (
            <Node key={c.id} h={c} byParent={byParent} checks={checks} leader={leader} />
          ))}
        </ul>
      )}
    </li>
  );
}

const CONSISTENCY_KEYS = [
  'entity_in_scope',
  'onset_precedes_symptom',
  'no_contrary_normal',
  'competitor_tested',
] as const;

export function HypothesisList({ output }: { output: ResearchOutput | null }) {
  const { t } = useI18n();
  const names = useComponentNames();
  if (!output) {
    return (
      <EmptyState kind="not_applicable" title={t('hypothesis.empty_title')} because={t('hypothesis.empty_because')} />
    );
  }
  const byParent = (pid: string | null) => output.hypotheses.filter((h) => h.parent_id === pid);
  const checks = (id: string) => output.next_checks.filter((c) => c.hypothesis_id === id);
  const leader = output.conclusion.hypothesis_id;
  return (
    <div className={styles.wrap}>
      <section aria-label={t('hypothesis.conclusion')} className={styles.conclusion}>
        <div className={styles.conclusionHead}>
          <Status domain="conclusion" value={output.conclusion.level} />
          {output.conclusion.root_component && (
            <span>{t('hypothesis.root', { root: componentLabel(output.conclusion.root_component, names).name })}</span>
          )}
        </div>
        <ul className={styles.consistency}>
          {CONSISTENCY_KEYS.map((k) => {
            const ok = output.conclusion.consistency[k];
            return (
              <li key={k} data-ok={ok ? '' : undefined}>
                {ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                <span>{t(`hypothesis.consistency.${k}`)}</span>
                <span className={styles.srOnly}>{ok ? t('hypothesis.met') : t('hypothesis.not_met')}</span>
              </li>
            );
          })}
        </ul>
        {output.conclusion.undetermined_reason && <p className={styles.sub}>{output.conclusion.undetermined_reason}</p>}
      </section>
      {output.hypotheses.length === 0 ? (
        <EmptyState kind="none" title={t('hypothesis.none_title')} because={t('hypothesis.none_because')} />
      ) : (
        <ul className={styles.tree} aria-label={t('hypothesis.tree')}>
          {byParent(null).map((h) => (
            <Node key={h.id} h={h} byParent={byParent} checks={checks} leader={leader} />
          ))}
        </ul>
      )}
      <section aria-label={t('hypothesis.validation')} className={styles.validation}>
        <h3>{t('hypothesis.validation')}</h3>
        {output.validation_notes.length ? (
          <ul>
            {output.validation_notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.sub}>{t('hypothesis.validation_none')}</p>
        )}
      </section>
    </div>
  );
}
