// 全局外壳（DESIGN §12.1）：头部有集群切换、搜索、语言、主题与用户；头部下方是不可关闭的状态条；
// 左侧导航精简为 3 个核心视图（事件收件箱、拓扑与地图、知识与评测），并将次级运维、平台配置与治理入口收纳在可折叠的
// 「系统与调试」抽屉内，同时保留全部既有 URL 路由可直达。本地管理员作为紧急入口登录时显示横幅。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { ConditionStrip, ErrorBoundary, useConditions, useI18n, type Cluster } from '@srenautix/ui';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Inbox,
  LogOut,
  Menu,
  Network,
  Search,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { hub, ok } from '../api';
import { setPrefs, usePrefs, type ThemePref } from '../prefs';
import { useNow } from '../now';
import { SESSION_KEY, useSession } from '../session';
import styles from './Shell.module.css';

interface PrimaryNavItem {
  to: '/incidents' | '/topology' | '/eval';
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}

interface NavItem {
  to: string;
  label: string;
}

const SECONDARY_PREFIXES = [
  '/actions',
  '/health',
  '/clusters',
  '/integrations',
  '/packs',
  '/policies',
  '/models',
  '/audit',
  '/users',
  '/settings',
] as const;

/** 判断当前路径是否属于折叠「系统与调试」抽屉内的次级页面；纯函数，便于单测。 */
export function isSecondaryRoute(pathname: string): boolean {
  return SECONDARY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** 计算三个核心视图的激活态（事件详情、研判运行、告警查找归入事件收件箱）。 */
export function isPrimaryNavActive(to: '/incidents' | '/topology' | '/eval', pathname: string): boolean {
  if (to === '/incidents') {
    return (
      pathname === '/' ||
      pathname === '/incidents' ||
      pathname.startsWith('/incidents/') ||
      pathname.startsWith('/runs/') ||
      pathname === '/alerts'
    );
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** 集群列表的查询选项；Shell 与 router 共用同一份缓存，避免重复定义请求。 */
export const clustersQuery = {
  queryKey: ['clusters'],
  queryFn: async () => ok<Cluster[]>('listClusters', await hub.GET('/v1/clusters')),
  refetchInterval: 60_000,
};

export function useClusters() {
  return useQuery(clustersQuery);
}

/**
 * 只有一个集群时，页面与集群选择器默认选中它；多集群或未加载时保持「全部集群」。
 * URL 上显式选择的集群始终优先，避免覆盖用户分享的链接。纯函数，便于单测。
 */
export function resolveCluster(
  clusters: readonly { cluster_id: string }[] | undefined,
  current: string | undefined,
): string | undefined {
  if (current) return current;
  return clusters?.length === 1 ? clusters[0]!.cluster_id : undefined;
}

function Nav({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const { t } = useI18n();
  const inSecondary = isSecondaryRoute(pathname);
  const [systemOpen, setSystemOpen] = useState(inSecondary);

  // 通过深链或搜索跳转到次级页面时自动展开「系统与调试」，让用户立刻看到当前所在位置
  useEffect(() => {
    if (inSecondary) {
      setSystemOpen(true);
    }
  }, [inSecondary]);

  const primary: PrimaryNavItem[] = [
    { to: '/incidents', label: t('nav.incidents'), Icon: Inbox },
    { to: '/topology', label: t('nav.topology'), Icon: Network },
    { to: '/eval', label: t('nav.eval'), Icon: BookOpen },
  ];

  const secondaryGroups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: t('nav.sub.ops'),
      items: [
        { to: '/actions', label: t('nav.actions') },
        { to: '/health', label: t('nav.health') },
        { to: '/clusters', label: t('nav.clusters') },
      ],
    },
    {
      label: t('nav.sub.platform'),
      items: [
        { to: '/integrations', label: t('nav.integrations') },
        { to: '/packs', label: t('nav.packs') },
        { to: '/policies', label: t('nav.policies') },
        { to: '/models', label: t('nav.models') },
      ],
    },
    {
      label: t('nav.sub.governance'),
      items: [
        { to: '/audit', label: t('nav.audit') },
        { to: '/users', label: t('nav.users') },
        { to: '/settings', label: t('nav.settings') },
      ],
    },
  ];

  return (
    <nav className={styles.nav} aria-label={t('nav.label')}>
      <ul className={styles.primaryList}>
        {primary.map(({ to, label, Icon }) => {
          const active = isPrimaryNavActive(to, pathname);
          return (
            <li key={to}>
              <Link
                to={to}
                search={(prev: { cluster?: string }) => ({ cluster: prev.cluster })}
                className={
                  active
                    ? `${styles.navLink} ${styles.primaryLink} ${styles.navActive}`
                    : `${styles.navLink} ${styles.primaryLink}`
                }
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
              >
                <Icon aria-hidden="true" className={styles.navIcon} />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className={styles.drawerWrap}>
        <button
          type="button"
          className={inSecondary ? `${styles.drawerToggle} ${styles.drawerToggleActive}` : styles.drawerToggle}
          aria-expanded={systemOpen}
          aria-controls="nav-system-drawer"
          onClick={() => setSystemOpen((o) => !o)}
        >
          <SlidersHorizontal aria-hidden="true" className={styles.navIcon} />
          <span className={styles.drawerLabel}>{t('nav.system_drawer')}</span>
          {systemOpen ? (
            <ChevronDown aria-hidden="true" className={styles.chevron} />
          ) : (
            <ChevronRight aria-hidden="true" className={styles.chevron} />
          )}
        </button>

        {systemOpen && (
          <div id="nav-system-drawer" className={styles.drawerBody}>
            {secondaryGroups.map((g) => (
              <div key={g.label} className={styles.navGroup}>
                <div className={styles.navGroupLabel}>{g.label}</div>
                <ul>
                  {g.items.map((i) => (
                    <li key={i.to}>
                      <Link
                        to={i.to}
                        search={(prev: { cluster?: string }) => ({ cluster: prev.cluster })}
                        className={`${styles.navLink} ${styles.secondaryLink}`}
                        activeProps={{
                          'aria-current': 'page',
                          className: `${styles.navLink} ${styles.secondaryLink} ${styles.navActive}`,
                        }}
                        onClick={onNavigate}
                      >
                        {i.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function SearchBox() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) {
      void navigate({
        to: '/search',
        search: (prev: { cluster?: string }) => ({ cluster: prev.cluster, q: q.trim() }),
      });
    }
  };
  return (
    <form role="search" className={styles.search} onSubmit={submit}>
      <Search aria-hidden="true" className={styles.searchIcon} />
      <input
        type="search"
        aria-label={t('header.search')}
        placeholder={t('header.search_placeholder')}
        value={q}
        maxLength={200}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
    </form>
  );
}

export function Shell() {
  const { t } = useI18n();
  const session = useSession();
  const prefs = usePrefs();
  const now = useNow(30_000);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { cluster?: string };
  const clusters = useClusters();
  // 单集群时默认选中它（不把「全部集群」当默认）；显式 URL 参数优先
  const activeCluster = resolveCluster(clusters.data, search.cluster);
  const conditions = useConditions(search.cluster);
  const [menu, setMenu] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const proposalOnly = (clusters.data ?? []).filter(
    (c) => c.proposal_only && (!search.cluster || c.cluster_id === search.cluster),
  );

  const logout = async () => {
    ok('logout', await hub.POST('/v1/auth/logout', { params: { header: { 'X-CSRF-Token': '' } } }));
    qc.clear();
    await qc.invalidateQueries({ queryKey: SESSION_KEY });
    await navigate({ to: '/login', search: { return_to: undefined } });
  };

  return (
    <div className={styles.app}>
      {/* 全局组件各自一层错误边界：任何一个渲染出错只影响它自己（例如状态条遇到不认识的数据） */}
      <ErrorBoundary area="Header">
        <header className={styles.header}>
          <button
            type="button"
            className={styles.menuBtn}
            aria-label={t('header.menu')}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu aria-hidden="true" />
          </button>
          <Link to="/incidents" search={{ cluster: search.cluster }} className={styles.brand}>
            SreNautix
          </Link>
          <label className={styles.cluster}>
            <span className={styles.srOnly}>{t('header.cluster')}</span>
            <select
              aria-label={t('header.cluster')}
              value={activeCluster ?? ''}
              onChange={(e) =>
                void navigate({
                  to: pathname,
                  search: (prev: Record<string, unknown>) => ({ ...prev, cluster: e.currentTarget.value || undefined }),
                })
              }
            >
              {clusters.data?.length !== 1 && <option value="">{t('header.all_clusters')}</option>}
              {(clusters.data ?? []).map((c) => (
                <option key={c.cluster_id} value={c.cluster_id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          <SearchBox />
          <span className={styles.spacer} />
          <select
            aria-label={t('header.locale')}
            value={prefs.locale}
            onChange={(e) => setPrefs({ locale: e.currentTarget.value as 'zh-CN' | 'en' })}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
          <select
            aria-label={t('header.theme')}
            value={prefs.theme}
            onChange={(e) => setPrefs({ theme: e.currentTarget.value as ThemePref })}
          >
            <option value="system">{t('header.theme_system')}</option>
            <option value="light">{t('header.theme_light')}</option>
            <option value="dark">{t('header.theme_dark')}</option>
          </select>
          <span className={styles.user} title={session.roles.map((r) => r.role).join(', ')}>
            {session.principal.display_name || session.principal.id}
          </span>
          <button type="button" className={styles.logout} onClick={() => void logout()} aria-label={t('header.logout')}>
            <LogOut aria-hidden="true" />
          </button>
        </header>
      </ErrorBoundary>
      <ErrorBoundary area="ConditionStrip" resetKeys={[conditions.dataUpdatedAt]}>
        <ConditionStrip
          conditions={conditions.data}
          checkedAt={conditions.dataUpdatedAt || null}
          now={now}
          error={conditions.error ?? undefined}
          proposalOnly={proposalOnly.map((c) => c.display_name)}
        />
      </ErrorBoundary>
      <ErrorBoundary area="Banners" resetKeys={[clusters.dataUpdatedAt]}>
        {session.break_glass && (
          <div className={styles.breakGlass} role="alert">
            <ShieldAlert aria-hidden="true" />
            {t('header.break_glass')}
          </div>
        )}
      </ErrorBoundary>
      <div className={styles.body}>
        <div className={styles.navWrap} data-open={menu ? '' : undefined}>
          <ErrorBoundary area="Nav">
            <Nav pathname={pathname} onNavigate={() => setMenu(false)} />
          </ErrorBoundary>
        </div>
        <main className={styles.main} id="main">
          <ErrorBoundary area="Page" resetKeys={[pathname]}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
