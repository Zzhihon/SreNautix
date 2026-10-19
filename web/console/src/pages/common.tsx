// 页面共用的小件：按查询状态渲染（加载、错误、403 写明需要的角色），Git 来源与漂移。

import type { UseQueryResult } from '@tanstack/react-query';
import { EmptyState, ErrorBox, Loading, Mono, StatusPill, useI18n } from '@srenautix/ui';
import { GitBranch, GitCompare } from 'lucide-react';
import type { ReactNode } from 'react';
import { isApiError } from '../api';

/** 查询结果的统一外壳：加载中、403（写明需要的角色）、其他错误、有数据。 */
export function Loaded<T>({
  q,
  what,
  roles,
  children,
}: {
  q: UseQueryResult<T>;
  /** 读取失败时的标题，例如"读取集成失败"。 */
  what: string;
  /** 这个接口允许的角色，403 时写进说明。 */
  roles: string;
  children: (data: T) => ReactNode;
}) {
  const { t } = useI18n();
  if (q.isPending) {
    return <Loading />;
  }
  if (q.error) {
    return isApiError(q.error, 403) ? (
      <EmptyState kind="forbidden" title={t('common.forbidden_title')} because={t('common.forbidden', { roles })} />
    ) : (
      <ErrorBox title={what} error={q.error} />
    );
  }
  return <>{children(q.data as T)}</>;
}

/** 来自 Git 的配置：仓库、SHA 与漂移（DESIGN §12.3）。 */
export function GitSource({
  repo,
  sha,
  drift,
}: {
  repo: string;
  sha: string;
  drift?: { in_sync: boolean; live_sha: string | null; detail: string | null };
}) {
  const { t } = useI18n();
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <GitBranch aria-hidden="true" width={14} height={14} />
      <Mono>{repo}</Mono>
      <Mono>{sha.slice(0, 12)}</Mono>
      {drift &&
        (drift.in_sync ? (
          <StatusPill tone="ok" icon={GitCompare}>
            {t('git.in_sync')}
          </StatusPill>
        ) : (
          <StatusPill tone="bad" icon={GitCompare} title={drift.detail ?? undefined}>
            {t('git.drift', { live: drift.live_sha ? drift.live_sha.slice(0, 12) : '-' })}
          </StatusPill>
        ))}
    </span>
  );
}

export const ROLES_ALL = 'viewer、responder、approver、auditor、admin';
export const ROLES_AUDIT = 'auditor、admin';
export const ROLES_ADMIN = 'admin';
