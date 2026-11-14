import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createApp } from '../kernel/http.js';
import { HttpError } from '../kernel/errors.js';
import { pgConfigFromEnv } from '../kernel/store/pg-env.js';
import { parseListen } from '../kernel/files.js';
import { registerEvents } from '../events/http.js';
import { OutboxListener } from '../events/listener.js';
import { configureLog, logger } from '../kernel/log.js';
import { watchBalances } from '../llm/balance.js';
import { Egress } from '../llm/egress.js';
import { declaredProfile } from '../llm/dialect.js';
import { applyProbe, probeRoute } from '../llm/probe.js';
import { partitionRoutes } from '../llm/routes.js';
import { ModelLayer } from '../llm/session.js';
import { shortCallTimeoutMs } from '../llm/timeouts.js';
import { LlmError } from '../llm/types.js';
import type { RoleArgs } from '../main.js';
import { startMetricsServer } from '../kernel/metrics.js';
import { loadWorkerConfig, type WorkerConfig } from '../research/config.js';
import { HubClient } from '../research/hub.js';
import { WorkerMetrics } from '../research/metrics.js';
import { workerTracks } from '../research/migrations.js';
import {
  agentCost,
  agentHealth,
  egressLedger,
  emptyEvalCases,
  emptyEvalReport,
  emptyEvalReports,
  emptyEvalTrend,
  estimateEval,
  modelRoutes,
  parseCostGroup,
  type PageRouteView,
} from '../research/page-data.js';
import { WorkerService } from '../research/service.js';
import { WorkerStore } from '../research/store.js';
import { migrateExpand, migrationsReady } from '../kernel/store/migrate.js';
import { migrateWhenReady } from '../kernel/store/migrate-when-ready.js';
import { createPool, type PgConfig } from '../kernel/store/pool.js';
import type { Tool } from '../tools/box.js';
import { openMcp } from '../tools/mcp.js';

// worker 角色（DESIGN §1.1）：唯一持有模型密钥；认领阶段 B 任务并研判，结果写入 worker schema 与它的 outbox，
// 由 server 经 GET /v1/events 消费。对外只开放事件流与研判明细，调用方是 server（inbound token）。

export interface WorkerHandle {
  app: FastifyInstance;
  pool: pg.Pool;
  store: WorkerStore;
  layer: ModelLayer;
  service: WorkerService;
  metrics: WorkerMetrics;
  apiUrl: string;
  stop(): Promise<void>;
}

export interface BuildWorkerOptions {
  config: WorkerConfig;
  pg: PgConfig;
  noAuxListeners?: boolean;
  apiListen?: { host: string; port: number };
  /** 测试：不启动认领循环，由测试直接调用 service.handle */
  noLoop?: boolean;
}

function inboundAuth(allowed: readonly string[]): (req: FastifyRequest) => void {
  const hashes = allowed.map((h) => Buffer.from(h, 'hex'));
  return (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) {
      throw new HttpError(401, 'unauthorized', '需要 bearer token');
    }
    const got = createHash('sha256')
      .update(m[1] as string)
      .digest();
    if (!hashes.some((h) => h.length === got.length && timingSafeEqual(h, got))) {
      throw new HttpError(401, 'unauthorized', 'token 无效');
    }
  };
}

/**
 * 控制台 /eval /health /models 三页经 console-bff 的 forward() 原样转发到 worker。
 * 9 条 app.get/post 注册直接写在本文件里（不藏进 helper）：forward-route-coverage.test.ts
 * 扫 worker.ts 源码文本断言这些 handler 存在。单测也直接调用本函数，在真实 fastify 实例上
 * 用 mock PG pool 验证鉴权与返回形状，因此查询逻辑集中在 research/page-data.ts 复用。
 */
export interface RegisterPageRoutesOptions {
  app: FastifyInstance;
  pool: pg.Pool;
  /** worker.ts 的 inboundAuth 返回值：每个 handler 的第一句都调用它。 */
  auth: (req: FastifyRequest) => void;
  routeViews: readonly PageRouteView[];
  codeSha: string;
  estimateTokensPerCall: number;
  estimatePricePerMtok: number;
  /** 测试注入的当前时间；生产用 Date.now。 */
  now?: () => number;
}

