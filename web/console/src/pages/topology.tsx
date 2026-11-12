// 拓扑（DESIGN §4.4、§12.2）：默认视图是全集群地图（ADR 0199），每 15 秒刷新事件；覆盖表里未映射的告警可以直接生成覆盖规则的 gitops_pr 提议（批准后由 gateway
// 只推送到 srenautix/* 分支并开 PR，从不合并）；邻域图每条边标注来源，中心组件与跳数放在 URL 里（ADR 0191、ADR 0197），
// 覆盖表的组件链接到它的邻域；版本差异。

import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { HubComponents, HubOperations } from '@srenautix/contract';
import {
  AppLink,
  Button,
  ClusterMap,
  DataTable,
  EmptyState,
  ErrorBox,
  Mono,
  PageHeader,
  Panel,
  Segmented,
  SelectField,
  Subgraph,
  TextField,
  componentLabel,
  useI18n,
  type ColumnDef,
} from '@srenautix/ui';
import { useMemo, useState } from 'react';
import { hub, ok } from '../api';
import { TOPOLOGY_VIEWS, topologyHref, type TopologyView } from '../route-params';
import { hasRole, useSession } from '../session';
import { Loaded, ROLES_ALL } from './common';
import styles from './pages.module.css';

type Coverage = HubComponents['schemas']['TopologyCoverage'];
type Unmapped = Coverage['unmapped_alerts'][number];
type Diff = HubOperations['getTopologyDiff']['responses'][200]['content']['application/json'];
type Graph = HubComponents['schemas']['Subgraph'];
type MapData = HubComponents['schemas']['ClusterMap'];
type Pr = HubOperations['createTopologyOverridePr']['responses'][201]['content']['application/json'];
const ROLES = ['cause', 'change', 'symptom', 'forecast', 'meta'] as const;

function OverridePr({ cluster, a }: { cluster: string; a: Unmapped }) {
  const { t } = useI18n();
  const [component, setComponent] = useState(a.suggested_component ?? '');
  const [role, setRole] = useState<(typeof ROLES)[number]>(a.suggested_role);
  const pr = useMutation({
    mutationFn: async () =>
      ok<Pr>(
        'createTopologyOverridePr',
        await hub.POST('/v1/topology/overrides/pr', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: { cluster_id: cluster, alertname: a.alertname, component, role },
        }),
      ),
  });
  if (pr.data) {
    // PR 由 gateway 在提议批准后经 gitops_pr 开出（ADR 0108）：这里给出提议与它的状态
    return (
      <span role="status">
        {t(pr.data.state === 'approved' ? 'topology.pr_approved' : 'topology.pr_proposed')}{' '}
        <a href={`/actions/${pr.data.proposal_id}`}>{pr.data.branch}</a>
      </span>
    );
  }
  return (
    <form
      className={styles.row}
      onSubmit={(e) => {
        e.preventDefault();
        pr.mutate();
      }}
    >
      <TextField
        label={t('topology.component')}
        value={component}
        onChange={(e) => setComponent(e.currentTarget.value)}
        required
      />
      <SelectField
        label={t('topology.role')}
        value={role}
        onChange={(e) => setRole(e.currentTarget.value as (typeof ROLES)[number])}
        options={ROLES.map((r) => ({ value: r, label: t(`topology.alert_role.${r}`) }))}
      />
      <Button type="submit" size="sm" busy={pr.isPending} disabled={!component}>
        {t('topology.open_pr')}
      </Button>
      {pr.error && <ErrorBox title={t('topology.pr_failed')} error={pr.error} />}
    </form>
  );
}

