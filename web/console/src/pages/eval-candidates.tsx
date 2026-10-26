// 评测候选（ADR 0175）：反馈、关闭的自愈 PR、以 not planned 关闭的事件 issue 与"加入评测"生成的候选，管理员在这里确认
// （选定标注类型、根因、处置）或放弃。确认的候选由命令行 `srenautix eval candidates export` 导出为标注。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { HubComponents } from '@srenautix/contract';
import { useState } from 'react';
import {
  Button,
  displayComponent,
  EmptyState,
  ErrorBox,
  Loading,
  Mono,
  Panel,
  Segmented,
  SelectField,
  Sheet,
  TextField,
  useI18n,
} from '@srenautix/ui';
import { hub, ok } from '../api';
import styles from './pages.module.css';

type Candidate = HubComponents['schemas']['EvalCandidate'];
type Confirm = HubComponents['schemas']['EvalCandidateConfirm'];
type State = Candidate['state'];
type LabelType = Confirm['type'];
type Disposition = NonNullable<Confirm['disposition']>;

const STATES: readonly State[] = ['pending', 'confirmed', 'dropped'];
const TYPES: readonly LabelType[] = ['benign', 'incident', 'abstain'];
const DISPOSITIONS: readonly Disposition[] = ['act', 'escalate', 'ignore', 'undetermined'];

const KEY = ['eval', 'candidates'] as const;

/** 组件键列表：逗号、空白或换行分隔 */
function parseRoots(s: string): string[] {
  return [...new Set(s.split(/[\s,，]+/).filter(Boolean))];
}

