// 治理页面：审计（两条链分开、校验状态、导出位置与延迟）、用户与角色（角色绑定来自 Git、聊天账号绑定、
// 权限解释）、设置（渠道、API token、保留期、语言与时区、订阅）。密钥永远不经过控制台。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HubComponents, HubOperations } from '@srenautix/contract';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  KeyValue,
  Mono,
  PageHeader,
  Panel,
  SelectField,
  StatusPill,
  TextField,
  useI18n,
  type AuthProviders,
  type ColumnDef,
} from '@srenautix/ui';
import { CheckCircle2, Clock, OctagonX, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { hub, ok } from '../api';
import { useNow } from '../now';
import { hasRole, useSession } from '../session';
import { Loaded, ROLES_ADMIN, ROLES_ALL, ROLES_AUDIT } from './common';
import styles from './pages.module.css';

type S = HubComponents['schemas'];
type Chains = HubOperations['listAuditChains']['responses'][200]['content']['application/json'];
type Records = HubOperations['listAuditRecords']['responses'][200]['content']['application/json'];
type Users = HubOperations['listUsers']['responses'][200]['content']['application/json'];
type Bindings = HubOperations['listRoleBindings']['responses'][200]['content']['application/json'];
type Explain = HubOperations['explainPermission']['responses'][200]['content']['application/json'];
type LinkCode = HubOperations['createLinkCode']['responses'][201]['content']['application/json'];
type NewToken = HubOperations['createApiToken']['responses'][201]['content']['application/json'];

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

function ChainCard({ c, onOpen }: { c: Chains[number]; onOpen: () => void }) {
  const { t, fmt } = useI18n();
  const now = useNow(30_000);
  const lagging = c.export_lag_seconds === null || c.export_lag_seconds > c.lag_threshold_seconds;
  return (
    <Panel
      title={
        c.chain === 'execution'
          ? t('audit.execution_chain', { cluster: c.cluster_id ?? '-' })
          : t('audit.governance_chain')
      }
      actions={
        <StatusPill tone={c.verified.ok ? 'ok' : 'bad'} icon={c.verified.ok ? ShieldCheck : OctagonX}>
          {c.verified.ok ? t('audit.verified') : t('audit.verify_failed')}
        </StatusPill>
      }
    >
      <KeyValue
        items={[
          {
            k: t('audit.sink'),
            tone: c.sink.kind === 'pg' ? 'warn' : undefined,
            v: (
              <span className={styles.stack}>
                <span>
                  {c.sink.kind} · <Mono>{c.sink.location}</Mono>
                </span>
                <span className={styles.dim}>
                  {c.sink.worm ? t('audit.worm') : t('audit.no_worm')} ·{' '}
                  {c.sink.retention_days === null
                    ? t('audit.retention_unset')
                    : t('audit.retention', { d: c.sink.retention_days })}
                </span>
                {c.sink.kind === 'pg' && <span>{t('audit.pg_risk')}</span>}
              </span>
            ),
          },
          {
            k: t('audit.export_lag'),
            tone: lagging ? 'bad' : undefined,
            v: (
              <StatusPill tone={lagging ? 'bad' : 'ok'} icon={lagging ? Clock : CheckCircle2}>
                {c.export_lag_seconds === null
                  ? t('audit.never_exported')
                  : t('audit.lag', {
                      d: fmt.duration(c.export_lag_seconds * 1000),
                      th: fmt.duration(c.lag_threshold_seconds * 1000),
                    })}
              </StatusPill>
            ),
          },
          { k: t('audit.head'), v: <Mono>{`#${c.head_seq} ${c.head_hash ? c.head_hash.slice(0, 19) : '-'}`}</Mono> },
          {
            k: t('audit.verified_at'),
            tone: c.verified.ok ? undefined : 'bad',
            v: `${c.verified.at ? fmt.relative(c.verified.at, now) : t('audit.never_verified')}${c.verified.error ? ` · ${c.verified.error}` : ''}`,
          },
        ]}
      />
      <Button size="sm" onClick={onOpen}>
        {t('audit.records')}
      </Button>
    </Panel>
  );
}

function RecordsPanel({ chain, cluster }: { chain: 'execution' | 'governance'; cluster: string | null }) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const q = useQuery({
    queryKey: ['audit', 'records', chain, cluster, cursor],
    queryFn: async () =>
      ok<Records>(
        'listAuditRecords',
        await hub.GET('/v1/audit/records', {
          params: { query: { chain, cluster_id: cluster ?? undefined, cursor, limit: 100 } },
        }),
      ),
  });
  return (
    <Panel title={t('audit.records_of', { chain: t(`audit.chain.${chain}`), cluster: cluster ?? '-' })}>
      <Loaded q={q} what={t('audit.records_failed')} roles={ROLES_AUDIT}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState kind="none" title={t('audit.no_records_title')} because={t('audit.no_records')} />
          ) : (
            <>
              <ol className={styles.stack}>
                {d.items.map((r, i) => (
                  <li key={i}>
                    <pre className={styles.pre}>{JSON.stringify(r, null, 2)}</pre>
                  </li>
                ))}
              </ol>
              {d.next_cursor && (
                <Button size="sm" onClick={() => setCursor(d.next_cursor ?? undefined)}>
                  {t('common.more')}
                </Button>
              )}
            </>
          )
        }
      </Loaded>
    </Panel>
  );
}

