import { declaredProfile } from '../llm/dialect.js';
import { LlmError } from '../llm/types.js';
import { probeRoute } from '../llm/probe.js';
import type { RouteRuntime } from '../llm/session.js';
import { shortCallTimeoutMs } from '../llm/timeouts.js';
import { logger } from '../log.js';
import { EvidenceSource } from '../stage-a/packs.js';
import { EvalInfrastructureError } from './runner.js';

// 开跑前的探测（ADR 0110）：模型路由与指标数据源都要可达，任何一项失败都不开跑，不消耗预算。

/** 每条路由做一次能力探测（几次很短的调用与 /models）；连接失败、超时、服务端错误都使评测不开跑 */
export async function preflightRoutes(runtimes: readonly RouteRuntime[]): Promise<void> {
  for (const rt of runtimes) {
    const timeout = shortCallTimeoutMs(rt.timeouts);
    try {
      await probeRoute(
        rt.route,
        declaredProfile(rt.route.dialect_profile),
        rt.client,
        timeout,
        AbortSignal.timeout(6 * timeout),
        rt.thinking,
      );
    } catch (e) {
      if (e instanceof LlmError) {
        throw new EvalInfrastructureError(`开跑前探测：模型路由 ${rt.route.id} 不可用：${e.message}`, []);
      }
      throw e;
    }
    logger.info('开跑前探测：模型路由可用', { route: rt.route.id });
  }
}

/** 指标数据源：即时查询与区间查询都要成功 */
export async function preflightMetrics(m: {
  url: string;
  dialect: 'promql' | 'metricsql';
  bearerTokenFile: string | null;
}): Promise<void> {
  const source = await EvidenceSource.create({
    id: 'eval-metrics',
    url: m.url,
    dialect: m.dialect,
    bearerTokenFile: m.bearerTokenFile,
    timeoutMs: 15_000,
  });
  const r = await source.verify();
  const failed = ['metrics.query', 'metrics.query_range'].filter((k) => !r[k]?.ok);
  if (failed.length) {
    throw new EvalInfrastructureError(
      `开跑前探测：指标数据源 ${m.url} 不可用：${failed.map((k) => `${k} ${r[k]?.detail ?? '没有结果'}`).join('；')}`,
      [],
    );
  }
  logger.info('开跑前探测：指标数据源可用', { url: m.url });
}
