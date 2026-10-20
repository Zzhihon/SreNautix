// 两个维度的反馈（DESIGN §11）：处置判断对不对、根因组件对不对。进行中和已恢复的事件都可以反馈，
// 以最新一条为准。"根因错"可以不选真实根因，这条反馈只计入准确率，不生成回放用例。

import { useState, type ReactNode } from 'react';
import type { Disposition, Feedback, FeedbackCreate } from '../contract';
import { useCreateFeedback, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Button, ErrorBox } from '../primitives/basic';
import { SelectField, TextField } from '../primitives/form';
import { Status } from '../primitives/Status';
import { componentLabel, type FeedbackState } from './model';
import styles from './FeedbackControl.module.css';
import { useComponentNames } from './names';

type Axis = 'unset' | 'confirmed' | 'rejected';

const DISPOSITIONS: readonly Disposition[] = ['act', 'escalate', 'ignore', 'undetermined'];
const UNKNOWN = '__unknown__';

function AxisRow({
  label,
  shown,
  value,
  onChange,
  disabled,
}: {
  label: string;
  shown: ReactNode;
  value: Axis;
  onChange: (v: Axis) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.axis} role="group" aria-label={label}>
      <span className={styles.axisLabel}>{label}</span>
      <span className={styles.shown}>{shown}</span>
      <span className={styles.btns}>
        <button
          type="button"
          className={styles.yes}
          aria-pressed={value === 'confirmed'}
          disabled={disabled}
          onClick={() => onChange(value === 'confirmed' ? 'unset' : 'confirmed')}
        >
          {t('feedback.right')}
        </button>
        <button
          type="button"
          className={styles.no}
          aria-pressed={value === 'rejected'}
          disabled={disabled}
          onClick={() => onChange(value === 'rejected' ? 'unset' : 'rejected')}
        >
          {t('feedback.wrong')}
        </button>
      </span>
    </div>
  );
}