function ConfirmSheet({ c, onClose }: { c: Candidate; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [type, setType] = useState<LabelType>(c.suggested_type ?? 'benign');
  const [roots, setRoots] = useState('');
  const [disposition, setDisposition] = useState<Disposition | ''>('');
  const [mechanism, setMechanism] = useState('');
  const body = (): Confirm => ({
    type,
    roots: type === 'incident' ? parseRoots(roots) : [],
    disposition: type === 'benign' ? 'ignore' : type === 'abstain' || disposition === '' ? null : disposition,
    mechanism: mechanism.trim() || null,
  });
  const confirm = useMutation({
    mutationFn: async () =>
      ok<Candidate>(
        'confirmEvalCandidate',
        await hub.POST('/v1/eval/candidates/{candidate_id}/confirm', {
          params: { path: { candidate_id: c.candidate_id }, header: { 'X-CSRF-Token': '' } },
          body: body(),
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const valid = type !== 'incident' || parseRoots(roots).length > 0;
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('eval.cand.confirm_title')}
      description={c.incident_label}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm.mutate();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <SelectField
          label={t('eval.cand.type')}
          value={type}
          onChange={(e) => setType(e.currentTarget.value as LabelType)}
          options={TYPES.map((v) => ({ value: v, label: t(`eval.case_type.${v}`) }))}
        />
        {type === 'incident' && (
          <>
            <TextField
              label={t('eval.cand.roots')}
              hint={t('eval.cand.roots_hint')}
              value={roots}
              onChange={(e) => setRoots(e.currentTarget.value)}
              required
            />
            <SelectField
              label={t('eval.cand.disposition')}
              value={disposition}
              placeholder={t('eval.cand.no_disposition')}
              onChange={(e) => setDisposition(e.currentTarget.value as Disposition | '')}
              options={DISPOSITIONS.map((v) => ({ value: v, label: t(`status.disposition.${v}`) }))}
            />
          </>
        )}
        {type === 'benign' && <p className={styles.dim}>{t('eval.cand.benign_note')}</p>}
        {type === 'abstain' && <p className={styles.dim}>{t('eval.cand.abstain_note')}</p>}
        <TextField
          label={t('eval.cand.mechanism')}
          value={mechanism}
          maxLength={600}
          onChange={(e) => setMechanism(e.currentTarget.value)}
        />
        <Button type="submit" variant="primary" busy={confirm.isPending} disabled={!valid}>
          {t('eval.cand.confirm')}
        </Button>
        {confirm.error && <ErrorBox title={t('eval.cand.failed')} error={confirm.error} />}
      </form>
    </Sheet>
  );
}

function DropSheet({ c, onClose }: { c: Candidate; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const drop = useMutation({
    mutationFn: async () =>
      ok<Candidate>(
        'dropEvalCandidate',
        await hub.POST('/v1/eval/candidates/{candidate_id}/drop', {
          params: { path: { candidate_id: c.candidate_id }, header: { 'X-CSRF-Token': '' } },
          body: { reason: reason.trim() || null },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={t('eval.cand.drop_title')} description={c.incident_label}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          drop.mutate();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <TextField
          label={t('eval.cand.drop_reason')}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <Button type="submit" busy={drop.isPending}>
          {t('eval.cand.drop')}
        </Button>
        {drop.error && <ErrorBox title={t('eval.cand.failed')} error={drop.error} />}
      </form>
    </Sheet>
  );
}

/** 管理员可见的评测候选列表 */
export function CandidatesPanel() {
  const { t, fmt } = useI18n();
  const [state, setState] = useState<State>('pending');
  const [confirming, setConfirming] = useState<Candidate | null>(null);
  const [dropping, setDropping] = useState<Candidate | null>(null);
  const q = useQuery({
    queryKey: [...KEY, state],
    queryFn: async () =>
      ok<Candidate[]>(
        'listEvalCandidates',
        await hub.GET('/v1/eval/candidates', { params: { query: { state, limit: 200 } } }),
      ),
  });
  return (
    <Panel
      title={t('eval.cand.title')}
      meta={t('eval.cand.meta')}
      actions={
        <Segmented
          label={t('eval.cand.state_label')}
          value={state}
          onChange={setState}
          options={STATES.map((v) => ({ value: v, label: t(`eval.candidate_state.${v}`) }))}
        />
      }
    >
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox title={t('eval.cand.list_failed')} error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyState kind="none" title={t('eval.cand.empty_title')} because={t(`eval.cand.empty.${state}`)} />
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('eval.cand.incident')}</th>
                <th scope="col">{t('eval.cand.source')}</th>
                <th scope="col">{t('eval.cand.reason')}</th>
                <th scope="col">{t('eval.cand.type')}</th>
                <th scope="col">{t('eval.cand.created')}</th>
                {state === 'pending' && <th scope="col">{t('eval.cand.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.candidate_id}>
                  <th scope="row">
                    <Link to="/incidents/$ref" params={{ ref: c.incident_id }} search={{ cluster: c.cluster_id }}>
                      {c.incident_label}
                    </Link>
                    {c.suite && <div className={styles.dim}>{t('eval.cand.suite', { suite: c.suite })}</div>}
                  </th>
                  <td>
                    {t(`eval.candidate_source.${c.source}`)}
                    <div className={styles.dim}>
                      <Mono>{c.source_ref}</Mono>
                    </div>
                  </td>
                  <td>
                    {c.reason_code ? t(`feedback.reason_code.${c.reason_code}`) : '-'}
                    {c.reason && <div className={styles.dim}>{c.reason}</div>}
                  </td>
                  <td>
                    {c.label ? (
                      <>
                        {t(`eval.case_type.${c.label.type}`)}
                        <div className={styles.dim}>
                          {c.label.roots.map(displayComponent).join(', ') || '-'} ·{' '}
                          {c.label.disposition ? t(`status.disposition.${c.label.disposition}`) : '-'}
                        </div>
                      </>
                    ) : c.suggested_type ? (
                      t('eval.cand.suggested', { type: t(`eval.case_type.${c.suggested_type}`) })
                    ) : (
                      t('eval.cand.undecided')
                    )}
                    {c.decided_by && (
                      <div className={styles.dim}>
                        {c.decided_by}
                        {c.drop_reason ? ` · ${c.drop_reason}` : ''}
                      </div>
                    )}
                  </td>
                  <td>{fmt.dateTime(c.created_at)}</td>
                  {state === 'pending' && (
                    <td>
                      <span className={styles.row}>
                        <Button size="sm" variant="primary" onClick={() => setConfirming(c)}>
                          {t('eval.cand.confirm')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDropping(c)}>
                          {t('eval.cand.drop')}
                        </Button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirming && <ConfirmSheet c={confirming} onClose={() => setConfirming(null)} />}
      {dropping && <DropSheet c={dropping} onClose={() => setDropping(null)} />}
    </Panel>
  );
}
