// 路由（TanStack Router，代码定义）。过滤条件、标签页与集群都放在带类型的 search 参数里，
// 刷新和分享链接后页面状态不变。未登录时跳转到登录页，并带上原地址。

import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { DEFAULT_INBOX_FILTERS, type IncidentTab, type InboxFilters } from '@srenautix/ui';
import type { Session } from './api';
import { ActionsPage, ApprovalPage, type QueueTab } from './pages/actions';
import { ClusterPage, ClustersPage } from './pages/clusters';
import { EvalPage, type EvalMode } from './pages/eval';
import { LoginPage } from './pages/LoginPage';
import { AuditPage, SettingsPage, UsersPage } from './pages/governance';
import { HealthPage, type CostGroup } from './pages/health';
import { IncidentPage, InboxPage, RunPage } from './pages/oncall';
import { PromptsPage } from './pages/RawPromptsPage';
import { SearchPage } from './pages/SearchPage';
import { IntegrationsPage, ModelsPage, PacksPage, PoliciesPage } from './pages/system';
import { TopologyPage, type TopologyView } from './pages/topology';
import { AppFrame } from './frame';
import { SESSION_KEY } from './session';

export interface RouterContext {
  queryClient: QueryClient;
  session: () => Promise<Session | null>;
}

// search 参数全部可选：链接只需写出要改的字段，默认值由页面补齐，URL 保持简短
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const maybeOneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

interface ClusterSearch {
  cluster?: string;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: (s: Record<string, unknown>): { return_to?: string } => ({ return_to: str(s.return_to) }),
  component: function Login() {
    const { return_to } = loginRoute.useSearch();
    return <LoginPage returnTo={return_to} />;
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  validateSearch: (s: Record<string, unknown>): ClusterSearch => ({ cluster: str(s.cluster) }),
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.fetchQuery({
      queryKey: SESSION_KEY,
      queryFn: context.session,
      staleTime: 30_000,
    });
    if (!session) {
      throw redirect({ to: '/login', search: { return_to: location.href } });
    }
    return { session };
  },
  component: AppFrame,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/incidents' });
  },
});

const STATES = ['firing', 'resolved', 'all'] as const;
const FEEDBACK = ['pending', 'given', 'all'] as const;
const SEVERITIES = ['critical', 'warning', 'info'] as const;
const DISPOSITIONS = ['act', 'escalate', 'ignore', 'undetermined'] as const;

const incidentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'incidents',
  validateSearch: (s: Record<string, unknown>): Partial<InboxFilters> & ClusterSearch => ({
    cluster: str(s.cluster),
    state: maybeOneOf(s.state, STATES),
    feedback: maybeOneOf(s.feedback, FEEDBACK),
    severity: maybeOneOf(s.severity, SEVERITIES),
    disposition: maybeOneOf(s.disposition, DISPOSITIONS),
    suppressed: s.suppressed === true || s.suppressed === 'true' ? true : undefined,
  }),
  component: function Incidents() {
    const { cluster, state, feedback, severity, disposition, suppressed } = incidentsRoute.useSearch();
    const filters: InboxFilters = {
      state: state ?? DEFAULT_INBOX_FILTERS.state,
      feedback: feedback ?? DEFAULT_INBOX_FILTERS.feedback,
      severity,
      disposition,
      suppressed: suppressed ?? false,
    };
    return <InboxPage cluster={cluster} filters={filters} />;
  },
});

const TABS = ['evidence', 'hypotheses', 'timeline', 'runs'] as const satisfies readonly IncidentTab[];

const incidentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'incidents/$ref',
  validateSearch: (s: Record<string, unknown>): ClusterSearch & { tab?: IncidentTab } => ({
    cluster: str(s.cluster),
    tab: maybeOneOf(s.tab, TABS),
  }),
  component: function Incident() {
    const { ref } = incidentRoute.useParams();
    const { tab, cluster } = incidentRoute.useSearch();
    return <IncidentPage key={ref} incidentRef={ref} tab={tab ?? 'evidence'} cluster={cluster} />;
  },
});

const runRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'runs/$runId',
  component: function Run() {
    const { runId } = runRoute.useParams();
    return <RunPage runId={runId} />;
  },
});

const rawPromptsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'runs/$runId/prompts/raw',
  component: function Raw() {
    const { runId } = rawPromptsRoute.useParams();
    return <PromptsPage runId={runId} raw />;
  },
});

const promptsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'runs/$runId/prompts',
  component: function Prompts() {
    const { runId } = promptsRoute.useParams();
    return <PromptsPage runId={runId} raw={false} />;
  },
});

const COST_GROUPS = ['day', 'incident', 'model'] as const satisfies readonly CostGroup[];

const healthRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'health',
  validateSearch: (s: Record<string, unknown>): ClusterSearch & { cost?: CostGroup } => ({
    cluster: str(s.cluster),
    cost: maybeOneOf(s.cost, COST_GROUPS),
  }),
  component: function Health() {
    const { cost } = healthRoute.useSearch();
    return <HealthPage cost={cost ?? 'day'} />;
  },
});

const TOPOLOGY_VIEWS = ['coverage', 'neighborhood', 'diff'] as const satisfies readonly TopologyView[];

const topologyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'topology',
  validateSearch: (s: Record<string, unknown>): ClusterSearch & { view?: TopologyView } => ({
    cluster: str(s.cluster),
    view: maybeOneOf(s.view, TOPOLOGY_VIEWS),
  }),
  component: function Topology() {
    const { cluster, view } = topologyRoute.useSearch();
    return <TopologyPage cluster={cluster} view={view ?? 'coverage'} />;
  },
});

const integrationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'integrations',
  component: IntegrationsPage,
});
const packsRoute = createRoute({ getParentRoute: () => appRoute, path: 'packs', component: PacksPage });
const policiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'policies',
  component: function Policies() {
    const { cluster } = appRoute.useSearch();
    return <PoliciesPage cluster={cluster} />;
  },
});
const modelsRoute = createRoute({ getParentRoute: () => appRoute, path: 'models', component: ModelsPage });
const auditRoute = createRoute({ getParentRoute: () => appRoute, path: 'audit', component: AuditPage });
const usersRoute = createRoute({ getParentRoute: () => appRoute, path: 'users', component: UsersPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: 'settings', component: SettingsPage });

const QUEUE_TABS = ['pending', 'running', 'history'] as const satisfies readonly QueueTab[];

const actionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'actions',
  validateSearch: (s: Record<string, unknown>): ClusterSearch & { tab?: QueueTab } => ({
    cluster: str(s.cluster),
    tab: maybeOneOf(s.tab, QUEUE_TABS),
  }),
  component: function Actions() {
    const { tab, cluster } = actionsRoute.useSearch();
    return <ActionsPage tab={tab ?? 'pending'} cluster={cluster} />;
  },
});

const approvalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'actions/$proposalId',
  component: function Approval() {
    const { proposalId } = approvalRoute.useParams();
    return <ApprovalPage key={proposalId} proposalId={proposalId} />;
  },
});

const MODES = ['snapshot', 'reconstructed'] as const satisfies readonly EvalMode[];

const evalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'eval',
  validateSearch: (s: Record<string, unknown>): ClusterSearch & { mode?: EvalMode; report?: string } => ({
    cluster: str(s.cluster),
    mode: maybeOneOf(s.mode, MODES),
    report: str(s.report),
  }),
  component: function Eval() {
    const { mode, report } = evalRoute.useSearch();
    return <EvalPage mode={mode ?? 'snapshot'} reportId={report} />;
  },
});

const clustersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'clusters',
  component: ClustersPage,
});

const clusterRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'clusters/$clusterId',
  component: function Cluster() {
    const { clusterId } = clusterRoute.useParams();
    return <ClusterPage clusterId={clusterId} />;
  },
});

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'search',
  validateSearch: (s: Record<string, unknown>): ClusterSearch & { q?: string } => ({
    cluster: str(s.cluster),
    q: str(s.q),
  }),
  component: function Search() {
    const { q, cluster } = searchRoute.useSearch();
    return <SearchPage q={q ?? ''} cluster={cluster} />;
  },
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    incidentsRoute,
    incidentRoute,
    runRoute,
    rawPromptsRoute,
    actionsRoute,
    approvalRoute,
    evalRoute,
    clustersRoute,
    clusterRoute,
    searchRoute,
    promptsRoute,
    healthRoute,
    topologyRoute,
    integrationsRoute,
    packsRoute,
    policiesRoute,
    modelsRoute,
    auditRoute,
    usersRoute,
    settingsRoute,
  ]),
]);

export function makeRouter(context: RouterContext) {
  return createRouter({ routeTree, context, defaultPreload: 'intent', scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