export function AuditPage() {
  const { t } = useI18n();
  const [open, setOpen] = useState<{ chain: 'execution' | 'governance'; cluster: string | null } | null>(null);
  const q = useQuery({
    queryKey: ['audit', 'chains'],
    queryFn: async () => ok<Chains>('listAuditChains', await hub.GET('/v1/audit/chains')),
    refetchInterval: 30_000,
  });
  return (
    <div className={styles.page}>
      <PageHeader title={t('audit.title')} meta={t('audit.cli_note')} />
      <Loaded q={q} what={t('audit.failed')} roles={ROLES_AUDIT}>
        {(chains) =>
          chains.length === 0 ? (
            <EmptyState kind="not_configured" title={t('audit.empty_title')} because={t('audit.empty')} />
          ) : (
            <div className={styles.grid}>
              {chains.map((c) => (
                <ChainCard
                  key={`${c.chain}/${c.cluster_id ?? ''}`}
                  c={c}
                  onOpen={() => setOpen({ chain: c.chain, cluster: c.cluster_id })}
                />
              ))}
            </div>
          )
        }
      </Loaded>
      {open && <RecordsPanel key={`${open.chain}/${open.cluster}`} chain={open.chain} cluster={open.cluster} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 用户与角色
// ---------------------------------------------------------------------------

function MyChatLinks() {
  const { t, fmt } = useI18n();
  const now = useNow(1_000);
  const links = useQuery({
    queryKey: ['chat-links'],
    queryFn: async () => ok<S['ChatLink'][]>('listChatLinks', await hub.GET('/v1/chat-links')),
  });
  const code = useMutation({
    mutationFn: async () =>
      ok<LinkCode>(
        'createLinkCode',
        await hub.POST('/v1/auth/link-code', { params: { header: { 'X-CSRF-Token': '' } } }),
      ),
  });
  return (
    <Panel title={t('users.my_links')}>
      <Loaded q={links} what={t('users.links_failed')} roles={ROLES_ALL}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState kind="none" title={t('users.no_links_title')} because={t('users.no_links')} />
          ) : (
            <ul className={styles.stack}>
              {list.map((l) => (
                <li key={`${l.channel}/${l.channel_user_id}`}>
                  {l.channel} · <Mono>{l.channel_user_id}</Mono> · {t(`users.link_method.${l.method}`)} ·{' '}
                  {fmt.dateTime(l.linked_at)}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <div className={styles.row}>
        <Button busy={code.isPending} onClick={() => code.mutate()}>
          {t('users.new_code')}
        </Button>
        {code.data && Date.parse(code.data.expires_at) > now && (
          <span role="status">
            {t('users.code', { code: code.data.code, d: fmt.duration(Date.parse(code.data.expires_at) - now) })}
          </span>
        )}
      </div>
      {code.error && <ErrorBox title={t('users.code_failed')} error={code.error} />}
    </Panel>
  );
}

// 角色绑定授予的权限（server 的授权模型）；契约里这个字段只写了 string，取值写在这里并请契约补上枚举
const PERMISSIONS = [
  'read',
  'feedback',
  'propose',
  'research.request',
  'evidence.rerun',
  'approve',
  'reject',
  'undo',
  'audit.read',
  'prompt.raw',
  'users.read',
  'settings.write',
  'suppression.write',
  'pause.write',
  'eval.write',
  'api_tokens.write',
] as const;
type Permission = (typeof PERMISSIONS)[number];

function ExplainPanel() {
  const { t } = useI18n();
  const [subject, setSubject] = useState('');
  const [permission, setPermission] = useState<Permission>('approve');
  const [cluster, setCluster] = useState('');
  const [namespace, setNamespace] = useState('');
  const [tier, setTier] = useState<'' | 'L' | 'H'>('');
  const explain = useMutation({
    mutationFn: async () =>
      ok<Explain>(
        'explainPermission',
        await hub.POST('/v1/permissions/explain', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: {
            subject: subject.trim() ? { id: subject.trim(), groups: [] } : null,
            permission,
            target: cluster ? { cluster, namespace: namespace || null, labels: {} } : null,
            tier: tier || null,
          },
        }),
      ),
  });
  return (
    <Panel title={t('users.explain')} meta={t('users.explain_note')}>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          explain.mutate();
        }}
      >
        <TextField
          label={t('users.subject')}
          placeholder={t('users.subject_me')}
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
        />
        <SelectField
          label={t('users.permission')}
          value={permission}
          onChange={(e) => setPermission(e.currentTarget.value as Permission)}
          options={PERMISSIONS.map((p) => ({ value: p, label: `${t(`users.perm.${p}`)}（${p}）` }))}
        />
        <TextField label={t('policies.cluster')} value={cluster} onChange={(e) => setCluster(e.currentTarget.value)} />
        <TextField
          label={t('policies.namespace')}
          value={namespace}
          onChange={(e) => setNamespace(e.currentTarget.value)}
        />
        <SelectField
          label={t('users.tier')}
          value={tier}
          onChange={(e) => setTier(e.currentTarget.value as '' | 'L' | 'H')}
          options={[
            { value: '', label: t('users.no_tier') },
            { value: 'L', label: t('approval.tier.L') },
            { value: 'H', label: t('approval.tier.H') },
          ]}
        />
        <Button type="submit" busy={explain.isPending}>
          {t('users.do_explain')}
        </Button>
      </form>
      {explain.error && <ErrorBox title={t('users.explain_failed')} error={explain.error} />}
      {explain.data && (
        <div className={styles.stack}>
          <StatusPill
            tone={explain.data.allowed ? 'ok' : 'bad'}
            icon={explain.data.allowed ? CheckCircle2 : OctagonX}
            strong
          >
            {explain.data.allowed
              ? t('users.allowed', { who: explain.data.subject.id })
              : t('users.denied', { who: explain.data.subject.id })}
          </StatusPill>
          <span className={styles.dim}>{t('users.revision', { r: explain.data.revision })}</span>
          {explain.data.entries.length === 0 ? (
            <p>{t('users.no_entries')}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('users.binding')}</th>
                  <th scope="col">{t('users.subject_match')}</th>
                  <th scope="col">{t('users.grants')}</th>
                  <th scope="col">{t('users.scope_match')}</th>
                  <th scope="col">{t('users.tier_ok')}</th>
                  <th scope="col">{t('users.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {explain.data.entries.map((e, i) => (
                  <tr key={i}>
                    <td>
                      {e.binding.subject.kind}:{e.binding.subject.name} → {e.binding.role}
                      <div className={styles.dim}>
                        <Mono>{e.file}</Mono>
                      </div>
                    </td>
                    {[e.subject_match, e.grants_permission, e.scope_match, e.tier_ok].map((b, j) => (
                      <td key={j}>{b ? t('users.yes') : t('users.no')}</td>
                    ))}
                    <td>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

export function UsersPage() {
  const { t, fmt } = useI18n();
  const session = useSession();
  const now = useNow(60_000);
  const canList = hasRole(session, 'admin', 'auditor');
  const users = useQuery({
    queryKey: ['users'],
    queryFn: async () => ok<Users>('listUsers', await hub.GET('/v1/users')),
    enabled: canList,
  });
  const bindings = useQuery({
    queryKey: ['role-bindings'],
    queryFn: async () => ok<Bindings>('listRoleBindings', await hub.GET('/v1/role-bindings')),
    enabled: canList,
  });
  const userCols = useMemo<ColumnDef<Users[number]>[]>(
    () => [
      {
        header: t('users.user'),
        cell: ({ row }) => (
          <span className={styles.stack}>
            <strong>{row.original.display_name || row.original.principal_id}</strong>
            <Mono className={styles.dim}>{row.original.principal_id}</Mono>
          </span>
        ),
      },
      { header: t('users.provider'), accessorKey: 'provider' },
      { header: t('users.groups'), cell: ({ row }) => row.original.groups.join(', ') || '-' },
      {
        header: t('users.roles'),
        cell: ({ row }) => row.original.roles.map((r) => r.role).join(', ') || t('users.no_roles'),
      },
      {
        header: t('users.links'),
        cell: ({ row }) => row.original.chat_links.map((l) => l.channel).join(', ') || t('users.unlinked'),
      },
      { header: t('users.last_login'), cell: ({ row }) => fmt.relative(row.original.last_login_at, now) },
    ],
    [t, fmt, now],
  );
  const bindingCols = useMemo<ColumnDef<Bindings['bindings'][number]>[]>(
    () => [
      { header: t('users.subject'), cell: ({ row }) => `${row.original.subject.kind}:${row.original.subject.name}` },
      { header: t('users.role'), accessorKey: 'role' },
      {
        header: t('users.scope'),
        cell: ({ row }) =>
          t('users.scope_v', {
            clusters: row.original.scope.clusters.join(', ') || '*',
            ns: row.original.scope.namespaces.join(', ') || '*',
          }),
      },
      { header: t('users.max_tier'), cell: ({ row }) => row.original.max_risk_tier ?? '-' },
      { header: t('users.file'), cell: ({ row }) => <Mono>{row.original.file}</Mono> },
    ],
    [t],
  );
  return (
    <div className={styles.page}>
      <PageHeader title={t('users.title')} meta={t('users.git_note')} />
      <MyChatLinks />
      {canList ? (
        <>
          <Panel title={t('users.users')}>
            <Loaded q={users} what={t('users.failed')} roles={ROLES_AUDIT}>
              {(list) => (
                <DataTable
                  data={list}
                  columns={userCols}
                  getRowId={(u) => u.principal_id}
                  label={t('users.users')}
                  empty={<EmptyState kind="none" title={t('users.no_users_title')} because={t('users.no_users')} />}
                />
              )}
            </Loaded>
          </Panel>
          <Panel
            title={t('users.bindings')}
            meta={bindings.data ? t('users.revision', { r: bindings.data.revision }) : undefined}
          >
            <Loaded q={bindings} what={t('users.bindings_failed')} roles={ROLES_AUDIT}>
              {(b) => (
                <DataTable
                  data={b.bindings}
                  columns={bindingCols}
                  getRowId={(x) => `${x.file}/${x.subject.kind}/${x.subject.name}/${x.role}`}
                  label={t('users.bindings')}
                  empty={
                    <EmptyState
                      kind="not_configured"
                      title={t('users.no_bindings_title')}
                      because={t('users.no_bindings')}
                    />
                  }
                />
              )}
            </Loaded>
          </Panel>
        </>
      ) : (
        <EmptyState
          kind="forbidden"
          title={t('common.forbidden_title')}
          because={t('common.forbidden', { roles: ROLES_AUDIT })}
        />
      )}
      <ExplainPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function ApiTokens() {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const now = useNow(60_000);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const list = useQuery({
    queryKey: ['api-tokens'],
    queryFn: async () => ok<S['ApiToken'][]>('listApiTokens', await hub.GET('/v1/api-tokens')),
  });
  const create = useMutation({
    mutationFn: async () =>
      ok<NewToken>(
        'createApiToken',
        await hub.POST('/v1/api-tokens', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: {
            name: name.trim(),
            expires_at: days ? new Date(now + Number(days) * 86_400_000).toISOString() : null,
          },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const r = await hub.DELETE('/v1/api-tokens/{token_id}', {
        params: { path: { token_id: id }, header: { 'X-CSRF-Token': '' } },
      });
      if (!r.response.ok) {
        ok('deleteApiToken', r);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  });
  return (
    <Panel title={t('settings.tokens')} meta={t('settings.tokens_note')}>
      <Loaded q={list} what={t('settings.tokens_failed')} roles={ROLES_ADMIN}>
        {(tokens) =>
          tokens.length === 0 ? (
            <EmptyState kind="none" title={t('settings.no_tokens_title')} because={t('settings.no_tokens')} />
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('settings.token_name')}</th>
                  <th scope="col">{t('settings.token_scope')}</th>
                  <th scope="col">{t('settings.token_created')}</th>
                  <th scope="col">{t('settings.token_used')}</th>
                  <th scope="col">{t('settings.token_expires')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>{k.scopes.join(', ')}</td>
                    <td>
                      {k.created_by} · {fmt.dateTime(k.created_at)}
                    </td>
                    <td>{k.last_used_at ? fmt.relative(k.last_used_at, now) : t('settings.never_used')}</td>
                    <td>{k.expires_at ? fmt.dateTime(k.expires_at) : t('settings.no_expiry')}</td>
                    <td>
                      <Button
                        size="sm"
                        variant="danger"
                        busy={del.isPending && del.variables === k.id}
                        onClick={() => del.mutate(k.id)}
                      >
                        {t('settings.revoke')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loaded>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label={t('settings.token_name')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
          maxLength={100}
        />
        <TextField
          label={t('settings.token_days')}
          inputMode="numeric"
          pattern="[0-9]*"
          value={days}
          onChange={(e) => setDays(e.currentTarget.value)}
        />
        <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
          {t('settings.create_token')}
        </Button>
      </form>
      {create.data && (
        <div role="status" className={styles.stack}>
          <strong>{t('settings.token_once')}</strong>
          <code className={styles.code}>{create.data.token}</code>
        </div>
      )}
      {(create.error || del.error) && (
        <ErrorBox title={t('settings.token_op_failed')} error={create.error ?? del.error} />
      )}
    </Panel>
  );
}

function SettingsForm({ s }: { s: S['Settings'] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(s);
  const save = useMutation({
    mutationFn: async () =>
      ok<S['Settings']>(
        'putSettings',
        await hub.PUT('/v1/settings', { params: { header: { 'X-CSRF-Token': '' } }, body: draft }),
      ),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], d);
      setDraft(d);
    },
  });
  const ret = (k: keyof S['Settings']['retention'], v: string) =>
    setDraft({ ...draft, retention: { ...draft.retention, [k]: Number(v) } });
  return (
    <form
      className={styles.page}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Panel title={t('settings.channels')}>
        {draft.channels.length === 0 ? (
          <EmptyState
            kind="not_configured"
            title={t('settings.no_channels_title')}
            because={t('settings.no_channels')}
          />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('settings.channel')}</th>
                <th scope="col">{t('settings.target')}</th>
                <th scope="col">{t('settings.rate')}</th>
                <th scope="col">{t('settings.enabled')}</th>
              </tr>
            </thead>
            <tbody>
              {draft.channels.map((c, i) => (
                <tr key={c.id}>
                  <td>
                    {c.kind} · <Mono>{c.id}</Mono>
                  </td>
                  <td>
                    <Mono>{c.target}</Mono>
                  </td>
                  <td>{c.rate_per_min}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('settings.enable_channel', { id: c.id })}
                      checked={c.enabled}
                      onChange={(e) => {
                        const channels = [...draft.channels];
                        channels[i] = { ...c, enabled: e.currentTarget.checked };
                        setDraft({ ...draft, channels });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title={t('settings.retention')}>
        <div className={styles.row}>
          <TextField
            label={t('settings.ret_incidents')}
            type="number"
            min={1}
            value={draft.retention.incidents_days}
            onChange={(e) => ret('incidents_days', e.currentTarget.value)}
          />
          <TextField
            label={t('settings.ret_research')}
            type="number"
            min={1}
            value={draft.retention.research_days}
            onChange={(e) => ret('research_days', e.currentTarget.value)}
          />
          <TextField
            label={t('settings.ret_raw')}
            type="number"
            min={0}
            value={draft.retention.raw_prompt_days}
            onChange={(e) => ret('raw_prompt_days', e.currentTarget.value)}
          />
        </div>
      </Panel>
      <Panel title={t('settings.locale_tz')} meta={t('settings.locale_note')}>
        <div className={styles.row}>
          <SelectField
            label={t('header.locale')}
            value={draft.locale}
            onChange={(e) => setDraft({ ...draft, locale: e.currentTarget.value as 'zh-CN' | 'en' })}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
          />
          <TextField
            label={t('settings.time_zone')}
            value={draft.time_zone}
            onChange={(e) => setDraft({ ...draft, time_zone: e.currentTarget.value })}
          />
        </div>
      </Panel>
      <Panel title={t('settings.subscriptions')}>
        {draft.subscriptions.length === 0 ? (
          <EmptyState kind="none" title={t('settings.no_subs_title')} because={t('settings.no_subs')} />
        ) : (
          <ul className={styles.stack}>
            {draft.subscriptions.map((s) => (
              <li key={s.id}>
                {t('settings.sub', {
                  cluster: s.filter.cluster_id ?? '*',
                  sev: s.filter.severity ?? '*',
                  comp: s.filter.component ?? '*',
                  ch: s.channel_id,
                })}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div className={styles.row}>
        <Button type="submit" variant="primary" busy={save.isPending}>
          {t('settings.save')}
        </Button>
        {save.isSuccess && <span role="status">{t('settings.saved')}</span>}
      </div>
      {save.error && <ErrorBox title={t('settings.save_failed')} error={save.error} />}
    </form>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const session = useSession();
  const admin = hasRole(session, 'admin');
  const q = useQuery({
    queryKey: ['settings'],
    queryFn: async () => ok<S['Settings']>('getSettings', await hub.GET('/v1/settings')),
  });
  // 本地管理员的 TOTP 开关（ADR 0118）：关闭时在安全设置中显示
  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () => ok<AuthProviders>('listAuthProviders', await hub.GET('/v1/auth/providers')),
  });
  const totpOff = providers.data?.local_admin.enabled === true && !providers.data.local_admin.totp_required;
  return (
    <div className={styles.page}>
      <PageHeader title={t('settings.title')} meta={t('settings.secret_note')} />
      {totpOff && (
        <Panel title={t('settings.totp_off_title')}>
          <p className={styles.warn} role="note">
            {t('settings.totp_off')}
          </p>
        </Panel>
      )}
      <Loaded q={q} what={t('settings.failed')} roles={ROLES_ALL}>
        {(s) =>
          admin ? (
            <SettingsForm s={s} />
          ) : (
            <Panel title={t('settings.read_only')}>
              <pre className={styles.pre}>{JSON.stringify(s, null, 2)}</pre>
            </Panel>
          )
        }
      </Loaded>
      {admin && <ApiTokens />}
    </div>
  );
}
