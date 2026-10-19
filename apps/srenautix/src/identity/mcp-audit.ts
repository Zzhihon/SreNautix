import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import type { CallerRegistry, ServiceCaller } from './callers.js';

type McpCaller = Extract<ServiceCaller, { kind: 'external' }>;

/** 请求的 bearer token 对应的 MCP 调用方（调用方文件中 kind: external、channel: mcp）；其他请求为 null。 */
function mcpCaller(callers: CallerRegistry, req: FastifyRequest): McpCaller | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const c = m ? callers.authenticate(m[1] as string) : null;
  return c && c.kind === 'external' && c.channel === 'mcp' ? c : null;
}

/** 响应体中的 proposal_id（提议创建）或错误信息（被拒绝）。 */
function outcomeOf(status: number, payload: unknown): { proposal_id?: string; error?: string } {
  if (typeof payload !== 'string' || !payload.startsWith('{')) {
    return {};
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (status >= 400) {
    return { error: `${String(body.error ?? 'http')}: ${String(body.message ?? '').slice(0, 500)}` };
  }
  return typeof body.proposal_id === 'string' ? { proposal_id: body.proposal_id } : {};
}

/**
 * MCP 调用的治理审计（DESIGN §16.3）：mcp 角色没有数据库，用每个 OAuth 客户端对应的外部调用方 token 调用中心 API，
 * 由 server 把这些请求逐条写入治理链（kind mcp.call）：调用方、方法与路由、路径参数、响应码、幂等键，
 * 提议创建时的 proposal_id，被拒绝时的错误码与原因。
 *
 * 记录在响应发出之前写入（onSend）：审计写入失败时请求以 500 结束，不会出现没有审计的成功响应。
 */
export function registerMcpAudit(app: FastifyInstance, pool: pg.Pool, callers: () => CallerRegistry): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const c = mcpCaller(callers(), req);
    if (!c) {
      return payload;
    }
    const key = req.headers['idempotency-key'];
    await tx(pool, (cl) =>
      appendAudit(cl, 'mcp.call', `service:${c.id}`, {
        caller_id: c.id,
        method: req.method,
        route: req.routeOptions.url ?? null,
        params: req.params ?? {},
        status: reply.statusCode,
        idempotency_key: typeof key === 'string' ? key : null,
        ...outcomeOf(reply.statusCode, payload),
      }),
    );
    return payload;
  });
}