export function registerPageRoutes(o: RegisterPageRoutesOptions): void {
  const { app, pool, auth } = o;
  const now = o.now ?? (() => Date.now());
  const query = (req: FastifyRequest): Record<string, unknown> => (req.query ?? {}) as Record<string, unknown>;
  app.get('/v1/eval/reports', async (req) => {
    auth(req);
    return emptyEvalReports();
  });
  app.get('/v1/eval/reports/:report_id', async (req) => {
    auth(req);
    return emptyEvalReport((req.params as { report_id: string }).report_id, o.codeSha, now());
  });
  app.get('/v1/eval/cases', async (req) => {
    auth(req);
    return emptyEvalCases();
  });
  app.get('/v1/eval/trend', async (req) => {
    auth(req);
    return emptyEvalTrend();
  });
  app.post('/v1/eval/estimate', async (req) => {
    auth(req);
    // worker 配置里没有评测用例目录，CaseStore 无从构造，按契约返回全 0；不调用模型、不查库。
    return estimateEval(req.body, {
      estimateTokensPerCall: o.estimateTokensPerCall,
      estimatePricePerMtok: o.estimatePricePerMtok,
    });
  });
  app.get('/v1/agent/health', async (req) => {
    auth(req);
    return agentHealth(pool, query(req).window, now());
  });
  app.get('/v1/agent/cost', async (req) => {
    auth(req);
    const q = query(req);
    const group = parseCostGroup(q.group_by);
    if (group === null) {
      throw new HttpError(400, 'bad_request', 'group_by 必须是 day、incident 或 model');
    }
    return agentCost(pool, group, q.from, q.to, now());
  });
  app.get('/v1/egress/ledger', async (req) => {
    auth(req);
    const q = query(req);
    return egressLedger(pool, o.routeViews, q.from, q.to, q.route_id, now());
  });
  app.get('/v1/models/routes', async (req) => {
    auth(req);
    return modelRoutes(pool, o.routeViews, now());
  });
}

