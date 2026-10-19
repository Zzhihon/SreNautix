// 审批页（DESIGN §12.2，移动端优先）。先按固定顺序列出机器推导的 12 项字段，模型给出的理由
// 折叠、灰色显示并标注"模型生成，未经验证"。H 档审批前必须输入目标名称并在 5 分钟内重新认证；
// 合规配置下还要用通行密钥签名。批准后显示审批回执与校验进度，可以撤销。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ExternalLink, KeyRound, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import type { Proposal, ProposalDetail } from '../contract';
import { AppLink, qk, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import type { WebAuthnAssertion } from '../port';
import { Button, ErrorBox, KeyValue, Mono } from '../primitives/basic';
import { Collapsible } from '../primitives/overlays';
import { TextAreaField, TextField } from '../primitives/form';
import { Status, StatusPill } from '../primitives/Status';
import { componentLabel } from './model';
import styles from './ApprovalSheet.module.css';

export interface ReauthHook {
  /** H 档且距上次认证超过 5 分钟。 */
  needed: boolean;
  /** 开始重新认证（本地管理员弹出 TOTP，OIDC 跳转到 max_age=0）。 */
  begin: () => void;
}

export interface PasskeyHook {
  /** 合规配置下为 true：H 档审批要求通行密钥签名（L 档不需要）。 */
  needed: boolean;
  /** 用审批人的通行密钥签名，返回 WebAuthn 断言。 */
  sign: (proposalId: string) => Promise<WebAuthnAssertion>;
}

const UNDOABLE_PHASES: ReadonlySet<string> = new Set(['verifying', 'verified']);

/** 一项检查：图标 + 通过与否的文字 + 名称与说明。 */
function CheckLine({ passed, name, detail }: { passed: boolean; name: string; detail: string }) {
  const { t } = useI18n();
  return (
    <span className={styles.check} data-passed={passed ? '' : undefined}>
      {passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
      <span className={styles.checkWord}>{passed ? t('approval.passed') : t('approval.failed')}</span>
      <span>
        {name} · {detail}
      </span>
    </span>
  );
}

function targetText(p: Proposal): string {
  const t = p.target;
  return [t.cluster_id, t.namespace ?? '-', t.kind, t.name].join(' / ');
}

export function ApprovalSheet({
  detail,
  reauth,
  passkey,
  now,
}: {
  detail: ProposalDetail;
  reauth: ReauthHook;
  passkey: PasskeyHook | null;
  now: number;
}) {
  const { t, fmt } = useI18n();
  const { caps, port, links } = useUiEnv();
  const qc = useQueryClient();
  const p = detail.proposal;
  const [typed, setTyped] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const actions = port.actions;
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.proposal(p.proposal_id) }),
      qc.invalidateQueries({ queryKey: qk.proposals() }),
    ]);

  const approve = useMutation({
    mutationFn: async () => {
      if (!actions) {
        throw new Error(t('approval.no_actions'));
      }
      const webauthn = passkey?.needed && p.tier === 'H' ? await passkey.sign(p.proposal_id) : null;
      return actions.approve(p.proposal_id, { confirm_target: p.tier === 'H' ? typed : null, webauthn });
    },
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: () => {
      if (!actions) {
        throw new Error(t('approval.no_actions'));
      }
      return actions.reject(p.proposal_id, reason.trim());
    },
    onSuccess: refresh,
  });
  const undo = useMutation({
    mutationFn: () => {
      if (!actions) {
        throw new Error(t('approval.no_actions'));
      }
      return actions.undo(p.proposal_id);
    },
    onSuccess: refresh,
  });

  const ttlLeft = p.ttl_expires_at ? Date.parse(p.ttl_expires_at) - now : null;
  const root = p.binding.root_component ? componentLabel(p.binding.root_component).name : t('common.none');
  const awaiting = p.state === 'awaiting_approval';
  const typedOk = p.tier !== 'H' || typed === p.target.display;
  const reauthBlocked = p.tier === 'H' && reauth.needed;

  const fields = [
    {
      id: 'f-action',
      k: t('approval.f.action'),
      v: (
        <span className={styles.inline}>
          <Mono>{p.action}</Mono>
          <span>{t(`approval.level.${p.level}`)}</span>
          <StatusPill tone={p.tier === 'H' ? 'bad' : 'warn'} icon={ShieldCheck}>
            {t(`approval.tier.${p.tier}`)}
          </StatusPill>
        </span>
      ),
    },
    {
      id: 'f-target',
      k: t('approval.f.target'),
      v: (
        <span className={styles.stack}>
          <span>{targetText(p)}</span>
          <Mono>{p.target.uid ?? t('approval.no_uid')}</Mono>
          <span className={detail.target_state.exists ? styles.dim : styles.bad}>
            {detail.target_state.exists
              ? t('approval.target_state', {
                  summary: detail.target_state.summary,
                  rv: detail.target_state.resource_version ?? '-',
                })
              : t('approval.target_gone')}
          </span>
        </span>
      ),
    },
    {
      id: 'f-params',
      k: t('approval.f.params'),
      v: (
        <span className={styles.stack}>
          <Mono>{JSON.stringify(p.params)}</Mono>
          <Mono className={styles.dim}>{p.params_hash}</Mono>
        </span>
      ),
    },
    {
      id: 'f-prechecks',
      k: t('approval.f.prechecks'),
      tone: detail.prechecks.some((c) => !c.passed) ? ('bad' as const) : undefined,
      v: (
        <span className={styles.stack}>
          {detail.prechecks.map((c) => (
            <CheckLine key={c.name} passed={c.passed} name={c.name} detail={c.detail} />
          ))}
          <span className={styles.dim}>
            {detail.prechecked_at
              ? t('approval.prechecked_at', { at: fmt.dateTime(detail.prechecked_at) })
              : t('approval.not_prechecked')}
          </span>
        </span>
      ),
    },
    {
      id: 'f-blast',
      k: t('approval.f.blast'),
      tone: detail.blast_radius.within_limit ? undefined : ('bad' as const),
      v: (
        <span className={styles.stack}>
          <span>
            {detail.blast_radius.summary}
            {!detail.blast_radius.within_limit && ` · ${t('approval.blast_over')}`}
          </span>
          {detail.blast_radius.objects.map((o) => (
            <Mono key={o} className={styles.dim}>
              {o}
            </Mono>
          ))}
        </span>
      ),
    },
    {
      id: 'f-conflict',
      k: t('approval.f.conflict'),
      v: (
        <span className={styles.inline}>
          <Mono>{detail.conflict_domain}</Mono>
          {detail.queue_position !== null
            ? t('approval.queue', { n: detail.queue_position })
            : t('approval.queue_none')}
        </span>
      ),
    },
    {
      id: 'f-verify',
      k: t('approval.f.verify'),
      v: t('approval.verify', { cond: detail.verify.condition, window: detail.verify.window }),
    },
    {
      id: 'f-undo',
      k: t('approval.f.undo'),
      v: `${t(`approval.undo.${detail.undo.kind}`)} · ${detail.undo.description}`,
    },
    {
      id: 'f-ttl',
      k: t('approval.f.ttl'),
      tone: ttlLeft !== null && ttlLeft < 120_000 ? ('warn' as const) : undefined,
      v:
        ttlLeft === null
          ? t('approval.ttl_not_started')
          : ttlLeft > 0
            ? t('approval.ttl_left', { d: fmt.duration(ttlLeft), at: fmt.clock(p.ttl_expires_at as string, now) })
            : t('approval.ttl_expired'),
    },
    {
      id: 'f-policy',
      k: t('approval.f.policy'),
      v: (
        <span className={styles.stack}>
          <Mono>{detail.policy_rule}</Mono>
          {p.policy_checks.map((c) => (
            <CheckLine key={c.name} passed={c.passed} name={c.name} detail={c.detail} />
          ))}
        </span>
      ),
    },
    {
      id: 'f-source',
      k: t('approval.f.source'),
      v: t(`approval.source.${p.source}`, {
        rule: p.rule_id ?? '',
        caller: p.caller_id ?? '',
        run: p.research_run_id ?? '',
      }),
    },
    {
      id: 'f-binding',
      k: t('approval.f.binding'),
      v: (
        <span className={styles.stack}>
          <AppLink href={links.incident(p.incident_id)}>
            {t('approval.binding', { v: p.binding.incident_version, root })}
          </AppLink>
          <Mono className={styles.dim}>{p.binding.evidence_fingerprint}</Mono>
        </span>
      ),
    },
  ];

  return (
    <div className={styles.sheet}>
      <div className={styles.stateRow}>
        <Status domain="proposal" value={p.state} />
        {p.execution &&
          (STATUS_EXEC.has(p.execution.phase) ? (
            <Status domain="execution" value={p.execution.phase as ExecPhase} />
          ) : (
            <Mono>{p.execution.phase}</Mono>
          ))}
      </div>
      <KeyValue items={fields} className={styles.fields} />

      <Collapsible
        muted
        summary={
          <span className={styles.inline}>
            <Bot aria-hidden="true" width={14} height={14} />
            {t('approval.model_rationale')}
          </span>
        }
      >
        <p className={styles.rationale}>{detail.model_rationale ?? t('approval.no_rationale')}</p>
        {p.expected_effect && (
          <p className={styles.rationale}>{t('approval.expected_effect', { e: p.expected_effect })}</p>
        )}
      </Collapsible>

      {p.approval && (
        <section className={styles.receipt} aria-label={t('approval.receipt')}>
          <h3>{t('approval.receipt')}</h3>
          <KeyValue
            items={[
              { k: t('approval.r.decision'), v: t(`approval.decision.${p.approval.decision}`) },
              { k: t('approval.r.by'), v: `${p.approval.principal_id} · ${p.approval.channel}` },
              { k: t('approval.r.at'), v: fmt.dateTime(p.approval.at) },
              { k: t('approval.r.assertion'), v: <Mono>{p.approval.assertion_id ?? t('common.none')}</Mono> },
              ...(p.approval.reason ? [{ k: t('approval.r.reason'), v: p.approval.reason }] : []),
            ]}
          />
        </section>
      )}

      {links.approvalExternal ? (
        awaiting && (
          <a className={styles.external} href={links.approval(p.proposal_id)} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" width={16} height={16} />
            {t('approval.open_console')}
          </a>
        )
      ) : !caps.approve ? (
        awaiting && <p className={styles.dim}>{caps.readOnlyReason}</p>
      ) : (
        <div className={styles.actions}>
          {awaiting && !rejecting && (
            <>
              {p.tier === 'H' && (
                <TextField
                  label={t('approval.type_target', { name: p.target.display })}
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.currentTarget.value)}
                  error={typed !== '' && !typedOk ? t('approval.type_mismatch') : undefined}
                />
              )}
              {reauthBlocked && (
                <div className={styles.reauth} role="alert">
                  <span>{t('approval.reauth_needed')}</span>
                  <Button onClick={reauth.begin}>{t('approval.reauth')}</Button>
                </div>
              )}
              {passkey?.needed && p.tier === 'H' && (
                <p className={styles.dim}>
                  <KeyRound aria-hidden="true" width={14} height={14} /> {t('approval.passkey_needed')}
                </p>
              )}
              <div className={styles.buttons}>
                <Button
                  variant="primary"
                  size="lg"
                  disabled={!typedOk || reauthBlocked || (ttlLeft !== null && ttlLeft <= 0)}
                  busy={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  {t('approval.approve')}
                </Button>
                <Button size="lg" variant="danger" onClick={() => setRejecting(true)}>
                  {t('approval.reject')}
                </Button>
              </div>
            </>
          )}
          {awaiting && rejecting && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim()) {
                  reject.mutate();
                }
              }}
              className={styles.stack}
            >
              <TextAreaField
                label={t('approval.reject_reason')}
                value={reason}
                maxLength={500}
                required
                onChange={(e) => setReason(e.currentTarget.value)}
              />
              <div className={styles.buttons}>
                <Button type="submit" variant="danger" size="lg" disabled={!reason.trim()} busy={reject.isPending}>
                  {t('approval.confirm_reject')}
                </Button>
                <Button size="lg" variant="ghost" onClick={() => setRejecting(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          )}
          {p.level === 'reversible' &&
            detail.undo.kind === 'auto_restore' &&
            p.execution &&
            UNDOABLE_PHASES.has(p.execution.phase) && (
              <Button variant="danger" busy={undo.isPending} onClick={() => undo.mutate()}>
                {t('approval.undo_now')}
              </Button>
            )}
          {approve.error && <ErrorBox title={t('approval.approve_failed')} error={approve.error} />}
          {reject.error && <ErrorBox title={t('approval.reject_failed')} error={reject.error} />}
          {undo.error && <ErrorBox title={t('approval.undo_failed')} error={undo.error} />}
        </div>
      )}
    </div>
  );
}

type ExecPhase =
  | 'pulled'
  | 'prechecked'
  | 'executing'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'verify_failed'
  | 'reverted'
  | 'awaiting_compensation_approval'
  | 'needs_human'
  | 'stale'
  | 'expired'
  | 'rejected'
  | 'indeterminate';

// ExecutionSummary.phase 的取值以 contract/gateway/ 的 ActionExecution 为准；未知的取值原样显示。
const STATUS_EXEC: ReadonlySet<string> = new Set<ExecPhase>([
  'pulled',
  'prechecked',
  'executing',
  'verifying',
  'verified',
  'failed',
  'verify_failed',
  'reverted',
  'awaiting_compensation_approval',
  'needs_human',
  'stale',
  'expired',
  'rejected',
  'indeterminate',
]);
