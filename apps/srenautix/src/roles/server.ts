import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { ResolvedRcaParams } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { registerReadLimit } from '../api/read-limit.js';
import { createApp } from '../api/http.js';
import { leaseLeader, neverLeader, singleLeader, type Leader } from '../api/leader.js';
import { registerProposalRoutes } from '../api/routes-proposals.js';
import { registerResearchRoutes } from '../api/routes-research.js';
import { pgConfigFromEnv } from '../config/database.js';
import { parseDuration, parseListen, readSecretFile } from '../config/files.js';
import { loadServerConfig, type ServerConfig } from '../config/server.js';
import { changesInWindow, ChangesService } from '../changes/service.js';
import { ConditionPublisher, serverConditions, workerRouteConditions } from '../console-bff/conditions.js';
import { IntegrationRegistry } from '../console-bff/integrations.js';
import { registerIncidentRoutes } from '../console-bff/routes-incidents.js';
import { apiTokenCaller, registerSystemRoutes } from '../console-bff/routes-system.js';
import { registerConsoleStatic } from '../console-bff/static.js';
import { registerEvents } from '../events/http.js';
import { OutboxListener } from '../events/listener.js';
import { Auth } from '../identity/auth.js';
import { Bindings, scopeMatches } from '../identity/bindings.js';
import { CallerRegistry } from '../identity/callers.js';
import { ChatLinks, usersByEmail } from '../identity/chat-links.js';
import { registerMcpAudit } from '../identity/mcp-audit.js';
import { LocalAdmin } from '../identity/local-admin.js';
import { Oidc } from '../identity/oidc.js';
import { registerAuthRoutes } from '../identity/routes.js';
import { Sessions } from '../identity/sessions.js';
import { IncidentEngine } from '../incident/engine.js';
import { IncidentPipeline, listenIngest } from '../incident/pipeline.js';
import { reconcileFromReader, reconcileOnce, startReconcileLoop } from '../ingest/reconcile.js';
import { ReaderProtocol } from '../topology/protocol.js';
import {
  ReaderClock,
  ReaderRequestQueue,
  registerReaderRoutes,
  expireReaderConditions,
} from '../topology/reader-routes.js';
import { IngestService } from '../ingest/service.js';
import { configureLog, logger } from '../log.js';
import type { RoleArgs } from '../main.js';
import { ServerMetrics, startMetricsServer } from '../metrics.js';
import { ServerNotifyActions } from '../notify/actions.js';
import { NotifyService } from '../notify/index.js';
import { PgMessageSource } from '../notify/source.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../proposals/catalog.js';
import { FeedbackService } from '../proposals/feedback.js';
import { Policies } from '../proposals/policy.js';
import { ProposalService } from '../proposals/service.js';
import { SpokeRelay } from '../proposals/spoke.js';
import { Scheduler } from '../scheduler/admission.js';
import { WorkerEventMirror } from '../scheduler/worker-events.js';
import { DegradedLane } from '../stage-a/degraded.js';
import { PackEvidence, PackRules } from '../stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../stage-a/packs.js';
import { StageAService } from '../stage-a/service.js';
import { loadEd25519Private } from '../store/audit.js';
import { keyringFrom, type Keyring } from '../proposals/assertion.js';
import { AuditExporter, s3Client } from '../store/audit-export.js';
import { purgeIdempotencyKeys } from '../store/idempotency.js';
import { migrateExpand, migrationsReady } from '../store/migrate.js';
import type { OutboxEvent } from '../store/outbox.js';
import { createPool, type PgConfig } from '../store/pool.js';
import { startInformerTopology } from '../topology/informer.js';
import { GitHubApp } from '../github/app.js';
import { IssueService } from '../github/issues.js';
import { TopologyOverrides } from '../topology/overrides.js';
import { TopologyStore } from '../topology/store.js';
import { TopologyTargets } from '../topology/targets.js';
import { serverTracks } from './server-schema.js';

export interface ServerHandle {
  app: FastifyInstance;
  pool: pg.Pool;
  config: ServerConfig;
  metrics: ServerMetrics;
  notify: NotifyService;
  pipeline: IncidentPipeline;
  ingest: IngestService;
  proposals: ProposalService;
  /** 事件 issue（issues.enabled）；关闭时为 null */
  issues: IssueService | null;
  leader: Leader;
  /** API 实际监听的地址（端口为 0 时由系统分配）。 */
  apiUrl: string;
  stop(): Promise<void>;
}

