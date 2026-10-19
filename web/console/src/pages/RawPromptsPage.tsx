// 研判的提示词：默认是脱敏后的内容（全部角色），raw 为脱敏前的原文（只对 auditor 与 admin，
// 每次读取都写入治理审计，由服务端执行）。内容一律作为文本显示。

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { HubOperations } from '@srenautix/contract';
import { EmptyState, ErrorBox, Loading, Mono, PageHeader, Panel, useI18n } from '@srenautix/ui';
import { hub, isApiError, ok } from '../api';
import styles from './pages.module.css';

type Redacted = HubOperations['getRedactedPrompts']['responses'][200]['content']['application/json'];
type Raw = HubOperations['getRawPrompts']['responses'][200]['content']['application/json'];

export function PromptsPage({ runId, raw }: { runId: string; raw: boolean }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['run', runId, raw ? 'prompt-raw' : 'prompts'],
    queryFn: async (): Promise<Array<Raw[number] & { redaction_hits?: number }>> =>
      raw
        ? ok<Raw>(
            'getRawPrompts',
            await hub.GET('/v1/runs/{run_id}/prompt/raw', { params: { path: { run_id: runId } } }),
          )
        : ok<Redacted>(
            'getRedactedPrompts',
            await hub.GET('/v1/runs/{run_id}/prompts', { params: { path: { run_id: runId } } }),
          ),
  });
  return (
    <div className={styles.page}>
      <PageHeader
        title={raw ? t('raw.title') : t('prompts.title')}
        meta={
          <>
            <Mono>{runId}</Mono> ·{' '}
            <Link to="/runs/$runId" params={{ runId }}>
              {t('prompts.back')}
            </Link>
          </>
        }
      />
      {raw && <p className={styles.warn}>{t('raw.audited')}</p>}
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        isApiError(q.error, 404) ? (
          <EmptyState
            kind="not_applicable"
            title={t('raw.none_title')}
            because={raw ? t('raw.none_because') : t('prompts.none_because')}
          />
        ) : isApiError(q.error, 403) ? (
          <EmptyState kind="forbidden" title={t('raw.forbidden_title')} because={t('raw.forbidden_because')} />
        ) : (
          <ErrorBox title={t('raw.failed')} error={q.error} />
        )
      ) : q.data.length === 0 ? (
        <EmptyState kind="none" title={t('run.no_llm_title')} because={t('prompts.no_calls')} />
      ) : (
        q.data.map((p) => (
          <Panel
            key={p.seq}
            id={`call-${p.seq}`}
            title={`#${p.seq} · ${p.phase}`}
            meta={p.redaction_hits === undefined ? undefined : t('run.redaction_hits', { n: p.redaction_hits })}
          >
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
