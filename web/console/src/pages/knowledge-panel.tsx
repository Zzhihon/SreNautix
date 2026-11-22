// 运维知识案例库标签页：统一查看领域包内置案例与战情室人工沉淀的案例（P0-2 GET /v1/knowledge），
// 支持按来源、类型和关键词过滤，管理员可删除人工沉淀的案例；后端未升级（404/501）时优雅降级。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Button,
  displayComponent,
  EmptyState,
  ErrorBox,
  Loading,
  Mono,
  Panel,
  Segmented,
  StatusPill,
  useI18n,
} from '@srenautix/ui';
import { BookMarked, CheckCircle2, Flame, Package, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  deleteKnowledge,
  isApiError,
  listKnowledge,
  type KnowledgeCatalogItem,
  type KnowledgeKind,
  type KnowledgeOrigin,
} from '../api';
import { hasRole, useSession } from '../session';
import styles from './pages.module.css';

type OriginFilter = 'all' | KnowledgeOrigin;
type KindFilter = 'all' | KnowledgeKind;

const KNOWLEDGE_KEY = ['knowledge', 'catalog'] as const;

function KnowledgeCard({
  item,
  admin,
  confirming,
  deleting,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  item: KnowledgeCatalogItem;
  admin: boolean;
  confirming: boolean;
  deleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const { t, fmt } = useI18n();
  const isLearned = item.origin === 'learned';
  const isIncident = item.kind === 'incident';
  return (
    <article className={styles.knowledgeCard} data-origin={item.origin} data-kind={item.kind}>
      <header className={styles.knowledgeHead}>
        <div className={styles.knowledgePills}>
          <StatusPill tone={isLearned ? 'info' : 'neutral'} icon={isLearned ? BookMarked : Package}>
            {t(`knowledge.lib.origin.${item.origin}`)}
          </StatusPill>
          <StatusPill tone={isIncident ? 'warn' : 'ok'} icon={isIncident ? Flame : CheckCircle2}>
            {t(`knowledge.lib.kind.${item.kind}`)}
          </StatusPill>
        </div>
        <h3 className={styles.knowledgeTitle}>{item.title}</h3>
        {admin && isLearned && (
          <div className={styles.knowledgeActions}>
            {confirming ? (
              <>
                <Button size="sm" variant="danger" busy={deleting} onClick={onConfirmDelete}>
                  {t('knowledge.lib.delete_confirm')}
                </Button>
                <Button size="sm" variant="ghost" disabled={deleting} onClick={onCancelDelete}>
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={onAskDelete}>
                <Trash2 aria-hidden="true" width={13} height={13} />
                {t('knowledge.lib.delete')}
              </Button>
            )}
          </div>
        )}
      </header>
      <p className={styles.knowledgeBody}>{item.text}</p>
      {(item.components.length > 0 || item.alertnames.length > 0) && (
        <div className={styles.knowledgeTags}>
          {item.components.length > 0 && (
            <div className={styles.knowledgeTagGroup}>
              <span className={styles.dim}>{t('knowledge.field.components')}</span>
              {item.components.map((c) => (
                <Mono key={c} className={styles.tagChip}>
                  {displayComponent(c)}
                </Mono>
              ))}
            </div>
          )}
          {item.alertnames.length > 0 && (
            <div className={styles.knowledgeTagGroup}>
              <span className={styles.dim}>{t('knowledge.field.alerts')}</span>
              {item.alertnames.map((a) => (
                <Mono key={a} className={styles.tagChip}>
                  {a}
                </Mono>
              ))}
            </div>
          )}
        </div>
      )}
      <footer className={styles.knowledgeFoot}>
        <Mono className={styles.dim}>{item.case_id}</Mono>
        {item.incident_id && (
          <Link
            to="/incidents/$ref"
            params={{ ref: item.incident_id }}
            search={{ cluster: item.cluster_id ?? undefined }}
          >
            {t('knowledge.lib.source_incident')}
          </Link>
        )}
        {item.created_by && <span className={styles.dim}>{t('knowledge.lib.by', { who: item.created_by })}</span>}
        {item.created_at && <span className={styles.dim}>{fmt.dateTime(item.created_at)}</span>}
      </footer>
    </article>
  );
}

export function KnowledgePanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const admin = hasRole(useSession(), 'admin', 'sys-admin');
  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const isEndpointUnavailable = (err: unknown): boolean =>
    isApiError(err, 501) || (isApiError(err, 404) && err.code !== 'not_found');

  const q = useQuery({
    queryKey: [...KNOWLEDGE_KEY, origin, kind, searchText.trim()],
    queryFn: () =>
      listKnowledge({
        origin,
        kind: kind === 'all' ? undefined : kind,
        q: searchText.trim() || undefined,
        limit: 200,
      }),
    retry: (count, err) => !isEndpointUnavailable(err) && count < 1,
  });

  const del = useMutation({
    mutationFn: (caseId: string) => deleteKnowledge(caseId),
    onSuccess: async () => {
      setConfirmId(null);
      await qc.invalidateQueries({ queryKey: KNOWLEDGE_KEY });
    },
  });

  const unavailable = isEndpointUnavailable(q.error);
  const items = q.data?.items ?? [];

  return (
    <Panel
      title={t('knowledge.lib.title')}
      meta={q.data ? t('knowledge.lib.count', { n: items.length }) : t('knowledge.lib.meta')}
    >
      <div className={styles.knowledgeToolbar}>
        <Segmented
          label={t('knowledge.lib.origin_label')}
          value={origin}
          onChange={setOrigin}
          options={[
            { value: 'all', label: t('knowledge.lib.origin.all') },
            { value: 'learned', label: t('knowledge.lib.origin.learned') },
            { value: 'pack', label: t('knowledge.lib.origin.pack') },
          ]}
        />
        <Segmented
          label={t('knowledge.lib.kind_label')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('knowledge.lib.kind.all') },
            { value: 'incident', label: t('knowledge.lib.kind.incident') },
            { value: 'benign', label: t('knowledge.lib.kind.benign') },
          ]}
        />
        <label className={styles.knowledgeSearch}>
          <Search aria-hidden="true" className={styles.knowledgeSearchIcon} />
          <input
            type="search"
            aria-label={t('knowledge.lib.search')}
            placeholder={t('knowledge.lib.search_placeholder')}
            value={searchText}
            maxLength={200}
            onChange={(e) => setSearchText(e.currentTarget.value)}
          />
        </label>
      </div>

      {del.error && <ErrorBox title={t('knowledge.lib.delete_failed')} error={del.error} />}

      {q.isPending ? (
        <Loading />
      ) : unavailable ? (
        <EmptyState
          kind="not_applicable"
          title={t('knowledge.lib.unavailable_title')}
          because={t('knowledge.lib.unavailable_because')}
        />
      ) : q.error ? (
        <ErrorBox title={t('knowledge.lib.failed')} error={q.error} />
      ) : items.length === 0 ? (
        <EmptyState kind="filtered" title={t('knowledge.lib.empty_title')} because={t('knowledge.lib.empty_because')} />
      ) : (
        <div className={styles.knowledgeList}>
          {items.map((item) => (
            <KnowledgeCard
              key={item.case_id}
              item={item}
              admin={admin}
              confirming={confirmId === item.case_id}
              deleting={del.isPending && confirmId === item.case_id}
              onAskDelete={() => {
                del.reset();
                setConfirmId(item.case_id);
              }}
              onCancelDelete={() => setConfirmId(null)}
              onConfirmDelete={() => del.mutate(item.case_id)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