export interface BuildOptions {
  config: ServerConfig;
  pg: PgConfig;
  /** 不监听指标与探针端口（测试）。 */
  noAuxListeners?: boolean;
  /**
   * 测试用：通知与渠道回调使用的时钟（飞书回调的 5 分钟时效、编辑间隔与令牌桶）。状态库中的时间（提议 TTL 等）
   * 仍取 PostgreSQL 的 now()。
   */
  now?: () => number;
  /** 测试用：API 端口覆盖配置。 */
  apiListen?: { host: string; port: number };
  /**
   * all：接口、控制台与单活工作；api：不提供控制台静态文件；console：接口与控制台，不参与选主、
   * 不运行 informer（控制台单独扩容的副本，DESIGN §1.1）。命令行默认 all；在进程内组装（测试）时默认 api。
   */
  serve?: 'all' | 'api' | 'console';
}

/** 状态库里的抑制规则：matchers 是标签等值条件，全部满足的告警被抑制（只影响 SreNautix 自己的消息与研判）。 */
async function suppressedAlertIds(c: pg.PoolClient | pg.Pool, clusterId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) {
    return new Set();
  }
  const r = await c.query<{ alert_id: string }>(
    `SELECT a.alert_id FROM server.alert_state a
      WHERE a.alert_id = ANY($2::text[]) AND (a.suppressed <> 'none' OR EXISTS (
        SELECT 1 FROM server.suppressions s WHERE s.cluster_id = $1 AND s.expires_at > now() AND a.labels @> s.matchers))`,
    [clusterId, ids],
  );
  return new Set(r.rows.map((x) => x.alert_id));
}