export async function buildWorker(o: BuildWorkerOptions): Promise<WorkerHandle> {
  const c = o.config;
  configureLog(c.raw.log_level, { role: 'worker', cluster_id: c.raw.cluster_id, worker_id: c.raw.worker_id });
  const metrics = new WorkerMetrics('worker', !o.noAuxListeners);
  const pool = createPool(o.pg, 'srenautix-worker', c.raw.database.pool_size, () =>
    metrics.pgStatementTimeouts.inc({ pool: 'worker' }),
  );
  // db bootstrap 还没完成时重试并保持 not ready，而不是退出（ADR 0102）
  await migrateWhenReady('worker', () => migrateExpand(pool, 'worker', workerTracks), {
    probes: o.noAuxListeners ? null : parseListen('listen.probes', c.raw.listen.probes),
  });
  const store = new WorkerStore(pool);

  const egress = new Egress(
    {
      allowCrossBorder: c.raw.llm.allow_cross_border,
      honeytokens: c.honeytokens,
      ...(c.raw.llm.egress ? { categories: c.raw.llm.egress.categories } : {}),
    },
    (reason) => {
      metrics.egressHalted.set(1);
      metrics.condition.set({ role: 'worker', type: 'egress_halted' }, 1);
      logger.error('出站已停止，需要人工处理后重启 worker', { reason });
    },
  );
  const states = await store.routeStates();
  // 出站策略不允许的路由（例如国内配置下的境外路由）在启动时禁用，worker 照常就绪；
  // 一条可用路由都没有时阶段 B 不运行，只出阶段 A（ADR 0093）
  const { runtimes, disabled } = partitionRoutes(
    c.routes.map((r) => ({
      route: r.route,
      apiKey: r.apiKey,
      state: states.get(r.route.id) ?? { profile: null, calibration: null, fingerprint: null },
      timeouts: r.timeouts,
      thinking: r.thinking,
    })),
    egress,
  );
  for (const d of disabled) {
    metrics.routeDisabled.set({ route: d.id, reason: d.reason }, 1);
    logger.error('模型路由被出站策略禁用，不会被调用', { route: d.id, reason: d.reason, message: d.message });
  }
  metrics.routesAvailable.set(runtimes.length);
  metrics.condition.set({ role: 'worker', type: 'model_route_disabled' }, disabled.length ? 1 : 0);
  metrics.condition.set({ role: 'worker', type: 'no_model_route' }, runtimes.length ? 0 : 1);
  if (!runtimes.length) {
    logger.error('没有可用的模型路由，阶段 B 不运行，只出阶段 A', { disabled: disabled.map((d) => d.id) });
  }
  if (c.raw.llm.probe_on_start) {
    for (const rt of runtimes) {
      try {
        const report = await probeRoute(
          rt.route,
          declaredProfile(rt.route.dialect_profile),
          rt.client,
          shortCallTimeoutMs(rt.timeouts),
          AbortSignal.timeout(5 * shortCallTimeoutMs(rt.timeouts)),
          rt.thinking,
        );
        rt.profile = applyProbe(declaredProfile(rt.route.dialect_profile), report);
        await store.saveProbe(rt.route.id, rt.profile, report);
        logger.info('模型路由能力探测完成', { route: rt.route.id, profile: rt.profile });
      } catch (e) {
        if (!(e instanceof LlmError)) {
          throw e;
        }
        // 模型服务暂时不可用：沿用已保存或声明的档案，阶段 B 由熔断器处理
        logger.warn('模型路由能力探测失败，沿用已保存的方言档案', { route: rt.route.id, error: e.message });
      }
    }
  }
  const layer = new ModelLayer({
    routes: runtimes,
    disabled,
    egress,
    budget: c.budget,
    metrics,
    language: c.raw.language,
    onCalibration: (cal) => store.saveCalibration(cal),
    onDrift: (d) => store.saveFingerprint(d.routeId, d.to),
  });
  if (layer.allRoutesInTopology()) {
    metrics.condition.set({ role: 'worker', type: 'all_routes_in_topology' }, 1);
    logger.warn('所有模型路由都落在被管拓扑内：模型服务本身出事时阶段 B 全部跳过，建议保留一条拓扑之外的路由');
  }

  // 控制台 /models /health 两页的路由视图：以配置为全集，补上从未出现在 route_state / llm_calls
  // 的路由；出站策略禁用的路由如实标 enabled=false（契约没有 disabled 字段，page-data 里标成 open）。
  const nowMs = (): number => Date.now();
  const runtimeById = new Map(runtimes.map((r) => [r.route.id, r]));
  const disabledById = new Map(disabled.map((d) => [d.id, d]));
  const egressCategories = c.raw.llm.egress?.categories ?? [];
  const routeViews: PageRouteView[] = c.routes.map(({ route }): PageRouteView => {
    const rt = runtimeById.get(route.id);
    const isDisabled = disabledById.has(route.id);
    return {
      route: {
        id: route.id,
        model: route.model,
        dialect_profile: route.dialect_profile,
        base_url: route.base_url,
        in_domain: route.in_domain,
        failure_domain: [...route.failure_domain],
        price: { ...route.price },
        retention_terms: route.retention_terms,
      },
      enabled: !isDisabled && rt !== undefined,
      breaker: rt ? rt.breaker.state(nowMs()) : 'open',
      breakerReason:
        rt && rt.breaker.openReason ? (rt.breaker.openReason === 'failure' ? 'failures' : 'latency') : null,
      egressCategories: [...egressCategories],
    };
  });

  const hub = new HubClient(c.raw.hub.url.replace(/\/+$/, ''), c.hubToken);
  const service = new WorkerService({
    hub,
    store,
    layer,
    metrics,
    language: c.raw.language,
    limits: c.limits,
    budget: c.budget,
    workerId: c.raw.worker_id,
    clusterId: c.raw.cluster_id,
    codeSha: c.raw.code_sha,
    claimWaitS: c.claimWaitS,
    tools: async () => {
      const sessions = await Promise.all(c.mcp.map((m) => openMcp(m, AbortSignal.timeout(30_000))));
      const tools: Tool[] = sessions.flatMap((s) => s.tools);
      return { tools, close: async () => void (await Promise.all(sessions.map((s) => s.close()))) };
    },
  });

  const app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  const auth = inboundAuth(c.inboundTokenSha256);
  const listener = new OutboxListener(o.pg, 'srenautix-worker-listen');
  listener.start();
  registerEvents(app, {
    pool,
    schema: 'worker',
    owner: 'worker',
    listener,
    authorize: async (req) => {
      auth(req);
      return () => true;
    },
  });
  app.get('/v1/runs/:run_id', async (req) => {
    auth(req);
    const r = await store.runDetail((req.params as { run_id: string }).run_id);
    if (!r) {
      throw new HttpError(404, 'not_found', '没有这个研判');
    }
    return r;
  });
  app.get('/v1/runs/:run_id/manifest', async (req) => {
    auth(req);
    const m = await store.manifest((req.params as { run_id: string }).run_id);
    if (!m) {
      throw new HttpError(404, 'not_found', '没有这个研判的清单');
    }
    return m;
  });
  app.get('/v1/runs/:run_id/prompt/raw', async (req) => {
    auth(req);
    throw new HttpError(404, 'not_found', 'worker 只保存脱敏后的提示词，不保存原文');
  });

  registerPageRoutes({
    app,
    pool,
    auth,
    routeViews,
    codeSha: c.raw.code_sha,
    estimateTokensPerCall: c.budget.perResearchInputTokens,
    estimatePricePerMtok: c.routes[0]?.route.price.input_per_mtok ?? 0,
  });
  app.get('/healthz', async () => ({ status: 'ok' }));

  const listen =
    o.apiListen ??
    (() => {
      const l = parseListen('listen.api', c.raw.listen.api);
      return { host: l.host ?? '0.0.0.0', port: l.port };
    })();
  const apiUrl = await app.listen({ host: listen.host, port: listen.port });
  const aux: Server[] = [];
  if (!o.noAuxListeners) {
    const m = parseListen('listen.metrics', c.raw.listen.metrics);
    aux.push(startMetricsServer(metrics.registry, m.host, m.port));
    const p = parseListen('listen.probes', c.raw.listen.probes);
    const probes = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200).end('ok');
        return;
      }
      if (req.url === '/readyz') {
        migrationsReady(pool, 'worker', workerTracks)
          .then((ok) => res.writeHead(ok && !egress.halted ? 200 : 503).end(ok ? 'ready' : 'not ready'))
          .catch((e: Error) => res.writeHead(503).end(e.message));
        return;
      }
      res.writeHead(404).end();
    });
    probes.listen(p.port, p.host);
    aux.push(probes);
  }
  const loopCtrl = new AbortController();
  const loop = o.noLoop ? Promise.resolve() : service.run(loopCtrl.signal);
  // 配置了 balance 的可用路由定期读取账户余额（ADR 0207）
  const balanceTargets = c.routes.flatMap((r) =>
    r.balance && runtimeById.has(r.route.id) ? [{ route: r.route, apiKey: r.apiKey, kind: r.balance }] : [],
  );
  const balances =
    o.noLoop || !balanceTargets.length
      ? Promise.resolve()
      : watchBalances(
          balanceTargets,
          (route) => {
            try {
              egress.assertRouteAllowed(route);
              return !egress.halted;
            } catch {
              return false;
            }
          },
          {
            readings: (route, rs) => {
              for (const b of rs) {
                metrics.routeBalance.set({ route, currency: b.currency }, b.amount);
              }
            },
            outcome: (route, ok) => metrics.routeBalanceCheck.set({ route }, ok ? 1 : 0),
          },
          loopCtrl.signal,
          (route, e) => logger.warn('读取模型路由账户余额失败', { route, error: e.message }),
        );
  logger.info('worker 已启动', {
    api: apiUrl,
    routes: runtimes.map((r) => r.route.id),
    disabled: disabled.map((d) => d.id),
  });
  return {
    app,
    pool,
    store,
    layer,
    service,
    metrics,
    apiUrl,
    async stop() {
      // 停止认领新任务，等待进行中的研判结束
      service.stop();
      loopCtrl.abort(new Error('shutdown'));
      await loop;
      await balances;
      await app.close();
      await listener.stop();
      for (const s of aux) {
        s.close();
      }
      await pool.end();
    },
  };
}

export async function run(args: RoleArgs): Promise<void> {
  const config = loadWorkerConfig(args.configPath);
  const h = await buildWorker({ config, pg: pgConfigFromEnv(process.env, config.raw.database.password_file) });
  const shutdown = (sig: string) => {
    logger.info('收到信号，停止 worker', { signal: sig });
    void h.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
