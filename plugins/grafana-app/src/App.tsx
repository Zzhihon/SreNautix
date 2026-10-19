// 插件外壳：把 GrafanaTheme2 映射成设计令牌，按 Grafana 用户的语言与时区渲染 @srenautix/ui 的
// 收件箱、事件详情与研判运行明细。数据经插件后端转发到中心（只读与反馈）；"批准"打开控制台的审批页。
// 页面状态（过滤条件、标签页）放在 Grafana 的 URL 查询参数里。

import type { AppRootProps } from '@grafana/data';
import { config, locationService } from '@grafana/runtime';
import { useTheme2 } from '@grafana/ui';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  ConditionStrip,
  DEFAULT_INBOX_FILTERS,
  EmptyState,
  I18nProvider,
  IncidentView,
  InboxView,
  RunView,
  ThemeRoot,
  UiEnvProvider,
  createHubPort,
  useConditions,
  useI18n,
  type IncidentTab,
  type InboxFilters,
  type LinkProps,
  type Links,
  type Locale,
  type UiEnv,
} from '@srenautix/ui';
import { tokensFromGrafana } from '@srenautix/ui/grafana';
import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { PLUGIN_MESSAGES } from './messages';

export interface AppSettings {
  hubUrl?: string;
  /** 控制台的外部地址，审批跳转到 <consoleUrl>/actions/<id>。 */
  consoleUrl?: string;
}

export const PLUGIN_ID = 'srenautix-console-app';
const RESOURCES = `/api/plugins/${PLUGIN_ID}/resources`;

function locale(): Locale {
  return (config.bootData.user.language ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function timeZone(): string {
  const tz = config.bootData.user.timezone;
  if (!tz || tz === 'browser') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return tz === 'utc' ? 'UTC' : tz;
}

function useLocation() {
  const history = locationService.getHistory();
  return useSyncExternalStore(
    (cb) => history.listen(cb),
    () => `${history.location.pathname}${history.location.search}`,
  );
}

function GrafanaLink({ href, className, children, title, ...rest }: LinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    locationService.push(href);
  };
  return (
    <a href={href} className={className} title={title} aria-label={rest['aria-label']} onClick={onClick}>
      {children}
    </a>
  );
}

/** 插件没有事件流的 SSE 通道（插件后端不代理长连接），每 15 秒对账一次。 */
function usePolling(qc: ReturnType<typeof useQueryClient>) {
  useEffect(() => {
    const id = window.setInterval(() => void qc.invalidateQueries(), 15_000);
    return () => window.clearInterval(id);
  }, [qc]);
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

const TABS: readonly IncidentTab[] = ['evidence', 'hypotheses', 'timeline', 'runs'];

function Pages({ base }: { base: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  usePolling(qc);
  const now = useNow(15_000);
  const loc = useLocation();
  const url = new URL(loc, window.location.origin);
  const rest = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : '';
  const params = url.searchParams;
  const conditions = useConditions(params.get('cluster') ?? undefined);
  const set = (next: Record<string, string | undefined>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) {
        sp.delete(k);
      } else {
        sp.set(k, v);
      }
    }
    locationService.push(`${url.pathname}?${sp.toString()}`);
  };

  let page;
  const incident = rest.match(/^\/incidents\/([^/]+)$/);
  const run = rest.match(/^\/runs\/([^/]+)$/);
  if (incident) {
    const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
      ? (params.get('tab') as IncidentTab)
      : 'evidence';
    page = (
      <IncidentView
        key={incident[1]}
        incidentRef={decodeURIComponent(incident[1]!)}
        tab={tab}
        onTab={(v) => set({ tab: v })}
        now={now}
      />
    );
  } else if (run) {
    page = <RunView runId={decodeURIComponent(run[1]!)} now={now} promptHref={() => null} />;
  } else if (rest === '' || rest === '/' || rest === '/incidents') {
    const filters: InboxFilters = {
      state: (params.get('state') as InboxFilters['state']) ?? DEFAULT_INBOX_FILTERS.state,
      feedback: (params.get('feedback') as InboxFilters['feedback']) ?? DEFAULT_INBOX_FILTERS.feedback,
      severity: (params.get('severity') as InboxFilters['severity']) ?? undefined,
      disposition: (params.get('disposition') as InboxFilters['disposition']) ?? undefined,
      suppressed: params.get('suppressed') === 'true',
    };
    page = (
      <InboxView
        cluster={params.get('cluster') ?? undefined}
        filters={filters}
        now={now}
        onFilters={(f) =>
          set({
            state: f.state,
            feedback: f.feedback,
            severity: f.severity,
            disposition: f.disposition,
            suppressed: f.suppressed ? 'true' : undefined,
          })
        }
      />
    );
  } else {
    page = (
      <EmptyState
        kind="not_applicable"
        title={t('plugin.not_found_title')}
        because={t('plugin.not_found', { path: rest })}
      />
    );
  }
  return (
    <>
      <ConditionStrip
        conditions={conditions.data}
        checkedAt={conditions.dataUpdatedAt || null}
        now={now}
        error={conditions.error ?? undefined}
      />
      <div style={{ paddingTop: 12 }}>{page}</div>
    </>
  );
}

function Unconfigured() {
  const { t } = useI18n();
  return <EmptyState kind="not_configured" title={t('plugin.unconfigured_title')} because={t('plugin.unconfigured')} />;
}

export default function App(props: AppRootProps<AppSettings>) {
  const theme = useTheme2();
  const tokens = useMemo(() => tokensFromGrafana(theme), [theme]);
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } }));
  const settings = props.meta.jsonData ?? {};
  const base = props.basename;
  const consoleUrl = (settings.consoleUrl ?? '').replace(/\/$/, '');
  const env = useMemo<UiEnv>(() => {
    const links: Links = {
      inbox: () => `${base}/incidents`,
      incident: (ref, tab) => `${base}/incidents/${encodeURIComponent(ref)}${tab ? `?tab=${tab}` : ''}`,
      run: (id) => `${base}/runs/${id}`,
      approval: (id) => `${consoleUrl}/actions/${id}`,
      approvalExternal: true,
    };
    return {
      port: createHubPort({
        baseUrl: `${window.location.origin}${config.appSubUrl}${RESOURCES}`,
        csrf: () => null,
        actions: false,
      }),
      links,
      caps: { feedback: true, rerun: false, approve: false, readOnlyReason: '' },
      Link: GrafanaLink,
    };
  }, [base, consoleUrl]);
  return (
    <ThemeRoot tokens={tokens}>
      <I18nProvider locale={locale()} timeZone={timeZone()} extra={PLUGIN_MESSAGES}>
        <QueryClientProvider client={qc}>
          <UiEnvProvider env={env}>
            {settings.hubUrl && consoleUrl ? <Pages base={base} /> : <Unconfigured />}
          </UiEnvProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeRoot>
  );
}
