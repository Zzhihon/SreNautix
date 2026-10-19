// 全局外壳（DESIGN §12.1）：头部有集群切换、搜索、语言、主题与用户；头部下方是不可关闭的状态条；
// 左侧导航按值班、处置、度量、系统、治理分组。本地管理员作为紧急入口登录时显示横幅。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { ConditionStrip, StatusPill, STATUS, useConditions, useI18n, type Cluster } from '@srenautix/ui';
import { LogOut, Menu, Search, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { hub, ok } from '../api';
import { setPrefs, usePrefs, type ThemePref } from '../prefs';
import { useNow } from '../now';
import { SESSION_KEY, useSession } from '../session';
import styles from './Shell.module.css';

interface NavItem {
  to: string;
  label: string;
}

export function useClusters() {
  return useQuery({
    queryKey: ['clusters'],
    queryFn: async () => ok<Cluster[]>('listClusters', await hub.GET('/v1/clusters')),
    refetchInterval: 60_000,
  });
}

function Nav({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useI18n();
  const groups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: t('nav.group.oncall'),
      items: [{ to: '/incidents', label: t('nav.incidents') }],
    },
    { label: t('nav.group.remediation'), items: [{ to: '/actions', label: t('nav.actions') }] },
    {
      label: t('nav.group.measure'),
      items: [
        { to: '/eval', label: t('nav.eval') },
        { to: '/health', label: t('nav.health') },
      ],
    },
    {
      label: t('nav.group.system'),
      items: [
        { to: '/topology', label: t('nav.topology') },
        { to: '/clusters', label: t('nav.clusters') },
        { to: '/integrations', label: t('nav.integrations') },
        { to: '/packs', label: t('nav.packs') },
        { to: '/policies', label: t('nav.policies') },
        { to: '/models', label: t('nav.models') },
      ],
    },
    {
      label: t('nav.group.governance'),
      items: [
        { to: '/audit', label: t('nav.audit') },
        { to: '/users', label: t('nav.users') },
        { to: '/settings', label: t('nav.settings') },
      ],
    },
  ];
  return (
    <nav className={styles.nav} aria-label={t('nav.label')}>
      {groups.map((g) => (
        <div key={g.label} className={styles.navGroup}>
          <div className={styles.navGroupLabel}>{g.label}</div>
          <ul>
            {g.items.map((i) => (
              <li key={i.to}>
                <Link
                  to={i.to}
                  search={(prev: { cluster?: string }) => ({ cluster: prev.cluster })}
                  className={styles.navLink}
                  activeProps={{ 'aria-current': 'page', className: `${styles.navLink} ${styles.navActive}` }}
                  onClick={onNavigate}
                >
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
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
            value={search.cluster ?? ''}
            onChange={(e) =>
              void navigate({
                to: pathname,
                search: (prev: Record<string, unknown>) => ({ ...prev, cluster: e.currentTarget.value || undefined }),
              })
            }
          >
            <option value="">{t('header.all_clusters')}</option>
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
      <ConditionStrip
        conditions={conditions.data}
        checkedAt={conditions.dataUpdatedAt || null}
        now={now}
        error={conditions.error ?? undefined}
      />
      {proposalOnly.length > 0 && (
        <div className={styles.proposalOnly} role="alert">
          {proposalOnly.map((c) => (
            <StatusPill key={c.cluster_id} tone="bad" icon={STATUS.condition.frozen.icon} strong>
              {t('header.proposal_only', { cluster: c.display_name })}
            </StatusPill>
          ))}
        </div>
      )}
      {session.break_glass && (
        <div className={styles.breakGlass} role="alert">
          <ShieldAlert aria-hidden="true" />
          {t('header.break_glass')}
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.navWrap} data-open={menu ? '' : undefined}>
          <Nav onNavigate={() => setMenu(false)} />
        </div>
        <main className={styles.main} id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