/** 组装 server 角色的全部组件并启动 HTTP 接口与后台循环。 */
export async function buildServer(o: BuildOptions): Promise<ServerHandle> {
  const c = o.config;
  const serve = o.serve ?? 'api';
  configureLog(c.log_level, { role: 'server', cluster_id: c.cluster_id, serve });
  const metrics = new ServerMetrics('server', !o.noAuxListeners);
  const pool = createPool(o.pg, 'srenautix-server', c.database.pool_size);
  const applied = await migrateExpand(pool, 'server', serverTracks);
  if (applied.length) {
    logger.info('扩展迁移完成', { applied });
  }
  const startedAt = new Date();
  const abort = new AbortController();
  const signal = abort.signal;
  const publicOrigin = new URL(c.public_url).origin;

  // 身份
  let bindings = Bindings.load(c.identity.bindings_dir);
  const callers = CallerRegistry.load(c.callers.tokens_file);
  const sessionPolicy = {
    idleMs: parseDuration('identity.session_idle', c.identity.session_idle),
    absoluteMs: parseDuration('identity.session_absolute', c.identity.session_absolute),
  };
  const sessions = new Sessions(pool, sessionPolicy);
  const auth = new Auth(
    sessions,
    callers,
    bindings,
    publicOrigin,
    (t) => apiTokenCaller(pool, t),
    (email) => usersByEmail(pool, email),
  );
  const lockout = {
    maxFailures: c.identity.lockout_failures,
    windowMs: parseDuration('identity.lockout_window', c.identity.lockout_window),
    durationMs: parseDuration('identity.lockout_duration', c.identity.lockout_duration),
  };
  const localAdmin = c.identity.local_admin
    ? new LocalAdmin(
        pool,
        {
          username: c.identity.local_admin.username,
          passwordHash: readSecretFile(
            'identity.local_admin.password_hash_file',
            c.identity.local_admin.password_hash_file,
          ),
          totpSecret: readSecretFile('identity.local_admin.totp_secret_file', c.identity.local_admin.totp_secret_file),
        },
        lockout,
      )
    : null;
  const oidc = c.identity.oidc
    ? new Oidc(pool, {
        issuer: c.identity.oidc.issuer,
        clientId: c.identity.oidc.client_id,
        clientSecret: readSecretFile('identity.oidc.client_secret_file', c.identity.oidc.client_secret_file),
        scopes: c.identity.oidc.scopes,
        groupsClaim: c.identity.oidc.groups_claim,
        nameClaim: c.identity.oidc.name_claim,
        redirectUri: `${c.public_url.replace(/\/+$/, '')}/v1/auth/oidc/callback`,
        allowHttp: c.identity.oidc.issuer.startsWith('http://'),
      })
    : null;
  const chatLinks = new ChatLinks(pool);

  // 领域数据
  const catalog = Catalog.load();
  let policies = Policies.load(c.policies_dir);
  const topology = new TopologyStore(pool);
  const targets = new TopologyTargets(pool);
  // 拓扑覆盖：Git 挂载的目录，与角色绑定、策略一起定期重新加载
  const loadOverrides = () =>
    c.topology.overrides_dir ? TopologyOverrides.load(c.topology.overrides_dir) : TopologyOverrides.empty();
  let overrides = loadOverrides();
  // GitHub App（安装令牌）：拓扑覆盖 PR、事件 issue、GitHub 变更源共用
  const gh = c.github_app;
  const github = gh
    ? new GitHubApp({
        apiBase: gh.api_base,
        appId: gh.app_id,
        installationId: gh.installation_id,
        privateKey: readSecretFile('github_app.private_key_file', gh.private_key_file),
      })
    : null;
  const issues =
    github && c.issues?.enabled
      ? new IssueService(
          pool,
          github,
          {
            repo: c.issues.repo,
            labels: c.issues.labels,
            titlePrefix: (c.issues.title_prefix ?? c.notify.prefix).trim(),
            maxPerHour: c.issues.max_per_hour,
            lookbackMs: parseDuration('issues.lookback', c.issues.lookback),
            consoleUrl: c.public_url,
            language: c.stage_a.language,
          },
          metrics,
        )
      : null;
  const prom = c.datasources.prometheus;
  const packs = await PackRuntime.load({
    dirs: c.packs.dirs,
    only: c.packs.only ?? null,
    lockFile: c.packs.lock_file ?? null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
    oci: c.packs.oci
      ? {
          sources: c.packs.oci.sources,
          cosign: c.packs.oci.cosign,
          oras: c.packs.oci.oras,
          cacheDir: c.packs.oci.cache_dir,
        }
      : null,
  });
  logger.info('领域包已加载', {
    packs: packs.set.packs.map((p) => p.name),
    disabled: packs.set.disabled,
    failed: packs.failures.map((f) => f.name),
    lock_digest: packs.set.lockDigest,
  });
  const alertCatalog = packs.alertCatalog();
  const rcaParams = packs.rcaParams();
  const params = (): ResolvedRcaParams => rcaParams;
  const evidenceSource = await EvidenceSource.create({
    id: 'prometheus',
    url: prom.url,
    dialect: prom.dialect,
    bearerTokenFile: prom.bearer_token_file ?? null,
    timeoutMs: parseDuration('datasources.prometheus.timeout', prom.timeout),
  });
  const evidenceOptions = {
    locale: c.stage_a.language === 'zh' ? ('zh-CN' as const) : ('en' as const),
    concurrency: prom.concurrency,
    queryTimeoutMs: parseDuration('datasources.prometheus.timeout', prom.timeout),
  };
  const evidence = new PackEvidence(
    packs,
    evidenceSource,
    (clusterId, key) => topology.componentType(clusterId, key),
    evidenceOptions,
    metrics,
  );
  const rules = new PackRules(packs, metrics);

  // 提议与审批
  const ap = c.approvals;
  // 审批人公钥文件（合规配置 H 档的通行密钥）：读取或校验失败时 H 档审批返回 409 并说明原因，server 照常启动
  const loadApproverKeys = (): Keyring | null => {
    if (!ap?.approver_keys_file) {
      return null;
    }
    try {
      return keyringFrom(parseYaml(readFileSync(ap.approver_keys_file, 'utf8')) as Parameters<typeof keyringFrom>[0]);
    } catch (e) {
      logger.error('审批人公钥文件不能加载，合规配置的 H 档审批不可用', {
        file: ap.approver_keys_file,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };
  let approverKeys = loadApproverKeys();
  if (c.profile === 'compliance' && !approverKeys?.rpId) {
    logger.warn('合规配置没有可用的审批人通行密钥（approvals.approver_keys_file 的 webauthn 设置），H 档审批不可用');
  }
  const proposals = new ProposalService(
    pool,
    catalog,
    {
      profile: c.profile,
      signingKey: ap ? loadEd25519Private(readSecretFile('approvals.signing_key_file', ap.signing_key_file)) : null,
      keyId: ap?.key_id ?? 'none',
      assertionTtlMs: ap ? parseDuration('approvals.assertion_ttl', ap.assertion_ttl) : 15 * 60_000,
      proposalTtlMs: ap ? parseDuration('approvals.proposal_ttl', ap.proposal_ttl) : 2 * 3600_000,
      proposalTtlCapMs: ap ? parseDuration('approvals.proposal_ttl_cap', ap.proposal_ttl_cap) : 24 * 3600_000,
      hReauthMaxAgeMs: ap ? parseDuration('approvals.h_reauth_max_age', ap.h_reauth_max_age) : 5 * 60_000,
      approverKeys: () => approverKeys,
    },
    () => bindings,
    targets,
    () => policies,
    metrics,
  );
  const feedback = new FeedbackService(pool, metrics);

  // 研判调度
  const sc = c.scheduler;
  const scheduler = new Scheduler(
    pool,
    {
      slots: sc.slots,
      criticalReserved: sc.critical_reserved,
      maxRunsPerIncident: sc.max_runs_per_incident,
      runWindowMs: parseDuration('scheduler.run_window', sc.run_window),
      stageTimeoutMs: parseDuration('scheduler.stage_timeout', sc.stage_timeout),
      stormActiveAlerts: sc.storm_active_alerts,
      stormNewIncidents: sc.storm_new_incidents,
      stormWindowMs: parseDuration('scheduler.storm_window', sc.storm_window),
      stormTopRoots: sc.storm_top_roots,
      maxRecoveries: 2,
    },
    metrics,
  );

  // 领导者
  const leader =
    serve === 'console'
      ? neverLeader()
      : c.leader.mode === 'lease'
        ? leaseLeader({
            namespace: c.leader.namespace,
            name: c.leader.name,
            durationMs: parseDuration('leader.duration', c.leader.duration),
            kubeconfigPath: c.topology.kubeconfig,
          })
        : singleLeader();

  // 通知
  const source = new PgMessageSource(
    pool,
    {
      prefix: c.notify.prefix,
      consoleUrl: c.public_url,
      severities: c.notify.severities,
      resolvedRetentionMs: parseDuration('notify.resolved_retention', c.notify.resolved_retention),
    },
    proposals,
    feedback,
  );
  const notify = new NotifyService({
    pool,
    config: c.notify,
    publicUrl: c.public_url,
    source,
    actions: new ServerNotifyActions(pool, proposals, feedback, chatLinks),
    metrics,
    isLeader: () => leader.isLeader(),
    ...(o.now ? { now: o.now } : {}),
  });

  // 降级通道
  const degradedLane: DegradedLane = new DegradedLane(
    {
      clusterId: c.cluster_id,
      prefix: c.notify.prefix,
      consoleUrl: c.public_url,
      language: c.stage_a.language,
      severities: c.notify.severities,
    },
    alertCatalog,
    params,
    // 降级通道不查状态库：组件类型取最后一轮成功对账时的内存拓扑
    new PackEvidence(
      packs,
      evidenceSource,
      async (_clusterId: string, key: string): Promise<string | null> => degradedLane.componentTypeOf(key),
      evidenceOptions,
      metrics,
    ),
    notify,
    metrics,
  );

  // 接入
  const ingest = new IngestService(
    pool,
    c.ingest.sources,
    { clusterId: c.cluster_id, selfLabel: c.ingest.self_label, watchdogAlertname: c.ingest.watchdog_alertname },
    {
      catalog: alertCatalog,
      nodes: topology,
      ksm: null,
      ruleExpr: () => undefined,
      chronic: () => false,
      override: (clusterId, labels) => overrides.match(clusterId, labels),
    },
    metrics,
    (_clusterId, raws) => {
      degradedLane.ingest(raws, new Date());
      void degradedLane.run(new Date()).catch((e: unknown) => logger.error('降级通道发送失败', { error: e }));
    },
  );

  // 事件引擎与阶段 A
  const engine = new IncidentEngine({
    pool,
    topology,
    params,
    changes: (clusterId, from, to) => changesInWindow(pool, clusterId, from, to),
    probes: async () => [],
    stale: proposals,
    metrics,
    suppressedAlertIds: (cl, clusterId, ids) => suppressedAlertIds(cl as pg.PoolClient, clusterId, ids),
  });
  const stageA = new StageAService(pool, evidence, rules, proposals, metrics);
  let degraded = false;
  const pipeline = new IncidentPipeline(c.cluster_id, engine, stageA, scheduler, pool, metrics, {
    changed: () => notify.syncNow(),
    degraded: (_id, e) => {
      degraded = true;
      logger.error('状态库不可用，进入降级通道', { error: e.message });
    },
    recovered: () => {
      degraded = false;
      degradedLane.recovered();
      void ingest.backfill().then((n) => logger.info('降级期间的告警已补写', { alerts: n }));
      void notify.backfill().then((n) => logger.info('降级期间的消息已补写', { messages: n }));
    },
  });
  const origRecompute = engine.recompute.bind(engine);
  engine.recompute = async (clusterId: string) => {
    const r = await origRecompute(clusterId);
    degradedLane.snapshot(r.state);
    return r;
  };

  // 变更源：有新变更时立即重算事件（变更进入根因排序的"30 分钟内的变更"一项）
  const changes = new ChangesService(
    pool,
    c.changes.sources,
    { github, defaultClusterId: c.cluster_id },
    parseDuration('changes.lookback', c.changes.lookback),
    () => void pipeline.kick().catch((e: unknown) => logger.error('事件流水线失败', { error: e })),
  );

  // 事件流
  const listener = new OutboxListener(o.pg, 'srenautix-server');
  listener.start();

  const workerToken = c.worker ? readSecretFile('worker.token_file', c.worker.token_file) : null;
  const worker = c.worker && workerToken ? { url: c.worker.url.replace(/\/+$/, ''), token: workerToken } : null;

  // 审计
  const s3 = c.audit.s3;
  const exporter = new AuditExporter(
    pool,
    s3
      ? {
          client: s3Client({
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            prefix: s3.prefix,
            accessKey: readSecretFile('audit.s3.access_key_file', s3.access_key_file),
            secretKey: readSecretFile('audit.s3.secret_key_file', s3.secret_key_file),
            forcePathStyle: s3.force_path_style,
          }),
          bucket: s3.bucket,
          prefix: s3.prefix,
        }
      : null,
    loadEd25519Private(readSecretFile('audit.checkpoint_key_file', c.audit.checkpoint_key_file)),
    `${c.cluster_id}-governance`,
  );
  let auditStatus = { sink: (s3 ? 's3' : 'pg') as 's3' | 'pg', lagSeconds: 0 };
  exporter.runLoop(30_000, parseDuration('audit.checkpoint_interval', c.audit.checkpoint_interval), signal, (st) => {
    auditStatus = st;
    metrics.auditExportLag.set({ chain: 'governance' }, st.lagSeconds);
  });

  // HTTP
  const app = await createApp({ bodyLimit: 8 << 20, trustProxy: true });
  // 在注册路由之前加上，覆盖全部接口
  registerMcpAudit(app, pool, () => callers);
  registerReadLimit(app, metrics.apiRateLimited);
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await migrationsReady(pool, 'server', serverTracks);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready' });
  });
  registerAuthRoutes(app, {
    pool,
    sessions,
    auth,
    localAdmin,
    oidc,
    chatLinks,
    profile: c.profile,
    publicUrl: c.public_url,
    metrics,
  });
  ingest.registerRoutes(app);
  registerEvents(app, {
    pool,
    schema: 'server',
    owner: 'server',
    listener,
    onServed: (mode, n) => metrics.eventsServed.inc({ mode }, n),
    authorize: async (req) => {
      const { scopes } = await auth.reader(req);
      if (scopes === 'all') {
        return () => true;
      }
      return (e: OutboxEvent) =>
        scopes.some((b) => b.scope.clusters.includes('*') || b.scope.clusters.includes(e.cluster_id)) ||
        scopes.some((b) => scopeMatches(b, { cluster: e.cluster_id, namespace: null, labels: {} }));
    },
  });
  registerProposalRoutes(app, { pool, auth, proposals, catalog, policies: () => policies });
  registerResearchRoutes(app, {
    pool,
    auth,
    scheduler,
    topology,
    feedback,
    catalog,
    listener,
    worker,
    packs,
    templates: evidence,
    locale: evidenceOptions.locale,
  });
  registerIncidentRoutes(app, { pool, auth, feedback, topology, evidence, worker });
  registerSystemRoutes(app, {
    pool,
    auth,
    config: c,
    catalog,
    policies: () => policies,
    proposals,
    targets,
    topology,
    exporter,
    worker,
    packs,
    github,
    issues,
    integrations: IntegrationRegistry.fromConfig({
      pool,
      config: c,
      packs,
      catalog,
      evidence: evidenceSource,
      changes,
      telegram: notify.telegram?.adapter.client ?? null,
      feishu: notify.feishu?.client ?? null,
      oidc,
      approverKeys: () => approverKeys,
    }),
  });
  new SpokeRelay(pool, listener, catalog).registerRoutes(app, auth);
  // 多集群：分支 reader 的出站协议（contract/gateway/v1/reader.openapi.yaml）
  const readerProtocol = new ReaderProtocol();
  const readerClock = new ReaderClock();
  const readerRequests = new ReaderRequestQueue(pool, readerProtocol);
  registerReaderRoutes(app, {
    pool,
    auth,
    store: topology,
    protocol: readerProtocol,
    requests: readerRequests,
    clock: readerClock,
    onAlertSnapshot: async (clusterId, snap) => {
      const r = await reconcileFromReader(
        pool,
        clusterId,
        snap,
        ingest,
        metrics,
        c.ingest.self_label,
        c.ingest.watchdog_alertname,
      );
      if (r.added || r.resolved) {
        logger.info('reader 告警对账修正', { cluster_id: clusterId, added: r.added, resolved: r.resolved });
      }
    },
  });
  notify.registerRoutes(app);
  if (serve !== 'api') {
    registerConsoleStatic(app, c.console.dir);
  }

  const listen =
    o.apiListen ??
    (() => {
      const l = parseListen('listen.api', c.listen.api);
      return { host: l.host ?? '0.0.0.0', port: l.port };
    })();
  const apiUrl = await app.listen({ host: listen.host, port: listen.port });
  const aux: Server[] = [];
  if (!o.noAuxListeners) {
    const m = parseListen('listen.metrics', c.listen.metrics);
    aux.push(startMetricsServer(metrics.registry, m.host, m.port));
    const p = parseListen('listen.probes', c.listen.probes);
    const probes = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200).end('ok');
        return;
      }
      if (req.url === '/readyz') {
        migrationsReady(pool, 'server', serverTracks)
          .then((ok) => res.writeHead(ok ? 200 : 503).end(ok ? 'ready' : 'not ready'))
          .catch((e: Error) => res.writeHead(503).end(e.message));
        return;
      }
      res.writeHead(404).end();
    });
    probes.listen(p.port, p.host);
    aux.push(probes);
  }

  // 后台循环（只在主实例上做事）
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<unknown>, what: string) => {
    const t = setInterval(() => {
      if (!leader.isLeader()) {
        return;
      }
      fn().catch((e: unknown) => logger.error(`${what}失败，下一轮重试`, { error: e }));
    }, ms);
    t.unref();
    timers.push(t);
  };
  every(15_000, () => pipeline.kick(), '事件流水线');
  listenIngest(
    o.pg,
    () => {
      if (leader.isLeader()) {
        void pipeline.kick().catch((e: unknown) => logger.error('事件流水线失败', { error: e }));
      }
    },
    signal,
  );
  every(30_000, () => proposals.expire(), '提议过期检查');
  if (changes.configured) {
    every(parseDuration('changes.interval', c.changes.interval), () => changes.syncOnce(), '变更源同步');
    void leader
      .acquired()
      .then(() => changes.syncOnce())
      .catch((e: unknown) => logger.error('变更源同步失败', { error: e }));
  }
  // 事件 issue（ADR 0095）：主实例每 issues.interval 登记、开出、追加进展评论并给关联的 PR 补 Refs；gitops_pr 提议同样关联
  if (issues) {
    proposals.setIssueHook({
      refFor: async (incidentId, fromRepo) => {
        const i = await issues.ensure(incidentId, 'repo_change');
        return i ? GitHubApp.ref(fromRepo, i.repo, i.number) : null;
      },
      linked: (p, refsInBody) =>
        issues.link(p.incident_id, {
          kind: 'proposal',
          url: `${c.public_url.replace(/\/+$/, '')}/proposals/${p.proposal_id}`,
          title: `${p.action}: ${String((p.params as { title?: unknown }).title ?? p.target.display)}`,
          repo: null,
          number: null,
          refsInBody,
        }),
    });
    every(parseDuration('issues.interval', c.issues!.interval), () => issues.runOnce(), '事件 issue');
  }
  every(3600_000, () => purgeIdempotencyKeys(pool), '幂等键清理');
  every(3600_000, () => sessions.purgeExpired(), '会话清理');
  every(
    60_000,
    async () => {
      const d = await scheduler.queueDepth();
      for (const [k, v] of Object.entries(d)) {
        metrics.researchQueue.set({ state: k }, v);
      }
    },
    '队列指标',
  );
  // 角色绑定与策略来自 Git 挂载，定期重新加载
  every(
    60_000,
    async () => {
      bindings = Bindings.load(c.identity.bindings_dir);
      auth.setBindings(bindings);
      policies = Policies.load(c.policies_dir);
      overrides = loadOverrides();
      approverKeys = loadApproverKeys();
    },
    '重新加载角色绑定与策略',
  );

  let reconcileOk: boolean | null = null;
  const rc = c.ingest.reconcile;
  // 告警对账：本集群直接读取 Alertmanager 与规则引擎，或多集群时由 reader 推送快照
  const reconcileEnabled =
    (rc.enabled && !!(rc.alertmanager_url || rc.prometheus_url)) || c.topology.source === 'reader';
  if (rc.enabled && (rc.alertmanager_url || rc.prometheus_url)) {
    const bearer = rc.bearer_token_file
      ? readSecretFile('ingest.reconcile.bearer_token_file', rc.bearer_token_file)
      : null;
    startReconcileLoop(
      parseDuration('ingest.reconcile.interval', rc.interval),
      signal,
      async () => {
        if (!leader.isLeader()) {
          return { added: 0, resolved: 0, sources: [] };
        }
        return reconcileOnce(
          pool,
          c.cluster_id,
          {
            alertmanagerUrl: rc.alertmanager_url ?? null,
            prometheusUrl: rc.prometheus_url ?? null,
            bearerToken: bearer,
            timeoutMs: 10_000,
          },
          ingest,
          metrics,
          c.ingest.self_label,
          c.ingest.watchdog_alertname,
        );
      },
      metrics,
      (ok) => (reconcileOk = ok),
    );
  }

  if (worker) {
    new WorkerEventMirror(pool, worker.url, worker.token, () => notify.syncNow()).run(signal);
  }

  let informer: Awaited<ReturnType<typeof startInformerTopology>> | null = null;
  if (c.topology.source === 'informer' && serve !== 'console') {
    informer = startInformerTopology({
      store: topology,
      clusterId: c.cluster_id,
      kubeconfigPath: c.topology.kubeconfig,
      signal,
      componentTypes: packs.componentTypes(),
      conventions: packs.conventions(),
    });
  }

  const conditions = new ConditionPublisher(pool, 'server', c.cluster_id, metrics);
  const workerConditions = new ConditionPublisher(pool, 'worker', c.cluster_id, metrics);
  every(
    15_000,
    async () => {
      const srcs = await pool.query<{ source_id: string; last_received_at: Date }>(
        'SELECT source_id, last_received_at FROM server.ingest_sources',
      );
      const fails = await pool.query<{ channel: string; last_error: string }>(
        'SELECT channel, max(last_error) AS last_error FROM server.notify_messages WHERE last_error IS NOT NULL AND delivered_hash IS DISTINCT FROM desired_hash AND attempts >= 3 GROUP BY channel',
      );
      const restored = await pool.query<{ v: string | null }>(
        "SELECT value #>> '{}' AS v FROM server.system_state WHERE key = 'restored_at'",
      );
      const frozen = await pool.query<{ cluster_id: string }>(
        'SELECT cluster_id FROM server.spoke_status WHERE conditions @> \'[{"type":"Freeze","status":"True"}]\'',
      );
      await conditions.publish(
        serverConditions({
          ingestSources: c.ingest.sources.map((s) => ({
            id: s.id,
            lastReceivedAt: srcs.rows.find((x) => x.source_id === s.id)?.last_received_at ?? null,
          })),
          silenceThresholdMs: parseDuration('ingest.silence_threshold', c.ingest.silence_threshold),
          lastWatchdogAt: ingest.lastWatchdogAt,
          reconcile: {
            enabled: reconcileEnabled,
            lastAt: srcs.rows.find((x) => x.source_id === 'reconcile')?.last_received_at ?? ingest.lastReconcileAt,
          },
          startedAt,
          reconcileOk,
          // 标签档案按需重新探测（失败时每 60 秒、成功时每小时）
          evidenceDatasourceError: await evidenceSource.dataSource(Date.now()).then(() => evidenceSource.error),
          changeSources: await changes.statuses(),
          packFailures: packs.failures,
          packsDisabled: packs.set.disabled,
          degraded,
          storm: scheduler.stormMode,
          budgetRatio: scheduler.budgetRatio,
          audit: {
            ...auditStatus,
            thresholdSeconds: parseDuration('audit.export_lag_threshold', c.audit.export_lag_threshold) / 1000,
          },
          channelFailures: [
            ...fails.rows.map((f) => ({ channel: f.channel, error: f.last_error })),
            ...(issues ? await issueFailures(pool) : []),
          ],
          restoredAt: restored.rows[0]?.v ? new Date(restored.rows[0].v) : null,
          frozenClusters: frozen.rows.map((x) => x.cluster_id),
          now: new Date(),
        }),
      );
      await workerConditions.publish(workerRouteConditions(scheduler.modelRoutes()));
      await expireReaderConditions(
        pool,
        parseDuration('topology.reader_offline_after', c.topology.reader_offline_after),
        { clusterId: c.cluster_id, usesReader: c.topology.source === 'reader' },
      );
    },
    '状态条件',
  );

  await notify.start(signal);
  void leader
    .acquired()
    .then(() => pipeline.kick().catch((e: unknown) => logger.error('事件流水线失败', { error: e })));
  logger.info('server 已启动', { api: apiUrl, profile: c.profile, cluster_id: c.cluster_id });

  return {
    app,
    pool,
    config: c,
    metrics,
    notify,
    pipeline,
    ingest,
    proposals,
    issues,
    leader,
    apiUrl,
    async stop() {
      abort.abort();
      timers.forEach(clearInterval);
      await notify.stop();
      await informer?.stop();
      await leader.stop();
      await app.close();
      for (const s of aux) {
        s.close();
      }
      await listener.stop();
      await pool.end();
    },
  };
}