export function FeedbackControl({
  incidentRef,
  runId,
  disposition,
  rootComponent,
  components,
  latest,
  state,
  firing,
}: {
  incidentRef: string;
  /** 反馈针对的研判；只有阶段 A 时为 null。 */
  runId: string | null;
  disposition: Disposition | null;
  rootComponent: string | null;
  /** 本次研判拓扑中的组件，真实根因从中选择。 */
  components: readonly string[];
  latest: Feedback | null;
  state: FeedbackState;
  firing: boolean;
}) {
  const { t } = useI18n();
  const names = useComponentNames();
  const { caps } = useUiEnv();
  const create = useCreateFeedback(incidentRef);
  const [editing, setEditing] = useState(false);
  const [disp, setDisp] = useState<Axis>('unset');
  const [root, setRoot] = useState<Axis>('unset');
  const [rightDisp, setRightDisp] = useState<string>('');
  const [rightRoot, setRightRoot] = useState<string>('');
  const [mechanism, setMechanism] = useState('');
  const [reason, setReason] = useState('');

  if (!caps.feedback) {
    return <p className={styles.readonly}>{caps.readOnlyReason}</p>;
  }

  if (latest && !editing && !create.isPending) {
    return (
      <div className={styles.given} role="status">
        <Status domain="feedback" value={state === 'stale' ? 'stale' : 'given'} />
        <span>{summary(latest, t)}</span>
        <Button variant="link" onClick={() => setEditing(true)}>
          {t('common.edit')}
        </Button>
      </div>
    );
  }

  const valid =
    (disp !== 'unset' || root !== 'unset') &&
    (disp !== 'rejected' || rightDisp !== '') &&
    (root !== 'rejected' || rightRoot !== '') &&
    reason.length <= 500 &&
    mechanism.length <= 600;

  const submit = () => {
    const body: FeedbackCreate = {
      research_run_id: runId,
      verdict: root === 'unset' ? null : root,
      root_component:
        root === 'confirmed' ? rootComponent : root === 'rejected' && rightRoot !== UNKNOWN ? rightRoot : null,
      disposition_verdict: disp === 'unset' ? null : disp,
      disposition: disp === 'confirmed' ? disposition : disp === 'rejected' ? (rightDisp as Disposition) : null,
      mechanism: mechanism.trim() || null,
      reason: reason.trim() || null,
    };
    create.mutate(body, { onSuccess: () => setEditing(false) });
  };

  return (
    <form
      className={styles.form}
      aria-label={t('feedback.label')}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          submit();
        }
      }}
    >
      {state === 'stale' && latest && (
        <p className={styles.note}>{t('feedback.stale_note', { prev: summary(latest, t) })}</p>
      )}
      <AxisRow
        label={t('feedback.axis_disposition')}
        shown={disposition ? <Status domain="disposition" value={disposition} /> : t('feedback.no_disposition')}
        value={disp}
        onChange={setDisp}
        disabled={disposition === null || create.isPending}
      />
      {disp === 'rejected' && (
        <SelectField
          label={t('feedback.right_disposition')}
          value={rightDisp}
          onChange={(e) => setRightDisp(e.currentTarget.value)}
          placeholder={t('feedback.choose')}
          options={DISPOSITIONS.filter((d) => d !== disposition).map((d) => ({
            value: d,
            label: t(`status.disposition.${d}`),
          }))}
          required
        />
      )}
      <AxisRow
        label={t('feedback.axis_root')}
        shown={rootComponent ? componentLabel(rootComponent, names).name : t('feedback.no_root')}
        value={root}
        onChange={setRoot}
        disabled={create.isPending}
      />
      {root === 'confirmed' && rootComponent === null && (
        <p className={styles.note}>{t('feedback.confirm_needs_root')}</p>
      )}
      {root === 'rejected' && (
        <SelectField
          label={t('feedback.right_root')}
          value={rightRoot}
          onChange={(e) => setRightRoot(e.currentTarget.value)}
          placeholder={t('feedback.choose')}
          hint={rightRoot === UNKNOWN ? t('feedback.unknown_hint') : undefined}
          options={[
            ...components
              .filter((c) => c !== rootComponent)
              .map((c) => ({ value: c, label: `${componentLabel(c, names).name}（${componentLabel(c, names).sub}）` })),
            { value: UNKNOWN, label: t('feedback.unknown_root') },
          ]}
          required
        />
      )}
      {(disp === 'rejected' || root === 'rejected') && (
        <div className={styles.more}>
          <TextField
            label={t('feedback.mechanism')}
            value={mechanism}
            maxLength={600}
            onChange={(e) => setMechanism(e.currentTarget.value)}
          />
          <TextField
            label={t('feedback.reason')}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </div>
      )}
      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          disabled={!valid || (root === 'confirmed' && rootComponent === null)}
          busy={create.isPending}
        >
          {t('feedback.submit')}
        </Button>
        {editing && (
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
        )}
        <span className={styles.hint}>{firing ? t('feedback.firing_ok') : t('feedback.latest_wins')}</span>
      </div>
      {create.error && <ErrorBox title={t('feedback.failed')} error={create.error} />}
    </form>
  );
}

function summary(f: Feedback, t: (id: string, v?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (f.disposition_verdict) {
    parts.push(
      f.disposition_verdict === 'confirmed'
        ? t('feedback.sum_disp_ok')
        : t('feedback.sum_disp_bad', { d: f.disposition ? t(`status.disposition.${f.disposition}`) : '-' }),
    );
  }
  if (f.verdict) {
    parts.push(
      f.verdict === 'confirmed'
        ? t('feedback.sum_root_ok')
        : f.root_component
          ? t('feedback.sum_root_bad', { c: componentLabel(f.root_component).name })
          : t('feedback.sum_root_unknown'),
    );
  }
  parts.push(t('feedback.sum_by', { who: f.principal_id, channel: f.channel }));
  return parts.join(' · ');
}