function CoverageView({ cluster }: { cluster: string }) {
  const { t, fmt } = useI18n();
  const session = useSession();
  const admin = hasRole(session, 'admin');
  const q = useQuery({
    queryKey: ['topology', 'coverage', cluster],
    queryFn: async () =>
      ok<Coverage>(
        'getTopologyCoverage',
        await hub.GET('/v1/topology/coverage', { params: { query: { cluster_id: cluster } } }),
      ),
  });
  const compCols = useMemo<ColumnDef<Coverage['components'][number]>[]>(
    () => [
      {
        id: 'component',
        header: t('topology.component'),
        accessorKey: 'component',
        enableSorting: true,
        cell: ({ row }) => (
          <span className={styles.stack}>
            <AppLink href={topologyHref(cluster, row.original.component)}>
              {componentLabel(row.original.component).name}
            </AppLink>
            <span className={styles.dim}>{componentLabel(row.original.component).sub}</span>
          </span>
        ),
      },
      { header: t('topology.type'), cell: ({ row }) => row.original.type ?? '-' },
      { header: t('topology.discovered_by'), cell: ({ row }) => t(`topology.discovery.${row.original.discovered_by}`) },
      {
        header: t('topology.chains'),
        cell: ({ row }) => (row.original.chains.length ? row.original.chains.join(', ') : t('topology.no_chain')),
      },
      { header: t('topology.mapped_alerts'), cell: ({ row }) => row.original.mapped_alerts.length },
    ],
    [t, cluster],
  );
  const unmappedCols = useMemo<ColumnDef<Unmapped>[]>(
    () => [
      { header: t('topology.alertname'), cell: ({ row }) => <Mono>{row.original.alertname}</Mono> },
      { header: t('topology.count_14d'), accessorKey: 'count_14d' },
      {
        header: t('topology.suggestion'),
        cell: ({ row }) =>
          t('topology.suggested', {
            role: t(`topology.alert_role.${row.original.suggested_role}`),
            conf: fmt.number(row.original.confidence, 2),
          }),
      },
      { header: t('topology.expr'), cell: ({ row }) => (row.original.expr ? <Mono>{row.original.expr}</Mono> : '-') },
      {
        header: t('topology.override'),
        cell: ({ row }) =>
          admin ? (
            <OverridePr cluster={cluster} a={row.original} />
          ) : (
            <span className={styles.dim}>{t('topology.pr_needs_admin')}</span>
          ),
      },
    ],
    [t, fmt, admin, cluster],
  );
  return (
    <Loaded q={q} what={t('topology.failed')} roles={ROLES_ALL}>
      {(c) => (
        <>
          <Panel
            title={t('topology.coverage')}
            meta={t('topology.coverage_meta', {
              v: c.topology_version,
              n: c.components.length,
              without: c.components_without_chains.length,
            })}
          >
            <DataTable
              data={c.components}
              columns={compCols}
              getRowId={(r) => r.component}
              label={t('topology.coverage')}
              rowTone={(r) => (r.chains.length === 0 ? 'warn' : undefined)}
              empty={
                c.topology_version === 0 ? (
                  <EmptyState
                    kind="degraded"
                    title={t('topology.no_topology_title')}
                    because={t('topology.no_topology')}
                  />
                ) : (
                  <EmptyState
                    kind="none"
                    title={t('topology.no_components_title')}
                    because={t('topology.no_components', { v: c.topology_version })}
                  />
                )
              }
            />
          </Panel>
          <Panel title={t('topology.unmapped')} meta={t('topology.unmapped_meta', { n: c.unmapped_alerts.length })}>
            <DataTable
              data={c.unmapped_alerts}
              columns={unmappedCols}
              getRowId={(r) => r.alertname}
              label={t('topology.unmapped')}
              empty={
                <EmptyState kind="none" title={t('topology.no_unmapped_title')} because={t('topology.no_unmapped')} />
              }
            />
          </Panel>
          {c.suggestions.length > 0 && (
            <Panel title={t('topology.suggestions')}>
              <ul>
                {c.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </Loaded>
  );
}

function MapView({ cluster, domain }: { cluster: string; domain?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['topology', 'map', cluster],
    queryFn: async () =>
      ok<MapData>('getClusterMap', await hub.GET('/v1/topology/map', { params: { query: { cluster_id: cluster } } })),
    // 结构按拓扑版本缓存在服务端，轮询主要取最新的事件；地图只在结构变化时重新排布
    refetchInterval: 15_000,
  });
  return (
    <Panel
      title={t('topology.views.map')}
      meta={q.data ? t('topology.map_meta', { v: q.data.topology_version, n: q.data.incidents.length }) : undefined}
    >
      <Loaded q={q} what={t('topology.map_failed')} roles={ROLES_ALL}>
        {(m) => (
          <ClusterMap
            map={m}
            clusterId={cluster}
            focusDomain={domain}
            primary
            onOpenComponent={(component) =>
              void navigate({ to: '/topology', search: { cluster, view: 'neighborhood', component } })
            }
          />
        )}
      </Loaded>
    </Panel>
  );
}

function NeighborhoodView({ cluster, component, hops }: { cluster: string; component: string | null; hops: 1 | 2 }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [input, setInput] = useState(component ?? '');
  // URL 里的中心组件变了（节点双击、侧栏链接、浏览器前进后退）时，输入框跟着变
  const [shownFor, setShownFor] = useState(component);
  if (shownFor !== component) {
    setShownFor(component);
    setInput(component ?? '');
  }
  const open = (next: string | null, nextHops: 1 | 2) =>
    void navigate({
      to: '/topology',
      search: { cluster, view: 'neighborhood', component: next ?? undefined, hops: nextHops === 1 ? 1 : undefined },
    });
  const openComponent = (next: string | null) => open(next, hops);
  const q = useQuery({
    queryKey: ['topology', 'neighborhood', cluster, component, hops],
    queryFn: async () =>
      ok<Graph>(
        'getTopologyNeighborhood',
        await hub.GET('/v1/topology/neighborhood', {
          params: { query: { cluster_id: cluster, component: component as string, hops } },
        }),
      ),
    enabled: component !== null,
  });
  return (
    <Panel title={t('topology.neighborhood')}>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          openComponent(input.trim() || null);
        }}
      >
        <TextField
          label={t('topology.component_key')}
          placeholder="StatefulSet:db/pg-main"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
        />
        <Button type="submit">{t('topology.show')}</Button>
        <Segmented
          label={t('topology.hops')}
          value={String(hops) as '1' | '2'}
          onChange={(v) => open(component, v === '1' ? 1 : 2)}
          options={(['1', '2'] as const).map((v) => ({ value: v, label: t('topology.hops_n', { n: Number(v) }) }))}
        />
      </form>
      {component === null ? (
        <EmptyState kind="not_applicable" title={t('topology.pick_title')} because={t('topology.pick')} />
      ) : (
        <Loaded q={q} what={t('topology.neighborhood_failed')} roles={ROLES_ALL}>
          {(g) => <Subgraph graph={g} clusterId={cluster} onOpenComponent={openComponent} primary />}
        </Loaded>
      )}
    </Panel>
  );
}

function DiffView({ cluster }: { cluster: string }) {
  const { t } = useI18n();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const q = useQuery({
    queryKey: ['topology', 'diff', cluster, range],
    queryFn: async () =>
      ok<Diff>(
        'getTopologyDiff',
        await hub.GET('/v1/topology/diff', {
          params: { query: { cluster_id: cluster, from: range!.from, to: range!.to } },
        }),
      ),
    enabled: range !== null,
  });
  return (
    <Panel title={t('topology.diff')}>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          setRange({ from: Number(from), to: Number(to) });
        }}
      >
        <TextField
          label={t('topology.from_version')}
          inputMode="numeric"
          pattern="[0-9]+"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
          required
        />
        <TextField
          label={t('topology.to_version')}
          inputMode="numeric"
          pattern="[0-9]+"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
          required
        />
        <Button type="submit">{t('topology.compare')}</Button>
      </form>
      {range === null ? (
        <EmptyState
          kind="not_applicable"
          title={t('topology.pick_versions_title')}
          because={t('topology.pick_versions')}
        />
      ) : (
        <Loaded q={q} what={t('topology.diff_failed')} roles={ROLES_ALL}>
          {(d) =>
            d.added_nodes.length + d.removed_nodes.length + d.added_edges.length + d.removed_edges.length === 0 ? (
              <EmptyState kind="none" title={t('topology.no_diff_title')} because={t('topology.no_diff', range)} />
            ) : (
              <ul className={styles.stack}>
                {d.added_nodes.map((n) => (
                  <li key={`+n${n.key}`}>+ {n.key}</li>
                ))}
                {d.removed_nodes.map((n) => (
                  <li key={`-n${n.key}`}>− {n.key}</li>
                ))}
                {d.added_edges.map((e) => (
                  <li key={`+e${e.from}${e.to}${e.relation}`}>
                    + {e.from} → {e.to} ({e.relation} · {t(`subgraph.source.${e.provenance}`)})
                  </li>
                ))}
                {d.removed_edges.map((e) => (
                  <li key={`-e${e.from}${e.to}${e.relation}`}>
                    − {e.from} → {e.to} ({e.relation})
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      )}
    </Panel>
  );
}

export function TopologyPage({
  cluster,
  view,
  component,
  hops,
  domain,
}: {
  cluster?: string;
  view: TopologyView;
  component?: string;
  hops: 1 | 2;
  domain?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className={styles.page}>
      <PageHeader
        title={t('topology.title')}
        actions={
          <Segmented
            label={t('topology.view')}
            value={view}
            onChange={(v) => void navigate({ to: '/topology', search: { cluster, view: v } })}
            options={TOPOLOGY_VIEWS.map((v) => ({
              value: v,
              label: t(`topology.views.${v}`),
            }))}
          />
        }
      />
      {!cluster ? (
        <EmptyState
          kind="not_applicable"
          title={t('topology.need_cluster_title')}
          because={t('topology.need_cluster')}
        />
      ) : view === 'map' ? (
        <MapView cluster={cluster} domain={domain} />
      ) : view === 'coverage' ? (
        <CoverageView cluster={cluster} />
      ) : view === 'neighborhood' ? (
        <NeighborhoodView cluster={cluster} component={component ?? null} hops={hops} />
      ) : (
        <DiffView cluster={cluster} />
      )}
    </div>
  );
}