/** `--role=server` 入口。 */
export async function run(args: RoleArgs): Promise<void> {
  const config = loadServerConfig(args.configPath);
  const h = await buildServer({
    config,
    pg: pgConfigFromEnv(process.env, config.database.password_file),
    serve: args.serve,
  });
  const shutdown = (sig: string) => {
    logger.info('收到信号，停止 server', { signal: sig });
    void h.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

/** 事件 issue 的投递问题（状态条显示为 ChannelDeliveryFailed，channel 为 github-issues）：最近 1 小时重试 3 次以上或放弃的 issue 与评论 */
async function issueFailures(pool: pg.Pool): Promise<Array<{ channel: string; error: string }>> {
  const r = await pool.query<{ last_error: string }>(
    `SELECT last_error FROM (
       SELECT last_error, updated_at AS at FROM server.github_issues
        WHERE last_error IS NOT NULL AND (state = 'failed' OR (state = 'pending' AND attempts >= 3))
       UNION ALL
       SELECT last_error, next_attempt_at AS at FROM server.github_issue_comments
        WHERE posted_at IS NULL AND attempts >= 3 AND last_error IS NOT NULL) x
      WHERE at > now() - interval '1 hour' ORDER BY at DESC LIMIT 1`,
  );
  return r.rows.map((x) => ({ channel: 'github-issues', error: x.last_error }));
}
