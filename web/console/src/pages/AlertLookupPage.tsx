// 告警链接（ADR 0154）：/alerts?l.<标签名>=<标签值>&…。Alertmanager 等外部通知用告警的完整标签生成这个链接，
// 页面向中心查找告警所属的事件，找到后替换为事件详情页；找不到时写明原因，并给出事件收件箱的入口。

import type { HubComponents } from '@srenautix/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  EmptyState,
  ErrorBox,
  KeyValue,
  Loading,
  Mono,
  PageHeader,
  Panel,
  useI18n,
  type EmptyKind,
} from '@srenautix/ui';
import { useEffect } from 'react';
import { hub, ok } from '../api';
import { LABEL_PARAM_PREFIX } from '../search';
import styles from './pages.module.css';

type AlertLookup = HubComponents['schemas']['AlertLookup'];

const KIND: Record<Exclude<AlertLookup['outcome'], 'incident'>, EmptyKind> = {
  not_received: 'none',
  not_grouped: 'none',
  not_visible: 'forbidden',
  self_alert: 'not_applicable',
  ignored: 'not_applicable',
};

/** 事件引擎在收到告警后的下一轮把它归入事件：还没有归入时每 5 秒重查一次，归入后页面自动打开事件 */
const NOT_GROUPED_REFETCH_MS = 5_000;

function Labels({ labels, label }: { labels: Record<string, string>; label: string }) {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    <ul className={styles.stack} aria-label={label}>
      {entries.map(([k, v]) => (
        <li key={k}>
          <Mono>{`${k}="${v}"`}</Mono>
        </li>
      ))}
    </ul>
  );
}

export function AlertLookupPage({ searchStr, cluster }: { searchStr: string; cluster?: string }) {
  const { t, fmt } = useI18n();
  const navigate = useNavigate();
  // 标签按原始查询串的顺序与原文转发给中心；重复的标签由中心拒绝
  const pairs = [...new URLSearchParams(searchStr)].filter(([k]) => k.startsWith(LABEL_PARAM_PREFIX));
  const query = new URLSearchParams(pairs);
  if (cluster) {
    query.set('cluster_id', cluster);
  }
  const qs = query.toString();
  const r = useQuery({
    queryKey: ['alert-lookup', qs],
    queryFn: async () =>
      ok<AlertLookup>(
        'lookupAlert',
        await hub.GET('/v1/alerts/lookup', {
          params: { query: { labels: Object.fromEntries(pairs), cluster_id: cluster } },
          querySerializer: () => qs,
        }),
      ),
    enabled: pairs.length > 0,
    refetchInterval: (q) => (q.state.data?.outcome === 'not_grouped' ? NOT_GROUPED_REFETCH_MS : false),
  });
  const incident = r.data?.outcome === 'incident' ? r.data.incident : null;
  useEffect(() => {
    if (incident) {
      void navigate({
        to: '/incidents/$ref',
        params: { ref: incident.incident_id },
        search: { cluster, tab: 'evidence' },
        replace: true,
      });
    }
  }, [incident, cluster, navigate]);

  const inbox = (
    <Link to="/incidents" search={{ cluster }}>
      {t('alerts.open_inbox')}
    </Link>
  );
  let body;
  if (!pairs.length) {
    body = (
      <EmptyState
        kind="not_applicable"
        title={t('alerts.no_labels_title')}
        because={t('alerts.no_labels')}
        action={inbox}
      />
    );
  } else if (r.isPending || incident) {
    body = <Loading />;
  } else if (r.error) {
    body = <ErrorBox title={t('alerts.failed')} error={r.error} />;
  } else {
    const d = r.data;
    const outcome = d.outcome as Exclude<AlertLookup['outcome'], 'incident'>;
    body = (
      <>
        <EmptyState
          kind={KIND[outcome]}
          title={t(`alerts.outcome.${outcome}`)}
          because={t(`alerts.because.${outcome}`, {
            received: d.alert ? fmt.dateTime(d.alert.received_at) : '',
            status: d.alert ? t(`alerts.status.${d.alert.status}`) : '',
          })}
          action={inbox}
        />
        <KeyValue
          items={[
            {
              k: t('alerts.identity_labels'),
              v: <Labels labels={d.identity_labels} label={t('alerts.identity_labels')} />,
              id: 'identity-labels',
            },
            ...(d.excluded_labels.length
              ? [
                  {
                    k: t('alerts.excluded_labels'),
                    v: <Mono>{d.excluded_labels.join(', ')}</Mono>,
                    id: 'excluded-labels',
                  },
                ]
              : []),
            { k: t('alerts.fingerprint'), v: <Mono>{d.fingerprint}</Mono>, id: 'fingerprint' },
            ...(d.alert
              ? [
                  { k: t('alerts.alert_id'), v: <Mono>{d.alert.alert_id}</Mono>, id: 'alert-id' },
                  { k: t('alerts.starts_at'), v: fmt.dateTime(d.alert.starts_at), id: 'starts-at' },
                ]
              : []),
          ]}
        />
      </>
    );
  }
  return (
    <div className={styles.page}>
      <PageHeader title={t('alerts.title')} />
      <Panel label={t('alerts.title')}>{body}</Panel>
    </div>
  );
}
