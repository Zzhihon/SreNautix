// 全局搜索：事件、组件、提议。

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EmptyState, ErrorBox, Loading, Mono, PageHeader, Panel, useI18n, type SearchHit } from '@srenautix/ui';
import { hub, ok } from '../api';
import styles from './pages.module.css';

function HitLink({ h, cluster }: { h: SearchHit; cluster?: string }) {
  switch (h.kind) {
    case 'incident':
      return (
        <Link to="/incidents/$ref" params={{ ref: h.id }} search={{ cluster, tab: 'evidence' }}>
          {h.title}
        </Link>
      );
    case 'proposal':
      return (
        <Link to="/actions/$proposalId" params={{ proposalId: h.id }} search={{ cluster }}>
          {h.title}
        </Link>
      );
    case 'component':
      return (
        <Link to="/incidents" search={{ cluster: h.cluster_id, state: 'all', feedback: 'all', suppressed: false }}>
          {h.title}
        </Link>
      );
  }
}

export function SearchPage({ q, cluster }: { q: string; cluster?: string }) {
  const { t } = useI18n();
  const r = useQuery({
    queryKey: ['search', q],
    queryFn: async () =>
      ok<SearchHit[]>('search', await hub.GET('/v1/search', { params: { query: { q, limit: 50 } } })),
    enabled: q.length > 0,
  });
  const hits = (r.data ?? []).filter((h) => !cluster || h.cluster_id === cluster);
  return (
    <div className={styles.page}>
      <PageHeader title={t('search.title', { q })} />
      <Panel>
        {!q ? (
          <EmptyState kind="not_applicable" title={t('search.no_query_title')} because={t('search.no_query')} />
        ) : r.isPending ? (
          <Loading />
        ) : r.error ? (
          <ErrorBox title={t('search.failed')} error={r.error} />
        ) : hits.length === 0 ? (
          <EmptyState
            kind={cluster ? 'filtered' : 'none'}
            title={t('search.empty_title')}
            because={cluster ? t('search.empty_cluster', { cluster }) : t('search.empty')}
          />
        ) : (
          <ul className={styles.hits}>
            {hits.map((h) => (
              <li key={`${h.kind}/${h.id}`}>
                <span className={styles.hitKind}>{t(`search.kind.${h.kind}`)}</span>
                <HitLink h={h} cluster={cluster} />
                <Mono className={styles.dim}>{h.cluster_id}</Mono>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
