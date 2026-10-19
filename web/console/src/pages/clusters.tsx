// 集群（DESIGN §12.2）：reader 与 gateway 的连接状态、版本、准入自检、熔断开关、informer 新鲜度。
// 自检未通过、gateway 未部署或冻结的集群在所有页面显示红色的"仅提议"（外壳负责）。

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ConditionStrip,
  EmptyState,
  ErrorBox,
  KeyValue,
  Loading,
  Mono,
  PageHeader,
  Panel,
  StatusPill,
  STATUS,
  useI18n,
  type Cluster,
  type SpokeStatus,
} from '@srenautix/ui';
import { CheckCircle2, PlugZap, Unplug } from 'lucide-react';
import { hub, ok } from '../api';
import { useNow } from '../now';
import { useClusters } from '../shell/Shell';
import styles from './pages.module.css';

function Spoke({ s, role, now }: { s: SpokeStatus | null; role: 'reader' | 'gateway'; now: number }) {
  const { t, fmt } = useI18n();
  if (!s) {
    return (
      <StatusPill tone="nodata" icon={PlugZap}>
        {t('clusters.not_deployed', { role })}
      </StatusPill>
    );
  }
  return (
    <span className={styles.stack}>
      {s.connected ? (
        <StatusPill tone="ok" icon={CheckCircle2}>
          {t('clusters.connected', { role })}
        </StatusPill>
      ) : (
        <StatusPill tone="bad" icon={Unplug}>
          {t('clusters.disconnected', { role })}
        </StatusPill>
      )}
      <span className={styles.dim}>
        {s.version ?? t('common.unknown')} ·{' '}
        {s.last_seen_at ? t('clusters.seen', { ago: fmt.relative(s.last_seen_at, now) }) : t('clusters.never_seen')}
      </span>
      {role === 'gateway' && s.admission_selfcheck && (
        <StatusPill
          tone={s.admission_selfcheck === 'passed' ? 'ok' : s.admission_selfcheck === 'failed' ? 'bad' : 'nodata'}
          icon={s.admission_selfcheck === 'passed' ? STATUS.condition.ok.icon : STATUS.condition.critical.icon}
        >
          {t(`clusters.selfcheck.${s.admission_selfcheck}`)}
        </StatusPill>
      )}
    </span>
  );
}

function ClusterCard({ c, now }: { c: Cluster; now: number }) {
  const { t, fmt } = useI18n();
  return (
    <Panel
      title={
        <Link to="/clusters/$clusterId" params={{ clusterId: c.cluster_id }}>
          {c.display_name}
        </Link>
      }
      meta={<Mono>{c.cluster_id}</Mono>}
      actions={
        c.proposal_only ? (
          <StatusPill tone="bad" icon={STATUS.condition.frozen.icon} strong>
            {t('clusters.proposal_only')}
          </StatusPill>
        ) : undefined
      }
    >
      <KeyValue
        items={[
          { k: 'reader', v: <Spoke s={c.reader} role="reader" now={now} /> },
          { k: 'gateway', v: <Spoke s={c.gateway} role="gateway" now={now} /> },
          {
            k: t('clusters.freeze'),
            tone: c.freeze.frozen ? 'bad' : undefined,
            v: `${c.freeze.frozen ? t('clusters.frozen') : t('clusters.not_frozen')} · ${t('clusters.observed', { ago: fmt.relative(c.freeze.observed_at, now) })}`,
          },
          {
            k: t('clusters.informer'),
            v: c.informer_synced_at
              ? t('clusters.synced', { ago: fmt.relative(c.informer_synced_at, now) })
              : t('clusters.never_synced'),
          },
          {
            k: t('clusters.conditions'),
            v: t('clusters.active_conditions', { n: c.conditions.filter((x) => x.status === 'true').length }),
          },
        ]}
      />
    </Panel>
  );
}

export function ClustersPage() {
  const { t } = useI18n();
  const now = useNow(15_000);
  const q = useClusters();
  return (
    <div className={styles.page}>
      <PageHeader title={t('clusters.title')} />
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox title={t('clusters.failed')} error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyState kind="not_configured" title={t('clusters.empty_title')} because={t('clusters.empty_because')} />
      ) : (
        <div className={styles.grid}>
          {q.data.map((c) => (
            <ClusterCard key={c.cluster_id} c={c} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ClusterPage({ clusterId }: { clusterId: string }) {
  const { t } = useI18n();
  const now = useNow(15_000);
  const q = useQuery({
    queryKey: ['clusters', clusterId],
    queryFn: async () =>
      ok<Cluster>(
        'getCluster',
        await hub.GET('/v1/clusters/{cluster_id}', { params: { path: { cluster_id: clusterId } } }),
      ),
    refetchInterval: 30_000,
  });
  return (
    <div className={styles.page}>
      <PageHeader title={t('clusters.detail', { id: clusterId })} />
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox title={t('clusters.failed')} error={q.error} />
      ) : (
        <>
          <ClusterCard c={q.data} now={now} />
          <Panel title={t('clusters.conditions')}>
            <ConditionStrip conditions={q.data.conditions} checkedAt={q.dataUpdatedAt} now={now} />
          </Panel>
        </>
      )}
    </div>
  );
}
