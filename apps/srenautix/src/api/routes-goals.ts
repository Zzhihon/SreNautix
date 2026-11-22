import type { FastifyInstance } from 'fastify';
import type { Auth } from '../identity/auth.js';
import { forbidden, notFound, unavailable } from '../kernel/errors.js';

// 主动优化已退役：保留符合 OpenAPI 契约的只读空列表与 404/503 桩路由，避免破坏现有客户端与契约检查。

export interface GoalRouteDeps {
  auth: Auth;
}

const RETIRED_MESSAGE = '主动优化已退役（optimization.enabled=false）';

export function registerGoalRoutes(app: FastifyInstance, d: GoalRouteDeps): void {
  app.get('/v1/goals', async (req) => {
    await d.auth.reader(req);
    return { items: [], next_cursor: null };
  });

  app.post('/v1/goals', async () => {
    throw unavailable(RETIRED_MESSAGE);
  });

  app.get('/v1/goals/:goal_id', async (req) => {
    await d.auth.reader(req);
    throw notFound('没有这个目标');
  });

  app.post('/v1/goals/:goal_id/cancel', async (req) => {
    await d.auth.reader(req);
    throw notFound('没有这个目标');
  });

  app.get('/v1/goals/:goal_id/runs', async (req) => {
    await d.auth.reader(req);
    throw notFound('没有这个目标');
  });

  app.get('/v1/goals/:goal_id/runs/:run_id', async (req) => {
    await d.auth.reader(req);
    throw notFound('没有这个目标');
  });

  app.get('/v1/findings', async (req) => {
    await d.auth.reader(req);
    return { items: [], next_cursor: null };
  });

  app.get('/v1/recommendations', async (req) => {
    await d.auth.reader(req);
    return { items: [], next_cursor: null };
  });

  app.post('/v1/recommendations/:recommendation_id/reject', async (req) => {
    const c = await d.auth.required(req);
    if (c.kind !== 'user') {
      throw forbidden('“建议无用”只能在控制台会话中标记');
    }
    throw notFound('没有这个建议');
  });

  app.get('/v1/optimization/catalog', async (req) => {
    await d.auth.reader(req);
    return { indicators: [], domains: [] };
  });
}
