// 原始提示词（只对 auditor 与 admin）：每次读取都写入治理审计（服务端执行）。内容一律作为文本显示。

import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorBox, Loading, Mono, PageHeader, Panel, useI18n, type RawPrompt } from '@srenautix/ui';
import { hub, isApiError, ok } from '../api';
import styles from './pages.module.css';

export function RawPromptsPage({ runId }: { runId: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['run', runId, 'prompt-raw'],
    queryFn: async () =>
      ok<RawPrompt[]>(
        'getRawPrompts',
        await hub.GET('/v1/runs/{run_id}/prompt/raw', { params: { path: { run_id: runId } } }),
      ),
  });
  return (
    <div className={styles.page}>
      <PageHeader title={t('raw.title')} meta={<Mono>{runId}</Mono>} />
      <p className={styles.warn}>{t('raw.audited')}</p>
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        isApiError(q.error, 404) ? (
          <EmptyState kind="not_applicable" title={t('raw.none_title')} because={t('raw.none_because')} />
        ) : isApiError(q.error, 403) ? (
          <EmptyState kind="forbidden" title={t('raw.forbidden_title')} because={t('raw.forbidden_because')} />
        ) : (
          <ErrorBox title={t('raw.failed')} error={q.error} />
        )
      ) : (
        q.data.map((p) => (
          <Panel key={p.seq} id={`call-${p.seq}`} title={`#${p.seq} · ${p.phase}`}>
            {p.messages.map((m, i) => (
              <div key={i} className={styles.message}>
                <div className={styles.messageRole}>{m.role}</div>
                <pre className={styles.pre}>{m.content}</pre>
              </div>
            ))}
          </Panel>
        ))
      )}
    </div>
  );
}
