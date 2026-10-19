// 拓扑（DESIGN §4.4、§12.2）：默认视图是覆盖表；未映射的告警可以直接生成覆盖规则的 PR（只推送到
// srenautix/* 分支，从不合并）；邻域图每条边标注来源；版本差异。

import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { HubComponents, HubOperations } from '@srenautix/contract';
import {
  Button,
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
import { hasRole, useSession } from '../session';
import { Loaded, ROLES_ALL } from './common';
import styles from './pages.module.css';

type Coverage = HubComponents['schemas']['TopologyCoverage'];
type Unmapped = Coverage['unmapped_alerts'][number];
type Diff = HubOperations['getTopologyDiff']['responses'][200]['content']['application/json'];
type Graph = HubComponents['schemas']['Subgraph'];
type Pr = HubOperations['createTopologyOverridePr']['responses'][201]['content']['application/json'];
export type TopologyView = 'coverage' | 'neighborhood' | 'diff';
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
    return (
      <span role="status">
        {t('topology.pr_opened')}{' '}
        <a href={pr.data.pr_url} target="_blank" rel="noopener noreferrer">
          {pr.data.branch}
        </a>
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
            <span>{componentLabel(row.original.component).name}</span>
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
    [t],
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

function NeighborhoodView({ cluster }: { cluster: string }) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [component, setComponent] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['topology', 'neighborhood', cluster, component],
    queryFn: async () =>
      ok<Graph>(
        'getTopologyNeighborhood',
        await hub.GET('/v1/topology/neighborhood', {
          params: { query: { cluster_id: cluster, component: component as string } },
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
          setComponent(input.trim() || null);
        }}
      >
        <TextField
          label={t('topology.component_key')}
          placeholder="StatefulSet:db/pg-main"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
        />
        <Button type="submit">{t('topology.show')}</Button>
      </form>
      {component === null ? (
        <EmptyState kind="not_applicable" title={t('topology.pick_title')} because={t('topology.pick')} />
      ) : (
        <Loaded q={q} what={t('topology.neighborhood_failed')} roles={ROLES_ALL}>
          {(g) => <Subgraph graph={g} />}
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

export function TopologyPage({ cluster, view }: { cluster?: string; view: TopologyView }) {
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
            options={(['coverage', 'neighborhood', 'diff'] as const).map((v) => ({
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
      ) : view === 'coverage' ? (
        <CoverageView cluster={cluster} />
      ) : view === 'neighborhood' ? (
        <NeighborhoodView cluster={cluster} />
      ) : (
        <DiffView cluster={cluster} />
      )}
    </div>
  );
}
