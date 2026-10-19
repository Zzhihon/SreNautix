// 处置：动作队列与审批页（DESIGN §12.2）。队列按"待审批、进行中、历史"分三个标签；待审批的
// L 档提议可以批量审批（只限同类型、同集群）。审批页移动端优先，H 档需要输入目标名称并重新认证。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ApprovalView,
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  Loading,
  Mono,
  PageHeader,
  Panel,
  Segmented,
  Sheet,
  Status,
  TextField,
  qk,
  useI18n,
  useProposals,
  type ColumnDef,
  type Proposal,
} from '@srenautix/ui';
import { useMemo, useState } from 'react';
import { hub, ok, type Session } from '../api';
import { useNow } from '../now';
import { useRefreshSession, useSession, reauthNeeded } from '../session';
import styles from './pages.module.css';

export type QueueTab = 'pending' | 'running' | 'history';

const RUNNING: ReadonlySet<Proposal['state']> = new Set(['approved', 'held', 'dispatched']);
const PENDING: ReadonlySet<Proposal['state']> = new Set(['awaiting_approval']);

type BatchOutcome = { proposal_id: string; outcome: string; message?: string };

export function ActionsPage({ tab, cluster }: { tab: QueueTab; cluster?: string }) {
  const { t, fmt } = useI18n();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const qc = useQueryClient();
  const list = useProposals({ limit: 500 });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () =>
      (list.data ?? [])
        .filter((p) => !cluster || p.cluster_id === cluster)
        .filter((p) =>
          tab === 'pending'
            ? PENDING.has(p.state)
            : tab === 'running'
              ? RUNNING.has(p.state)
              : !PENDING.has(p.state) && !RUNNING.has(p.state),
        ),
    [list.data, cluster, tab],
  );
  const chosen = rows.filter((p) => selected.has(p.proposal_id));
  const batchable =
    chosen.length > 1 &&
    chosen.every((p) => p.tier === 'L' && p.action === chosen[0]!.action && p.cluster_id === chosen[0]!.cluster_id);
  const batch = useMutation({
    mutationFn: async () =>
      ok<{ results: BatchOutcome[] }>(
        'batchApprove',
        await hub.POST('/v1/approvals/batch', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: { proposal_ids: chosen.map((p) => p.proposal_id) },
        }),
      ),
    onSuccess: async () => {
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: qk.proposals() });
    },
  });

  const cols = useMemo<ColumnDef<Proposal>[]>(
    () => [
      ...(tab === 'pending'
        ? [
            {
              id: 'pick',
              header: '',
              cell: ({ row }: { row: { original: Proposal } }) => (
                <input
                  type="checkbox"
                  aria-label={t('actions.pick', { action: row.original.action, target: row.original.target.display })}
                  checked={selected.has(row.original.proposal_id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.currentTarget.checked) {
                      next.add(row.original.proposal_id);
                    } else {
                      next.delete(row.original.proposal_id);
                    }
                    setSelected(next);
                  }}
                />
              ),
            } satisfies ColumnDef<Proposal>,
          ]
        : []),
      {
        header: t('actions.col.action'),
        cell: ({ row }) => (
          <span className={styles.stack}>
            <Link to="/actions/$proposalId" params={{ proposalId: row.original.proposal_id }} search={{ cluster }}>
              <Mono>{row.original.action}</Mono> · {row.original.target.display}
            </Link>
            <span className={styles.dim}>
              {row.original.cluster_id} · {t(`approval.level.${row.original.level}`)} ·{' '}
              {t(`approval.tier.${row.original.tier}`)}
            </span>
          </span>
        ),
      },
      { header: t('actions.col.state'), cell: ({ row }) => <Status domain="proposal" value={row.original.state} /> },
      {
        header: t('actions.col.execution'),
        cell: ({ row }) =>
          row.original.execution ? (
            <span>
              <Mono>{row.original.execution.phase}</Mono>
              {row.original.execution.queue_position !== null && (
                <span className={styles.dim}>
                  {' '}
                  · {t('approval.queue', { n: row.original.execution.queue_position })}
                </span>
              )}
            </span>
          ) : (
            '-'
          ),
      },
      { header: t('actions.col.source'), cell: ({ row }) => t(`actions.source.${row.original.source}`) },
      {
        header: t('actions.col.ttl'),
        cell: ({ row }) =>
          row.original.ttl_expires_at
            ? fmt.duration(Math.max(0, Date.parse(row.original.ttl_expires_at) - now))
            : t('approval.ttl_not_started'),
      },
      { header: t('actions.col.created'), cell: ({ row }) => fmt.clock(row.original.created_at, now) },
    ],
    [tab, t, fmt, now, selected, cluster],
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('actions.title')}
        meta={
          list.data ? t('actions.meta', { pending: list.data.filter((p) => PENDING.has(p.state)).length }) : undefined
        }
      />
      <Segmented
        label={t('actions.tabs')}
        value={tab}
        onChange={(v) => void navigate({ to: '/actions', search: { cluster, tab: v } })}
        options={[
          { value: 'pending', label: t('actions.tab.pending') },
          { value: 'running', label: t('actions.tab.running') },
          { value: 'history', label: t('actions.tab.history') },
        ]}
      />
      {tab === 'pending' && chosen.length > 0 && (
        <div className={styles.batchBar} role="region" aria-label={t('actions.batch')}>
          <span>{t('actions.selected', { n: chosen.length })}</span>
          <Button variant="primary" disabled={!batchable} busy={batch.isPending} onClick={() => batch.mutate()}>
            {t('actions.batch_approve')}
          </Button>
          {!batchable && <span className={styles.dim}>{t('actions.batch_rule')}</span>}
        </div>
      )}
      {batch.data && (
        <ul className={styles.batchResult} aria-label={t('actions.batch_result')}>
          {batch.data.results.map((r) => (
            <li key={r.proposal_id}>
              <Mono>{r.proposal_id.slice(0, 8)}</Mono> · {r.outcome}
              {r.message ? ` · ${r.message}` : ''}
            </li>
          ))}
        </ul>
      )}
      {batch.error && <ErrorBox title={t('actions.batch_failed')} error={batch.error} />}
      <Panel label={t('actions.list')}>
        {list.isPending ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox title={t('actions.load_failed')} error={list.error} />
        ) : (
          <DataTable
            data={rows}
            columns={cols}
            getRowId={(p) => p.proposal_id}
            label={t('actions.list')}
            rowTone={(p) =>
              p.tier === 'H' && PENDING.has(p.state) ? 'bad' : PENDING.has(p.state) ? 'warn' : undefined
            }
            empty={
              <EmptyState kind="none" title={t(`actions.empty.${tab}`)} because={t(`actions.empty_because.${tab}`)} />
            }
          />
        )}
      </Panel>
    </div>
  );
}

