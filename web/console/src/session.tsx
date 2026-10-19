// 会话与权限：角色绑定决定界面能力（反馈、重跑、审批），服务端在每个请求上再次校验作用域。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Capabilities } from '@srenautix/ui';
import { createContext, useContext, type ReactNode } from 'react';
import { fetchSession, type Session } from './api';

const SessionContext = createContext<Session | null>(null);

export const SESSION_KEY = ['session'] as const;

export function useSessionQuery() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 30_000, refetchInterval: 60_000 });
}

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) {
    throw new Error('SessionProvider 缺失');
  }
  return s;
}

export function useRefreshSession(): () => Promise<void> {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SESSION_KEY });
}

export type Role = Session['roles'][number]['role'];

export function hasRole(s: Session, ...roles: Role[]): boolean {
  return s.roles.some((b) => roles.includes(b.role));
}

/** H 档审批要求 5 分钟内认证过。 */
export const REAUTH_WINDOW_MS = 5 * 60_000;

export function reauthNeeded(s: Session, now: number): boolean {
  return now - Date.parse(s.auth_time) > REAUTH_WINDOW_MS;
}

export function capabilities(s: Session, t: (id: string) => string): Capabilities {
  const write = hasRole(s, 'responder', 'approver', 'admin', 'sys-admin');
  const approve = hasRole(s, 'approver', 'admin', 'sys-admin');
  return {
    feedback: write,
    rerun: write,
    approve,
    readOnlyReason: approve ? '' : write ? t('caps.no_approve') : t('caps.read_only'),
  };
}
