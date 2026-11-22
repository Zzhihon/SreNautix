// 控制台访问中心 API：同源的 /v1，会话 cookie 由浏览器携带，改变状态的请求带 CSRF token。
// DataPort 用 @srenautix/ui 的 HTTP 实现；控制台独有的页面直接用同一个类型化客户端。

import type { HubComponents, HubOperations } from '@srenautix/contract';
import { ApiError, createHubClientFor, createHubPort, type DataPort } from '@srenautix/ui';

export type Session = HubComponents['schemas']['Session'];
export type KnowledgeCatalogItem = HubComponents['schemas']['KnowledgeCatalogItem'];
export type KnowledgeOrigin = KnowledgeCatalogItem['origin'];
export type KnowledgeKind = KnowledgeCatalogItem['kind'];
export type ListKnowledgeParams = NonNullable<HubOperations['listKnowledge']['parameters']['query']>;

let csrfToken: string | null = null;

/** 会话读取后登记 CSRF token，之后的写请求都带上它。 */
export function setCsrf(token: string | null): void {
  csrfToken = token;
}

export function getCsrf(): string | null {
  return csrfToken;
}

const opts = { baseUrl: window.location.origin, csrf: () => csrfToken };

export const hub = createHubClientFor(opts);
export const port: DataPort = createHubPort({ ...opts, actions: true });

interface Outcome {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** 非 2xx 一律抛出 ApiError；与 @srenautix/ui 的端口实现同一规则。 */
export function ok<T>(op: string, r: Outcome): T {
  if (r.error !== undefined || !r.response.ok) {
    const e = r.error as { error?: string; message?: string } | undefined;
    throw new ApiError(r.response.status, e?.error ?? 'http_error', e?.message ?? r.response.statusText, op);
  }
  return r.data as T;
}

/** 列出知识库条目（领域包内置案例 + 人工沉淀案例，GET /v1/knowledge）。 */
export async function listKnowledge(params: ListKnowledgeParams = {}): Promise<{ items: KnowledgeCatalogItem[] }> {
  return ok<{ items: KnowledgeCatalogItem[] }>(
    'listKnowledge',
    await hub.GET('/v1/knowledge', {
      params: {
        query: {
          origin: params.origin,
          kind: params.kind,
          q: params.q?.trim() || undefined,
          limit: params.limit,
        },
      },
    }),
  );
}

/** 软归档一条人工沉淀的知识案例（仅 admin，DELETE /v1/knowledge/{case_id}）。 */
export async function deleteKnowledge(caseId: string): Promise<void> {
  const r = await hub.DELETE('/v1/knowledge/{case_id}', {
    params: { path: { case_id: caseId }, header: { 'X-CSRF-Token': '' } },
  });
  if (r.error !== undefined || !r.response.ok) {
    const e = r.error as { error?: string; message?: string } | undefined;
    throw new ApiError(
      r.response.status,
      e?.error ?? 'http_error',
      e?.message ?? r.response.statusText,
      'deleteKnowledge',
    );
  }
}

/** 当前会话；未登录（401）时为 null。 */
export async function fetchSession(): Promise<Session | null> {
  const r = await hub.GET('/v1/auth/session');
  if (r.response.status === 401) {
    setCsrf(null);
    return null;
  }
  const s = ok<Session>('getSession', r);
  setCsrf(s.csrf_token);
  return s;
}

export function isApiError(e: unknown, status?: number): e is ApiError {
  return e instanceof ApiError && (status === undefined || e.status === status);
}
