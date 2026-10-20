// DataPort 的 HTTP 实现：openapi-fetch 客户端（createHubClient）调用中心 API。独立控制台与 Grafana 插件
// 共用这一份实现，区别只在 baseUrl：控制台直接访问中心，插件经插件后端的资源路径转发（只读与反馈）。
// 非 2xx 一律抛出 ApiError，保留状态码与契约错误码。

import type { HubPaths } from '@srenautix/contract';
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { Proposal } from './contract';
import { ApiError, type ActionPort, type DataPort } from './port';
import { RequestGuard, type RequestGuardOptions } from './requestGuard';

// 只引用契约的类型：@srenautix/contract 的运行时入口带着全部 JSON Schema 与 Ajv，浏览器端不需要
type HubClient = Client<HubPaths>;

interface Outcome {
  data?: unknown;
  error?: unknown;
  response: Response;
}

// openapi-fetch 的响应类型把 JSON Schema 的元组（例如序列点 [unix 秒, 值]）展开成普通数组，
// 与 HubOperations 的类型不完全相同；运行时是同一份 JSON，这里按端口声明的类型返回。
function unwrap<T>(op: string, r: Outcome): T {
  if (r.error !== undefined || !r.response.ok) {
    const e = r.error as { error?: string; message?: string } | undefined;
    throw new ApiError(r.response.status, e?.error ?? 'http_error', e?.message ?? r.response.statusText, op);
  }
  if (r.data === undefined) {
    throw new ApiError(r.response.status, 'empty_body', '响应没有内容', op);
  }
  return r.data as T;
}

/** 404 映射为 null 的读取（阶段 A 报告、研判清单在生成之前不存在）。 */
function unwrapOrNull<T>(op: string, r: Outcome): T | null {
  if (r.response.status === 404) {
    return null;
  }
  return unwrap(op, r);
}

export interface HubPortOptions {
  /** 中心 API 的根地址（不含 /v1）。 */
  baseUrl: string;
  /** 会话认证时的 CSRF token；返回 null 时不带请求头（插件后端用 Bearer 转发）。 */
  csrf: () => string | null;
  /** 是否提供写操作（审批、拒绝、撤销、重新研判、实时重跑）。Grafana 插件为 false。 */
  actions: boolean;
  fetch?: typeof globalThis.fetch;
  /** 读请求的兜底防护（同一 URL 串行、时间窗内限次）；默认 DEFAULT_REQUEST_GUARD。 */
  guard?: RequestGuardOptions;
}

export function createHubClientFor(o: Pick<HubPortOptions, 'baseUrl' | 'csrf' | 'fetch' | 'guard'>): HubClient {
  const guard = new RequestGuard(o.guard);
  const base = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const client = createClient<HubPaths>({ baseUrl: o.baseUrl, fetch: guard.wrap(base), credentials: 'same-origin' });
  const csrf: Middleware = {
    onRequest({ request }) {
      const token = o.csrf();
      if (request.method !== 'GET' && token !== null) {
        request.headers.set('X-CSRF-Token', token);
      } else {
        request.headers.delete('X-CSRF-Token');
      }
      return request;
    },
  };
  client.use(csrf);
  return client;
}

export function createHubPort(o: HubPortOptions): DataPort {
  const c = createHubClientFor(o);
  const ref = (incident_ref: string) => ({ path: { incident_ref } });
  // CSRF 请求头由中间件统一附加；类型上要求的参数这里给出占位，中间件会覆盖为真实值
  const csrfHeader = { 'X-CSRF-Token': '' };
  const actions: ActionPort = {
    approve: async (id, body) => {
      const r = await c.POST('/v1/proposals/{proposal_id}/approve', {
        params: { path: { proposal_id: id }, header: csrfHeader },
        body: { confirm_target: body.confirm_target, webauthn: body.webauthn },
      });
      return unwrap<{ proposal: Proposal }>('approveProposal', r).proposal;
    },
    reject: async (id, reason) =>
      unwrap(
        'rejectProposal',
        await c.POST('/v1/proposals/{proposal_id}/reject', {
          params: { path: { proposal_id: id }, header: csrfHeader },
          body: { reason },
        }),
      ),
    undo: async (id) =>
      unwrap(
        'undoProposal',
        await c.POST('/v1/proposals/{proposal_id}/undo', { params: { path: { proposal_id: id }, header: csrfHeader } }),
      ),
    requestResearch: async (incident) =>
      unwrap(
        'requestResearch',
        await c.POST('/v1/incidents/{incident_ref}/research', {
          params: { path: { incident_ref: incident }, header: csrfHeader },
        }),
      ),
    rerunEvidence: async (incident, body) =>
      unwrap(
        'rerunEvidence',
        await c.POST('/v1/incidents/{incident_ref}/evidence/rerun', {
          params: { path: { incident_ref: incident }, header: csrfHeader },
          body,
        }),
      ),
  };
  return {
    listConditions: async (cluster_id) =>
      unwrap('listConditions', await c.GET('/v1/conditions', { params: { query: { cluster_id } } })),
    listIncidents: async (q) => unwrap('listIncidents', await c.GET('/v1/incidents', { params: { query: q } })),
    getIncident: async (r) => unwrap('getIncident', await c.GET('/v1/incidents/{incident_ref}', { params: ref(r) })),
    getStageAReport: async (r) =>
      unwrapOrNull('getStageAReport', await c.GET('/v1/incidents/{incident_ref}/stage-a', { params: ref(r) })),
    getEvidenceSnapshot: async (r, runId) =>
      unwrap(
        'getEvidenceSnapshot',
        await c.GET('/v1/incidents/{incident_ref}/evidence', {
          params: { path: { incident_ref: r }, query: runId === null ? {} : { run_id: runId } },
        }),
      ),
    getIncidentTimeline: async (r) =>
      unwrap('getIncidentTimeline', await c.GET('/v1/incidents/{incident_ref}/timeline', { params: ref(r) })),
    getIncidentSubgraph: async (r) =>
      unwrap('getIncidentSubgraph', await c.GET('/v1/incidents/{incident_ref}/subgraph', { params: ref(r) })),
    listResearchRuns: async (r) =>
      unwrap('listResearchRuns', await c.GET('/v1/incidents/{incident_ref}/research', { params: ref(r) })),
    getResearchRun: async (run_id) =>
      unwrap('getResearchRun', await c.GET('/v1/runs/{run_id}', { params: { path: { run_id } } })),
    getResearchManifest: async (run_id) =>
      unwrapOrNull('getResearchManifest', await c.GET('/v1/runs/{run_id}/manifest', { params: { path: { run_id } } })),
    listFeedback: async (r) =>
      unwrap('listFeedback', await c.GET('/v1/incidents/{incident_ref}/feedback', { params: ref(r) })),
    createFeedback: async (r, body) =>
      unwrap(
        'createFeedback',
        await c.POST('/v1/incidents/{incident_ref}/feedback', {
          params: { path: { incident_ref: r }, header: csrfHeader },
          body,
        }),
      ),
    listProposals: async (q) => unwrap('listProposals', await c.GET('/v1/proposals', { params: { query: q } })),
    getProposal: async (id) =>
      unwrap('getProposal', await c.GET('/v1/proposals/{proposal_id}', { params: { path: { proposal_id: id } } })),
    actions: o.actions ? actions : undefined,
  };
}