/** 本地管理员的重新认证：口令加 TOTP。 */
function LocalReauth({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const refresh = useRefreshSession();
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const reauth = useMutation({
    mutationFn: async () =>
      ok<Session>(
        'reauthLocal',
        await hub.POST('/v1/auth/reauth', { params: { header: { 'X-CSRF-Token': '' } }, body: { password, totp } }),
      ),
    onSuccess: async () => {
      await refresh();
      setPassword('');
      setTotp('');
      onOpenChange(false);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('reauth.title')} description={t('reauth.desc')}>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault();
          reauth.mutate();
        }}
      >
        <TextField
          label={t('login.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <TextField
          label={t('login.totp')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]{6}"
          value={totp}
          onChange={(e) => setTotp(e.currentTarget.value)}
          required
        />
        <Button type="submit" variant="primary" size="lg" busy={reauth.isPending}>
          {t('reauth.submit')}
        </Button>
        {reauth.error && <ErrorBox title={t('reauth.failed')} error={reauth.error} />}
      </form>
    </Sheet>
  );
}

export function ApprovalPage({ proposalId }: { proposalId: string }) {
  const session = useSession();
  const now = useNow(1_000);
  const [reauthOpen, setReauthOpen] = useState(false);
  const begin = () => {
    if (session.local_admin) {
      setReauthOpen(true);
      return;
    }
    const back = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/v1/auth/oidc/start?max_age=0&return_to=${encodeURIComponent(back)}`);
  };
  return (
    <>
      <ApprovalView
        proposalId={proposalId}
        reauth={{ needed: reauthNeeded(session, now), begin }}
        passkey={null}
        now={now}
      />
      <LocalReauth open={reauthOpen} onOpenChange={setReauthOpen} />
    </>
  );
}
