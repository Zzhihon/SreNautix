// 系统页面：集成（等级徽标与服务端连接测试）、领域包（只读，编写只用 CLI 与 Git）、
// 策略与目录（从 Git 渲染的生效策略、模拟器、软暂停；硬停止只给操作说明）、模型与出境。

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
  TextAreaField,
  TextField,
  useI18n,
  type ColumnDef,
  type Tone,
} from '@srenautix/ui';
import { BadgeCheck, CircleDashed, FlaskConical, Plug, ShieldAlert, Snowflake, Unplug, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { hub, ok } from '../api';
import { useNow } from '../now';
import { hasRole, useSession } from '../session';
import { GitSource, Loaded, ROLES_ALL } from './common';
import styles from './pages.module.css';

type S = HubComponents['schemas'];
type Integration = S['IntegrationInstance'];
type TestResult = HubOperations['testIntegration']['responses'][200]['content']['application/json'];
type Packs = HubOperations['listPacks']['responses'][200]['content']['application/json'];
type Policies = HubOperations['getPolicies']['responses'][200]['content']['application/json'];
type Simulation = HubOperations['simulatePolicy']['responses'][200]['content']['application/json'];
type Freeze = HubOperations['getFreeze']['responses'][200]['content']['application/json'];
type Catalog = HubOperations['listCatalogActions']['responses'][200]['content']['application/json'];

const TIER_TONE: Record<Integration['manifest']['tier'], Tone> = {
  core: 'ok',
  official: 'ok',
  official_candidate: 'info',
  community: 'neutral',
  mcp_bridge: 'nodata',
};

// ---------------------------------------------------------------------------
// 集成
// ---------------------------------------------------------------------------

function IntegrationTest({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const test = useMutation({
    mutationFn: async () =>
      ok<TestResult>(
        'testIntegration',
        await hub.POST('/v1/integrations/{instance_id}/test', {
          params: { path: { instance_id: id }, header: { 'X-CSRF-Token': '' } },
        }),
      ),
  });
  return (
    <div className={styles.stack}>
      <Button size="sm" busy={test.isPending} onClick={() => test.mutate()}>
        <FlaskConical aria-hidden="true" width={14} height={14} />
        {t('integrations.test')}
      </Button>
      {test.data && (
        <ul className={styles.stack} aria-label={t('integrations.test_result')}>
          {test.data.results.map((r) => (
            <li key={r.capability}>
              <StatusPill tone={r.ok ? 'ok' : 'bad'} icon={r.ok ? BadgeCheck : Unplug}>
                {r.capability} · {r.ok ? t('integrations.ok') : t('integrations.failed_cap')} ·{' '}
                {fmt.duration(r.duration_ms)}
              </StatusPill>
              {r.error && <span className={styles.bad}> {r.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {test.error && <ErrorBox title={t('integrations.test_failed')} error={test.error} />}
    </div>
  );
}

function IntegrationCard({ i, admin, now }: { i: Integration; admin: boolean; now: number }) {
  const { t, fmt } = useI18n();
  const m = i.manifest;
  return (
    <Panel
      title={m.display_name}
      meta={<Mono>{i.instance_id}</Mono>}
      actions={
        <StatusPill
          tone={TIER_TONE[m.tier]}
          icon={m.tier === 'core' || m.tier === 'official' ? BadgeCheck : CircleDashed}
        >
          {t(`integrations.tier.${m.tier}`)}
        </StatusPill>
      }
    >
      <KeyValue
        items={[
          { k: t('integrations.category'), v: `${m.category} · ${t(`integrations.direction.${m.direction}`)}` },
          {
            k: t('integrations.last_success'),
            tone: i.last_success_at === null ? 'warn' : undefined,
            v: i.last_success_at ? fmt.relative(i.last_success_at, now) : t('integrations.never'),
          },
          {
            k: t('integrations.error_ratio'),
            tone: i.error_ratio_1h !== null && i.error_ratio_1h > 0.05 ? 'bad' : undefined,
            v: i.error_ratio_1h === null ? t('integrations.no_calls') : fmt.percent(i.error_ratio_1h),
          },
          {
            k: t('integrations.capabilities'),
            v: (
              <span className={styles.stack}>
                {i.capabilities.map((c) => (
                  <span key={c.name}>
                    <StatusPill
                      tone={c.verified ? 'ok' : 'bad'}
                      icon={c.verified ? Plug : Unplug}
                      title={c.error ?? undefined}
                    >
                      {c.name} · {c.maturity} · {c.verified ? t('integrations.verified') : t('integrations.unverified')}
                    </StatusPill>
                  </span>
                ))}
              </span>
            ),
          },
          {
            k: t('integrations.used_by'),
            v: [...i.used_by.chains, ...i.used_by.actions].join(', ') || t('integrations.unused'),
          },
          { k: t('integrations.source'), v: <GitSource repo={i.git_source.repo} sha={i.git_source.sha} /> },
          {
            k: t('integrations.secrets'),
            v: i.secret_refs.length ? i.secret_refs.map((s) => <Mono key={s}>{s}</Mono>) : t('common.none'),
          },
          ...(i.over_privileged
            ? [{ k: t('integrations.privilege'), tone: 'bad' as const, v: t('integrations.over_privileged') }]
            : []),
        ]}
      />
      {admin && <IntegrationTest id={i.instance_id} />}
    </Panel>
  );
}

export function IntegrationsPage() {
  const { t } = useI18n();
  const session = useSession();
  const now = useNow(30_000);
  const q = useQuery({
    queryKey: ['integrations'],
    queryFn: async () => ok<Integration[]>('listIntegrations', await hub.GET('/v1/integrations')),
  });
  return (
    <div className={styles.page}>
      <PageHeader title={t('integrations.title')} meta={t('integrations.supported_note')} />
      <Loaded q={q} what={t('integrations.failed')} roles={ROLES_ALL}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState kind="not_configured" title={t('integrations.empty_title')} because={t('integrations.empty')} />
          ) : (
            <div className={styles.grid}>
              {list.map((i) => (
                <IntegrationCard key={i.instance_id} i={i} admin={hasRole(session, 'admin')} now={now} />
              ))}
            </div>
          )
        }
      </Loaded>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 领域包
// ---------------------------------------------------------------------------

export function PacksPage() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['packs'], queryFn: async () => ok<Packs>('listPacks', await hub.GET('/v1/packs')) });
  const cols = useMemo<ColumnDef<Packs['packs'][number]>[]>(
    () => [
      {
        id: 'name',
        header: t('packs.name'),
        accessorKey: 'name',
        enableSorting: true,
        cell: ({ row }) => (
          <span className={styles.stack}>
            <strong>{row.original.name}</strong>
            <span className={styles.dim}>
              {row.original.version} · {t(`packs.layer.${row.original.layer}`)}
            </span>
          </span>
        ),
      },
      {
        header: t('packs.maturity'),
        cell: ({ row }) => (
          <StatusPill
            tone={row.original.maturity === 'stable' ? 'ok' : row.original.maturity === 'beta' ? 'info' : 'nodata'}
            icon={BadgeCheck}
          >
            {t(`packs.maturities.${row.original.maturity}`)}
          </StatusPill>
        ),
      },
      {
        header: t('packs.source'),
        cell: ({ row }) => (
          <span className={styles.stack}>
            <span>
              {row.original.source} · <Mono>{row.original.ref}</Mono>
            </span>
            <Mono className={styles.dim}>{row.original.digest.slice(7, 19)}</Mono>
          </span>
        ),
      },
      {
        header: t('packs.loaded'),
        cell: ({ row }) =>
          row.original.loaded ? (
            <StatusPill tone="ok" icon={Plug}>
              {t('packs.loaded_ok')}
            </StatusPill>
          ) : (
            <span className={styles.stack}>
              <StatusPill tone="bad" icon={Unplug}>
                {t('packs.not_loaded')}
              </StatusPill>
              <span className={styles.bad}>{row.original.load_error}</span>
            </span>
          ),
      },
      {
        header: t('packs.disabled_caps'),
        cell: ({ row }) => row.original.disabled_capabilities.join(', ') || t('common.none'),
      },
      {
        header: t('packs.ci'),
        cell: ({ row }) =>
          row.original.ci === null ? (
            t('packs.no_ci')
          ) : row.original.ci.report_url ? (
            <a href={row.original.ci.report_url} target="_blank" rel="noopener noreferrer">
              {row.original.ci.passed ? t('packs.ci_passed') : t('packs.ci_failed')}
            </a>
          ) : row.original.ci.passed ? (
            t('packs.ci_passed')
          ) : (
            t('packs.ci_failed')
          ),
      },
      { header: t('packs.user_lines'), cell: ({ row }) => row.original.user_layer_lines ?? '-' },
    ],
    [t],
  );
  return (
    <div className={styles.page}>
      <PageHeader title={t('packs.title')} meta={t('packs.authoring_note')} />
      <Loaded q={q} what={t('packs.failed')} roles={ROLES_ALL}>
        {(d) => (
          <Panel title={t('packs.list')} meta={<Mono>pack.lock</Mono>}>
            <DataTable
              data={d.packs}
              columns={cols}
              getRowId={(p) => `${p.layer}/${p.name}`}
              label={t('packs.list')}
              rowTone={(p) => (!p.loaded ? 'bad' : undefined)}
              empty={<EmptyState kind="not_configured" title={t('packs.empty_title')} because={t('packs.empty')} />}
            />
          </Panel>
        )}
      </Loaded>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 策略与目录
// ---------------------------------------------------------------------------

function Simulator({ cluster, actions }: { cluster: string; actions: string[] }) {
  const { t } = useI18n();
  const [action, setAction] = useState(actions[0] ?? '');
  const [kind, setKind] = useState('Pod');
  const [namespace, setNamespace] = useState('');
  const [name, setName] = useState('');
  const [params, setParams] = useState('{}');
  const sim = useMutation({
    mutationFn: async () =>
      ok<Simulation>(
        'simulatePolicy',
        await hub.POST('/v1/policies/simulate', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: {
            cluster_id: cluster,
            action,
            target: { kind, namespace: namespace || null, name },
            params: JSON.parse(params) as Record<string, unknown>,
          },
        }),
      ),
  });
  return (
    <Panel title={t('policies.simulator')} meta={t('policies.simulator_note')}>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault();
          sim.mutate();
        }}
      >
        <div className={styles.row}>
          <SelectField
            label={t('policies.action')}
            value={action}
            onChange={(e) => setAction(e.currentTarget.value)}
            options={actions.map((a) => ({ value: a, label: a }))}
          />
          <TextField
            label={t('policies.kind')}
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value)}
            required
          />
          <TextField
            label={t('policies.namespace')}
            value={namespace}
            onChange={(e) => setNamespace(e.currentTarget.value)}
          />
          <TextField
            label={t('policies.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
          />
        </div>
        <TextAreaField
          label={t('policies.params')}
          value={params}
          onChange={(e) => setParams(e.currentTarget.value)}
          spellCheck={false}
        />
        <Button type="submit" variant="primary" busy={sim.isPending} disabled={!action || !name}>
          {t('policies.simulate')}
        </Button>
      </form>
      {sim.error && <ErrorBox title={t('policies.simulate_failed')} error={sim.error} />}
      {sim.data && (
        <KeyValue
          items={[
            {
              k: t('policies.result'),
              tone: sim.data.allowed ? undefined : 'bad',
              v: sim.data.allowed ? t('policies.allowed') : t('policies.denied'),
            },
            {
              k: t('approval.f.action'),
              v: sim.data.level
                ? `${t(`approval.level.${sim.data.level}`)} · ${sim.data.tier ? t(`approval.tier.${sim.data.tier}`) : '-'}`
                : '-',
            },
            { k: t('policies.auto'), v: sim.data.auto ? t('policies.auto_yes') : t('policies.auto_no') },
            {
              k: t('policies.approvers'),
              v: sim.data.approvers.map((a) => `${a.subject}（${a.role}）`).join('、') || t('common.none'),
            },
            { k: t('policies.rules'), v: sim.data.rules.join('\n') || t('common.none') },
            { k: t('policies.reasons'), v: sim.data.reasons.join('\n') || t('common.none') },
          ]}
        />
      )}
    </Panel>
  );
}

function PausePanel() {
  const { t, fmt } = useI18n();
  const session = useSession();
  const qc = useQueryClient();
  const now = useNow(30_000);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('2');
  const q = useQuery({
    queryKey: ['pause'],
    queryFn: async () => ok<S['PauseState']>('getPause', await hub.GET('/v1/pause')),
  });
  const set = useMutation({
    mutationFn: async (paused: boolean) =>
      ok<S['PauseState']>(
        'setPause',
        await hub.PUT('/v1/pause', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: paused
            ? { paused, reason: reason.trim(), expires_at: new Date(now + Number(hours) * 3_600_000).toISOString() }
            : { paused, reason: null, expires_at: null },
        }),
      ),
    onSuccess: (d) => qc.setQueryData(['pause'], d),
  });
  const admin = hasRole(session, 'admin');
  return (
    <Panel title={t('policies.pause')} meta={t('policies.pause_note')}>
      <Loaded q={q} what={t('policies.pause_failed')} roles={ROLES_ALL}>
        {(p) => (
          <div className={styles.stack}>
            {p.paused ? (
              <StatusPill tone="warn" icon={ShieldAlert} strong>
                {t('policies.paused', {
                  by: p.by ?? '-',
                  n: p.held_count,
                  until: p.expires_at ? fmt.clock(p.expires_at, now) : '-',
                })}
              </StatusPill>
            ) : (
              <StatusPill tone="ok" icon={Zap}>
                {t('policies.not_paused')}
              </StatusPill>
            )}
            {p.reason && <p>{p.reason}</p>}
            {admin &&
              (p.paused ? (
                <Button busy={set.isPending} onClick={() => set.mutate(false)}>
                  {t('policies.resume')}
                </Button>
              ) : (
                <form
                  className={styles.row}
                  onSubmit={(e) => {
                    e.preventDefault();
                    set.mutate(true);
                  }}
                >
                  <TextField
                    label={t('policies.pause_reason')}
                    value={reason}
                    onChange={(e) => setReason(e.currentTarget.value)}
                    required
                    maxLength={500}
                  />
                  <TextField
                    label={t('policies.pause_hours')}
                    inputMode="numeric"
                    pattern="[0-9]+"
                    value={hours}
                    onChange={(e) => setHours(e.currentTarget.value)}
                    required
                  />
                  <Button type="submit" variant="danger" busy={set.isPending} disabled={!reason.trim()}>
                    {t('policies.do_pause')}
                  </Button>
                </form>
              ))}
            {set.error && <ErrorBox title={t('policies.pause_failed')} error={set.error} />}
          </div>
        )}
      </Loaded>
    </Panel>
  );
}

function FreezePanel({ cluster }: { cluster: string }) {
  const { t, fmt } = useI18n();
  const now = useNow(30_000);
  const q = useQuery({
    queryKey: ['freeze', cluster],
    queryFn: async () =>
      ok<Freeze>('getFreeze', await hub.GET('/v1/freeze', { params: { query: { cluster_id: cluster } } })),
  });
  return (
    <Panel title={t('policies.freeze')} meta={t('policies.freeze_note')}>
      <Loaded q={q} what={t('policies.freeze_failed')} roles={ROLES_ALL}>
        {(f) => (
          <div className={styles.stack}>
            <StatusPill tone={f.frozen ? 'bad' : 'ok'} icon={Snowflake} strong={f.frozen}>
              {f.frozen ? t('clusters.frozen') : t('clusters.not_frozen')}
            </StatusPill>
            <span className={styles.dim}>
              <Mono>{f.configmap}</Mono> · {t('clusters.observed', { ago: fmt.relative(f.observed_at, now) })}
            </span>
            <p>{t('policies.freeze_how')}</p>
            <code className={styles.code}>{f.instructions.kubectl}</code>
            <p>{t('policies.freeze_gitops', { path: f.instructions.gitops_path })}</p>
          </div>
        )}
      </Loaded>
    </Panel>
  );
}

function RenderedPolicy({ cluster }: { cluster: string }) {
  const { t } = useI18n();
  const policies = useQuery({
    queryKey: ['policies', cluster],
    queryFn: async () =>
      ok<Policies>('getPolicies', await hub.GET('/v1/policies', { params: { query: { cluster_id: cluster } } })),
  });
  return (
    <Loaded q={policies} what={t('policies.failed')} roles={ROLES_ALL}>
      {(p) => (
        <Panel title={t('policies.rendered')} meta={<GitSource repo={p.repo} sha={p.sha} drift={p.drift} />}>
          <pre className={styles.pre}>{JSON.stringify(p.rendered, null, 2)}</pre>
        </Panel>
      )}
    </Loaded>
  );
}

export function PoliciesPage({ cluster }: { cluster?: string }) {
  const { t } = useI18n();
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: async () => ok<Catalog>('listCatalogActions', await hub.GET('/v1/catalog/actions')),
  });
  const enabled = (catalog.data?.enabled ?? []).filter((e) => !cluster || e.cluster_id === cluster);
  return (
    <div className={styles.page}>
      <PageHeader title={t('policies.title')} meta={t('policies.git_note')} />
      {cluster && <RenderedPolicy cluster={cluster} />}
      <Panel title={t('policies.enabled')}>
        <Loaded q={catalog} what={t('policies.catalog_failed')} roles={ROLES_ALL}>
          {() =>
            enabled.length === 0 ? (
              <EmptyState
                kind="not_configured"
                title={t('policies.none_enabled_title')}
                because={t('policies.none_enabled')}
              />
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('policies.action')}</th>
                    <th scope="col">{t('policies.cluster')}</th>
                    <th scope="col">{t('policies.namespaces')}</th>
                    <th scope="col">{t('policies.auto')}</th>
                  </tr>
                </thead>
                <tbody>
                  {enabled.map((e) => (
                    <tr key={`${e.cluster_id}/${e.action}`}>
                      <td>
                        <Mono>{e.action}</Mono>
                      </td>
                      <td>{e.cluster_id}</td>
                      <td>{e.namespaces.join(', ') || t('policies.cluster_scoped')}</td>
                      <td>{e.auto ? t('policies.auto_yes') : t('policies.auto_no')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Loaded>
      </Panel>
      {cluster ? (
        <>
          <Simulator cluster={cluster} actions={[...new Set(enabled.map((e) => e.action))]} />
          <FreezePanel cluster={cluster} />
        </>
      ) : (
        <EmptyState
          kind="not_applicable"
          title={t('policies.need_cluster_title')}
          because={t('policies.need_cluster')}
        />
      )}
      <PausePanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模型与出境
// ---------------------------------------------------------------------------

export function ModelsPage() {
  const { t, fmt } = useI18n();
  const q = useQuery({
    queryKey: ['models', 'routes'],
    queryFn: async () => ok<S['ModelRouteStatus'][]>('listModelRoutes', await hub.GET('/v1/models/routes')),
  });
  const allInTopology = (list: S['ModelRouteStatus'][]) =>
    list.length > 0 && list.every((r) => r.failure_domain.length > 0);
  return (
    <div className={styles.page}>
      <PageHeader title={t('models.title')} />
      <Loaded q={q} what={t('models.failed')} roles={ROLES_ALL}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState kind="not_configured" title={t('models.empty_title')} because={t('models.empty')} />
          ) : (
            <>
              {allInTopology(list) && (
                <p className={styles.warn} role="alert">
                  {t('models.all_in_topology')}
                </p>
              )}
              <div className={styles.grid}>
                {list.map((r) => (
                  <Panel
                    key={r.route_id}
                    title={r.route_id}
                    meta={<Mono>{r.model}</Mono>}
                    actions={
                      <StatusPill
                        tone={r.breaker === 'closed' ? 'ok' : r.breaker === 'open' ? 'bad' : 'warn'}
                        icon={r.breaker === 'closed' ? Plug : Unplug}
                      >
                        {t(`models.breaker.${r.breaker}`)}
                        {r.breaker_reason ? ` · ${t(`models.breaker_reason.${r.breaker_reason}`)}` : ''}
                      </StatusPill>
                    }
                  >
                    <KeyValue
                      items={[
                        { k: t('models.dialect'), v: r.dialect_profile },
                        { k: t('models.endpoint'), v: <Mono>{r.base_url_host}</Mono> },
                        {
                          k: t('models.domain'),
                          tone: r.in_domain ? undefined : 'warn',
                          v: r.in_domain ? t('run.in_domain') : t('run.out_of_domain'),
                        },
                        {
                          k: t('models.failure_domain'),
                          v: r.failure_domain.join(', ') || t('models.outside_topology'),
                        },
                        {
                          k: t('models.health'),
                          v: t('models.health_v', {
                            p50: r.health.p50_ms === null ? '-' : fmt.duration(r.health.p50_ms),
                            err: r.health.error_ratio_1h === null ? '-' : fmt.percent(r.health.error_ratio_1h),
                          }),
                        },
                        {
                          k: t('models.structured'),
                          v: r.structured_failure_ratio === null ? '-' : fmt.percent(r.structured_failure_ratio),
                        },
                        {
                          k: t('models.price'),
                          v: t('models.price_v', {
                            i: fmt.money(r.price.input_per_mtok, r.price.currency),
                            o: fmt.money(r.price.output_per_mtok, r.price.currency),
                          }),
                        },
                        {
                          k: t('models.limits'),
                          v: t('models.limits_v', {
                            inc:
                              r.limits.per_incident_cost === null
                                ? '-'
                                : fmt.money(r.limits.per_incident_cost, r.price.currency),
                            day: r.limits.daily_cost === null ? '-' : fmt.money(r.limits.daily_cost, r.price.currency),
                          }),
                        },
                        {
                          k: t('models.egress'),
                          v: r.egress_categories.map((c) => t(`run.category.${c}`)).join('、') || t('common.none'),
                        },
                        { k: t('models.retention'), v: r.provider_retention ?? t('common.unknown') },
                        {
                          k: t('models.fingerprint'),
                          v: r.provider_fingerprint ? <Mono>{r.provider_fingerprint}</Mono> : t('common.unknown'),
                        },
                      ]}
                    />
                  </Panel>
                ))}
              </div>
            </>
          )
        }
      </Loaded>
    </div>
  );
}
