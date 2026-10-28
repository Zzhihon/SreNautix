import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import type { ChangeEvent } from '@srenautix/contract';
import { setExternalLabels, type ResolvedRcaParams } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { registerReadLimit } from '../api/read-limit.js';
import { createApp } from '../api/http.js';
import { leaseLeader, neverLeader, singleLeader, type Leader } from '../api/leader.js';
import { registerGoalRoutes } from '../api/routes-goals.js';
import { registerGoalTaskRoutes } from '../api/routes-goal-tasks.js';
import { createOptimization } from '../optimize/service.js';
import { registerProposalRoutes } from '../api/routes-proposals.js';
import { optimizationCatalog } from '../optimize/catalog.js';
import { OptimizationStore } from '../optimize/store.js';
import { registerResearchRoutes } from '../api/routes-research.js';
import { pgConfigFromEnv } from '../config/database.js';
import { parseDuration, parseListen, readSecretFile } from '../config/files.js';
import { externalRootSettings, loadServerConfig, opsRepositories, type ServerConfig } from '../config/server.js';
import { noveltyOptions } from '../config/novelty.js';
import { kubernetesRollouts } from '../changes/kubernetes.js';
import { ksmRollouts } from '../changes/ksm-rollouts.js';
import { MetricsChanges } from '../changes/metrics-changes.js';
import { mergeChanges } from '../changes/pending-sync.js';
import { changesInWindow, ChangesService } from '../changes/service.js';
import { ConditionPublisher, serverConditions, workerRouteConditions } from '../console-bff/conditions.js';
import { IntegrationRegistry } from '../console-bff/integrations.js';
import { registerAlertRoutes } from '../console-bff/routes-alerts.js';
import { registerEvalRoutes } from '../console-bff/routes-eval.js';
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
import { LocalAdmin, recordLocalAdminTotpSetting } from '../identity/local-admin.js';
import { Oidc } from '../identity/oidc.js';
import { registerAuthRoutes } from '../identity/routes.js';
import { Sessions } from '../identity/sessions.js';
import { IncidentEngine } from '../incident/engine.js';
import { IncidentPipeline, listenIngest } from '../incident/pipeline.js';
import { AlertmanagerAdditions, reconcileFromReader, reconcileOnce, startReconcileLoop } from '../ingest/reconcile.js';
import { ReaderProtocol } from '../topology/protocol.js';
import { ReaderClock, ReaderRequestQueue, registerReaderRoutes } from '../topology/reader-routes.js';
import { expireSpokeConditions } from '../console-bff/spoke-conditions.js';
import { IngestService } from '../ingest/service.js';
import { configureLog, logger } from '../log.js';
import type { RoleArgs } from '../main.js';
import { ServerMetrics, startMetricsServer } from '../metrics.js';
import { ServerNotifyActions } from '../notify/actions.js';
import { NotifyService } from '../notify/index.js';
import { ExternalRoots, externalTypeLookup, pgImpactAlerts, topologyPaths } from '../notify/external.js';
import { PgMessageSource, ReportSource } from '../notify/source.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../proposals/catalog.js';
import { EvalCandidates } from '../proposals/candidates.js';
import { FeedbackService, type Closure } from '../proposals/feedback.js';
import { Policies } from '../proposals/policy.js';
import { ProposalService } from '../proposals/service.js';
import { SpokeRelay } from '../proposals/spoke.js';
import { Scheduler } from '../scheduler/admission.js';
import { WorkerEventMirror } from '../scheduler/worker-events.js';
import { DegradedLane } from '../stage-a/degraded.js';
import { PackEvidence, PackRules } from '../stage-a/pack-evidence.js';
import { EvidenceSource, evidenceCapabilities, PackRuntime } from '../stage-a/packs.js';
import { StageAService } from '../stage-a/service.js';
import { loadEd25519Private } from '../store/audit.js';
import { keyringFrom, type Keyring } from '../proposals/assertion.js';
import { AuditExporter, s3Client } from '../store/audit-export.js';
import { purgeIdempotencyKeys } from '../store/idempotency.js';
import { afterCorrections } from '../store/corrections.js';
import { migrateExpand, migrationsReady } from '../store/migrate.js';
import { migrateWhenReady } from '../store/migrate-when-ready.js';
import type { OutboxEvent } from '../store/outbox.js';
import { createPool, type PgConfig, type Queryable } from '../store/pool.js';
import { ComponentExpander, hintOf } from '../topology/expand.js';
import { startInformerTopology } from '../topology/informer.js';
import { KubeTools } from '../research/kube-tools.js';
import { FirstSeen, objectHealth, type K8sObject } from '../detectors/health.js';
import { DetectorService, detectorSettings } from '../detectors/service.js';
import { GitHubApp, RepoRoles } from '../github/app.js';
import { ClosureTracker } from '../github/closures.js';
import { CoverageIssues } from '../github/coverage-issues.js';
import { IssueService, type IssueReport } from '../github/issues.js';
import { TopologyOverrides } from '../topology/overrides.js';
import { TopologyStore } from '../topology/store.js';
import { TopologyTargets } from '../topology/targets.js';
import { RemediationChanges } from '../remediation/dedupe.js';
import { GitOpsPulls } from '../remediation/pulls.js';
import { RemediationService } from '../remediation/service.js';
import { GitRepositoryTargets } from '../remediation/targets.js';
import { serverCorrections, serverTracks } from './server-schema.js';

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
  /** 集群状态检测器（detectors.enabled）；关闭时为 null */
  detectors: DetectorService | null;
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

/**
 * 被抑制的告警：告警源静默的（silenced），或命中状态库里的抑制规则（matchers 是标签等值条件，全部满足的告警被抑制），
 * 只影响 SreNautix 自己的消息与研判。告警源的抑制规则（inhibited）不算：它说明另一条触发中的告警能解释这条告警。
 * 返回 alert_id → 抑制的原因：最早创建的命中规则的 reason，只被告警源静默时为“告警源静默”
 */
export async function suppressedAlerts(
  c: pg.PoolClient | pg.Pool,
  clusterId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) {
    return new Map();
  }
  const r = await c.query<{ alert_id: string; rule: string | null }>(
    `SELECT a.alert_id, (SELECT s.reason FROM server.suppressions s
                          WHERE s.cluster_id = $1 AND s.expires_at > now() AND a.labels @> s.matchers
                          ORDER BY s.created_at LIMIT 1) AS rule
       FROM server.alert_state a
      WHERE a.alert_id = ANY($2::text[]) AND (a.suppressed = 'silenced' OR EXISTS (
        SELECT 1 FROM server.suppressions s WHERE s.cluster_id = $1 AND s.expires_at > now() AND a.labels @> s.matchers))`,
    [clusterId, ids],
  );
  return new Map(r.rows.map((x) => [x.alert_id, x.rule ?? '告警源静默']));
}

/** 组装 server 角色的全部组件并启动 HTTP 接口与后台循环。 */
export async function buildServer(o: BuildOptions): Promise<ServerHandle> {
  const c = o.config;
  const serve = o.serve ?? 'api';
  configureLog(c.log_level, { role: 'server', cluster_id: c.cluster_id, serve });
  // 告警身份去掉 Prometheus 的 external labels：webhook、对账与 reader 快照共用（ADR 0117）
  setExternalLabels(c.ingest.external_labels);
  const metrics = new ServerMetrics('server', !o.noAuxListeners);
  const pool = createPool(o.pg, 'srenautix-server', c.database.pool_size, () =>
    metrics.pgStatementTimeouts.inc({ pool: 'server' }),
  );
  // db bootstrap 还没完成时重试并保持 not ready，而不是退出（ADR 0102）
  const applied = await migrateWhenReady('server', () => migrateExpand(pool, 'server', serverTracks), {
    probes: o.noAuxListeners ? null : parseListen('listen.probes', c.listen.probes),
  });
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
          totpRequired: c.identity.local_admin.totp_required,
        },
        lockout,
      )
    : null;
  if (localAdmin) {
    // 开关的变化写入治理审计链；关闭时每次启动都打警告（ADR 0118）
    await recordLocalAdminTotpSetting(pool, localAdmin.totpRequired);
    if (!localAdmin.totpRequired) {
      logger.warn(
        '本地管理员登录不要求 TOTP（identity.local_admin.totp_required=false），只凭口令即可登录；H 档审批的重新认证仍要求 TOTP',
        {
          username: localAdmin.username,
        },
      );
    }
  }
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
  const topology = new TopologyStore(pool, (query, source, seconds) =>
    metrics.topologyQuery.observe({ query, source }, seconds),
  );
  const expander = new ComponentExpander(topology);
  // 拓扑覆盖：Git 挂载的目录，与角色绑定、策略一起定期重新加载
  const loadOverrides = () =>
    c.topology.overrides_dir ? TopologyOverrides.load(c.topology.overrides_dir) : TopologyOverrides.empty();
  let overrides = loadOverrides();
  // GitHub App（安装令牌）：拓扑覆盖 PR、事件 issue、GitHub 变更源共用
  const gh = c.github_app;
  // 配置了业务仓库时请求白名单按仓库角色判断（ADR 0146 §6.4）：业务仓库只读代码、只创建 issue 与评论，
  // ops 仓库照旧，其余仓库一律拒绝；没有业务仓库时与之前相同，所有仓库按 ops 角色判断
  const businessRepo = c.optimization.repositories.business?.repo ?? null;
  const roles = businessRepo
    ? new RepoRoles([...opsRepositories(c).map((r) => [r, 'ops'] as const), [businessRepo, 'business'] as const])
    : null;
  const github = gh
    ? new GitHubApp(
        {
          apiBase: gh.api_base,
          appId: gh.app_id,
          installationId: gh.installation_id,
          privateKey: readSecretFile('github_app.private_key_file', gh.private_key_file),
        },
        Date.now,
        roles,
      )
    : null;
  // 提议目标的机器推导：集群对象查拓扑；gitops_pr 的 GitRepository 取 base 分支当前的提交（ADR 0108）
  const targets = new GitRepositoryTargets(new TopologyTargets(pool), () => github);
  // 事件报告（通知与 issue 共用，ADR 0125）：需要领域包的告警目录，在领域包加载之后创建；issue 只在后台循环中使用它
  let reports: ReportSource | null = null;
  const issueReport: IssueReport = (incidentId, language) => {
    if (!reports) {
      throw new Error('事件报告还没有初始化');
    }
    return reports.message(incidentId, language);
  };
  // 外部上游的事件不开 issue（ADR 0147）：消息来源在领域包加载之后创建
  let messageSource: PgMessageSource | null = null;
  const issueExternal = (incidentId: string) => messageSource?.externalState(incidentId) ?? Promise.resolve(null);
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
          issueReport,
          (clusterId, key, at) => topology.ownerOf(clusterId, key, at),
          issueExternal,
        )
      : null;
  const prom = c.datasources.prometheus;
  const loki = c.datasources.loki;
  const packs = await PackRuntime.load({
    dirs: c.packs.dirs,
    only: c.packs.only ?? null,
    lockFile: c.packs.lock_file ?? null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: evidenceCapabilities(loki !== undefined),
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
  const evidenceSource = await EvidenceSource.create(
    {
      id: 'prometheus',
      url: prom.url,
      dialect: prom.dialect,
      bearerTokenFile: prom.bearer_token_file ?? null,
      timeoutMs: parseDuration('datasources.prometheus.timeout', prom.timeout),
    },
    loki
      ? {
          id: 'loki',
          url: loki.url,
          bearerTokenFile: loki.bearer_token_file ?? null,
          tenant: loki.tenant ?? null,
          labels: loki.labels,
          timeoutMs: parseDuration('datasources.loki.timeout', loki.timeout),
        }
      : null,
  );
  const evidenceOptions = {
    locale: c.stage_a.language === 'zh' ? ('zh-CN' as const) : ('en' as const),
    concurrency: prom.concurrency,
    queryTimeoutMs: parseDuration('datasources.prometheus.timeout', prom.timeout),
    // 长期事件的卡片窗口（ADR 0149）
    maxCardWindowMs: parseDuration('stage_a.card_window_max', c.stage_a.card_window_max),
    metricsRetentionMs: c.stage_a.metrics_retention
      ? parseDuration('stage_a.metrics_retention', c.stage_a.metrics_retention)
      : null,
    // 证据基线（ADR 0153）
    novelty: noveltyOptions(c.stage_a.novelty),
  };
  const evidence = new PackEvidence(
    packs,
    evidenceSource,
    (clusterId, key) => topology.componentType(clusterId, key),
    evidenceOptions,
    metrics,
    // 逻辑组件映射到候选工作负载（ADR 0130）
    (clusterId, key, alerts, at) =>
      expander.logicalCandidates(
        clusterId,
        key,
        alerts.map((a) => hintOf(a.labels)),
        at,
      ),
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

  // 领导者：取得主实例之后先执行数据修正（ADR 0176），完成之前不做任何单活工作
  const holder = process.env.POD_NAME ?? hostname();
  const leader =
    serve === 'console'
      ? neverLeader()
      : afterCorrections(
          c.leader.mode === 'lease'
            ? leaseLeader({
                namespace: c.leader.namespace,
                name: c.leader.name,
                durationMs: parseDuration('leader.duration', c.leader.duration),
                kubeconfigPath: c.topology.kubeconfig,
                identity: holder,
              })
            : singleLeader(),
          pool,
          serverCorrections,
          holder,
        );

  // 通知与 issue 的事件报告（ADR 0125）
  reports = new ReportSource(
    pool,
    feedback,
    topology,
    {
      alertTitle: (a, language) => {
        const title = alertCatalog.lookup(a.labels)?.entry.title;
        return title
          ? ((language === 'zh' ? (title['zh-CN'] ?? title.en) : (title.en ?? title['zh-CN'])) ?? null)
          : null;
      },
      actionVerify: (actionId) => {
        const v = catalog.get(actionId)?.verify;
        return v ? { windowSeconds: v.window_seconds, checks: v.checks.map((x) => x.description) } : null;
      },
      links: {
        metricsExploreUrl: c.links.metrics_explore_url ?? null,
        logsExploreUrl: c.links.logs_explore_url ?? null,
        alertmanagerUrl: c.links.alertmanager_url ?? null,
        argocdUrl: c.links.argocd_url ?? null,
        gitCommitUrl: c.links.git_commit_url ?? null,
      },
    },
    { prefix: c.notify.prefix, consoleUrl: c.public_url },
    (clusterId, key, at) => topology.ownerOf(clusterId, key, at),
  );
  // 外部上游的周期汇总（ADR 0147）：组件类型取拓扑节点上匹配出的类型，节点不在拓扑里（provider、model 这类
  // 只来自告警的实体）时按 kind 与名字匹配领域包的组件类型。业务影响按与上游事件的相关性判定（ADR 0150）：
  // 时间窗，或在上游根因 topology_hops 跳以内的子图上找依赖路径
  const xr = c.notify.digest.external_roots;
  const bi = xr.business_impact;
  const externalRoots = xr.enabled
    ? new ExternalRoots(
        pgImpactAlerts(pool),
        externalRootSettings(xr, c.notify.business_impact_alerts),
        externalTypeLookup(
          () => packs.componentTypes(),
          (clusterId, key) => topology.componentType(clusterId, key),
        ),
        topologyPaths(
          (clusterId, seeds, t, hops) => topology.subgraph(clusterId, seeds, t, null, hops),
          bi.topology_hops,
          o.now ?? Date.now,
        ),
        o.now ?? Date.now,
      )
    : null;
  const source = new PgMessageSource(
    pool,
    {
      prefix: c.notify.prefix,
      consoleUrl: c.public_url,
      severities: c.notify.severities,
      resolvedRetentionMs: parseDuration('notify.resolved_retention', c.notify.resolved_retention),
      businessImpactAlerts: c.notify.business_impact_alerts,
    },
    proposals,
    reports,
    externalRoots,
  );
  messageSource = source;
  const notify = new NotifyService({
    pool,
    config: c.notify,
    publicUrl: c.public_url,
    source,
    actions: new ServerNotifyActions(pool, proposals, feedback, chatLinks),
    metrics,
    isLeader: () => leader.isLeader(),
    acquired: () => leader.acquired(),
    ...(o.now ? { now: o.now } : {}),
  });
  // server 判定研判结束（租约过期）后，群消息出现研判失败的说明
  scheduler.onEnded = () => notify.syncNow();

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
  // 变更源的变更加上从拓扑事件推导的 Kubernetes 发布（ADR 0104）
  // kube-state-metrics 的发布推导：事件引擎每次重算都会调用，结果按分钟缓存 60 秒，数据源报错时记日志并跳过
  let ksmCache: { key: string; at: number; out: ChangeEvent[] } | null = null;
  const ksmFallback = async (from: Date, to: Date, ro: Parameters<typeof ksmRollouts>[4]): Promise<ChangeEvent[]> => {
    const minute = (d: Date) => Math.floor(d.getTime() / 60_000);
    const key = `${minute(from)}:${minute(to)}`;
    if (ksmCache && ksmCache.key === key && Date.now() - ksmCache.at < 60_000) {
      return ksmCache.out;
    }
    try {
      const ds = await evidenceSource.dataSource(to.getTime());
      const out = await ksmRollouts(pool, (req) => ds.query(req), from, to, ro);
      ksmCache = { key, at: Date.now(), out };
      return out;
    } catch (e) {
      logger.warn('从 kube-state-metrics 推导发布失败，本次只用拓扑事件', {
        error: e instanceof Error ? e.message : e,
      });
      return [];
    }
  };
  // 退役与已合并、尚未同步的提交（ADR 0161）：从证据数据源的指标推导，只对本集群
  const metricsChanges = new MetricsChanges({
    pool,
    topology,
    clusterId: c.cluster_id,
    dataSource: (at) => evidenceSource.dataSource(at),
    retirements: c.changes.kubernetes.enabled && c.changes.kubernetes.retirements,
    pendingSync: {
      enabled: c.changes.pending_sync.enabled,
      lookbackMs: parseDuration('changes.pending_sync.lookback', c.changes.pending_sync.lookback),
    },
    groupWithinMs: parseDuration('changes.kubernetes.group_within', c.changes.kubernetes.group_within),
  });
  const engineChanges = async (clusterId: string, from: Date, to: Date): Promise<ChangeEvent[]> => {
    const stored = await changesInWindow(pool, clusterId, from, to);
    const own = clusterId === c.cluster_id;
    // 未同步的提交可能早于变更窗口（漂移告警要持续很久才触发），按 change_id 并入，替换窗口内同一个提交
    const pending = own ? await metricsChanges.pendingSync(to) : [];
    const k = c.changes.kubernetes;
    if (!k.enabled) {
      return mergeChanges(stored, pending);
    }
    const ro = {
      clusterId,
      revisionLabels: k.revision_labels,
      groupWithinMs: parseDuration('changes.kubernetes.group_within', k.group_within),
      preStepLabels: k.pre_step_labels,
    };
    const derived = await kubernetesRollouts(pool, from, to, ro);
    // informer 空窗时拓扑里没有的发布：从 kube-state-metrics 推导（ADR 0104 §11）；只对本集群，数据源不可用时跳过
    const fromKsm = k.ksm_fallback && own ? await ksmFallback(from, to, ro) : [];
    const retired = own ? await metricsChanges.retirements(from, to) : [];
    return mergeChanges([...stored, ...derived, ...fromKsm, ...retired], pending);
  };
  const engine = new IncidentEngine({
    pool,
    topology,
    params,
    changes: engineChanges,
    probes: async () => [],
    stale: proposals,
    metrics,
    suppressedAlerts: (cl, clusterId, ids) => suppressedAlerts(cl as pg.PoolClient, clusterId, ids),
  });
  const stageA = new StageAService(
    pool,
    evidence,
    rules,
    proposals,
    metrics,
    () => packs.set.lockDigest,
    (cl, ids) => ingest.reresolve(cl, ids),
    // 业务影响告警：处置推导、通知与首条消息时延用同一个定义（ADR 0166）
    c.notify.business_impact_alerts,
  );
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

  // 变更源：有新变更时立即重算事件（变更进入根因排序的"30 分钟内的变更"一项）。SQL 审计表变更源（ADR 0151）
  // 只在 changes.sql_audit 有声明时连接业务库
  const changes = new ChangesService(
    pool,
    c.changes.sources,
    { github, defaultClusterId: c.cluster_id, sqlAudit: c.changes.sql_audit },
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
  // 主动优化（ADR 0146）：读取接口总是可用，写接口在 optimization.enabled 关闭时返回 503
  const goalCatalog = optimizationCatalog(packs.set);
  const goalStore = new OptimizationStore(pool);
  registerGoalRoutes(app, {
    pool,
    auth,
    store: goalStore,
    enabled: c.optimization.enabled,
    catalog: () => goalCatalog,
    cooldown: (domain) => packs.set.domains.get(domain)?.gates.cooldown ?? '30d',
  });
  // 目标运行的数据源、runner、建议与投递、验证循环：只在 optimization.enabled 时创建（关闭时不连接 dbstats、不读业务仓库）
  const optimization = c.optimization.enabled
    ? await createOptimization({
        config: c,
        pool,
        store: goalStore,
        set: () => packs.set,
        evidenceSource,
        topology,
        github,
        proposals,
        registry: metrics.registry,
        storm: () => scheduler.stormMode,
        budgetExhausted: () => scheduler.optimizationBudgetExhausted(),
        locale: evidenceOptions.locale,
        queryTimeoutMs: evidenceOptions.queryTimeoutMs,
        auditRelations: (conn) => changes.auditRelations(conn),
      })
    : null;
  registerGoalTaskRoutes(app, {
    pool,
    auth,
    evidence: optimization?.evidence ?? null,
    publisher: optimization?.publisher ?? null,
  });
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
    clusterId: c.cluster_id,
    kube: c.kube_reads.enabled
      ? new KubeTools(c.kube_reads.kubeconfig ?? c.topology.kubeconfig, {
          tailLines: c.kube_reads.tail_lines,
          maxBytes: c.kube_reads.max_bytes,
        })
      : null,
    changes: engineChanges,
    stageA,
    expander,
    // 处置推导的依据（ADR 0138）：修复模板只在自愈 PR 能生成时（启用并配置了 github_app）算作 act 的依据
    dispositionFacts: {
      lookup: {
        concrete: (clusterId, key, at, hints) => expander.concrete(clusterId, key, at, hints),
        componentType: (clusterId, key) => topology.componentType(clusterId, key),
        componentTypes: () => packs.componentTypes(),
        owner: (clusterId, key, at) => topology.ownerOf(clusterId, key, at),
        managers: (clusterId, key, at) => topology.targets(clusterId, key, 'managed_by', at),
      },
      categories: c.remediation.enabled && github ? c.remediation.categories : [],
      impactAlerts: c.notify.business_impact_alerts,
    },
  });
  registerIncidentRoutes(app, { pool, auth, feedback, topology, evidence, worker });
  registerEvalRoutes(app, { pool, auth, candidates: new EvalCandidates(pool) });
  registerAlertRoutes(app, {
    pool,
    auth,
    selfLabel: c.ingest.self_label,
    watchdogAlertname: c.ingest.watchdog_alertname,
  });
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
    onHealth: c.detectors.enabled
      ? (clusterId, objects, complete, observedAt) => detectors!.report(clusterId, objects, complete, observedAt)
      : null,
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
  // 主动优化（ADR 0146）：目标运行、建议与投递每 loop_interval 一轮，验证循环每 10 分钟一轮（§6.3）；上一轮没有结束时跳过
  if (optimization) {
    const single = (fn: () => Promise<unknown>) => {
      let busy = false;
      return async () => {
        if (busy) {
          return;
        }
        busy = true;
        try {
          await fn();
        } finally {
          busy = false;
        }
      };
    };
    every(
      optimization.loopMs,
      single(() => optimization.runner.runOnce(signal)),
      '目标运行',
    );
    every(
      optimization.loopMs,
      single(async () => {
        await optimization.publisher.recommendOnce();
        await optimization.publisher.deliverOnce();
      }),
      '优化建议与投递',
    );
    every(
      10 * 60_000,
      single(() => optimization.verifier.runOnce(signal)),
      '优化建议的验证',
    );
  }
  // 自愈 PR（ADR 0108）：研判结论 → 领域包的修复模板 → 校验 → gitops_pr 提议；gateway 开出的 PR 关联到事件 issue 与通知
  const closures = (cl: Queryable, x: Closure) => feedback.recordClosure(cl, x);
  const rejectedCooldownMs = parseDuration('remediation.rejected_cooldown', c.remediation.rejected_cooldown);
  if (github) {
    const pulls = new GitOpsPulls(pool, github, issues, metrics);
    every(30_000, () => pulls.runOnce(), 'gitops_pr 的 PR 关联');
    // 关闭的跟踪（ADR 0174）：每 10 分钟刷新打开的自愈 PR 与事件 issue，关闭且没有合并、以 not planned 关闭时写隐式反馈与评测候选
    const tracker = new ClosureTracker(
      pool,
      github,
      new RemediationChanges(pool, github, rejectedCooldownMs, closures),
      closures,
    );
    every(10 * 60_000, () => tracker.runOnce(), '关闭的跟踪');
  }
  const rm = c.remediation;
  if (rm.enabled) {
    if (!github) {
      logger.warn('remediation.enabled 需要 github_app 读取仓库，自愈 PR 不会生成');
    } else {
      const remediation = new RemediationService(
        pool,
        {
          repositories: rm.repositories,
          categories: rm.categories,
          conclusions: rm.conclusions,
          titlePrefix: (rm.title_prefix ?? c.notify.prefix).trim(),
          language: c.stage_a.language,
          consoleUrl: c.public_url,
          maxPerRun: 2,
          lookbackMs: 6 * 3600_000,
          // 外部上游的汇总配置（ADR 0147）同样标记告警调优模板不降级的告警（ADR 0155）
          externalAlerts: xr.enabled
            ? { components: xr.components, alertLabels: xr.alert_labels }
            : { components: [], alertLabels: {} },
          rejectedCooldownMs,
        },
        {
          packs: () => packs.set,
          componentTypes: () => packs.componentTypes(),
          componentType: (clusterId, key) => topology.componentType(clusterId, key),
          concrete: (clusterId, key, at, hints) => expander.concrete(clusterId, key, at, hints),
          owner: (clusterId, key, at) => topology.ownerOf(clusterId, key, at),
          managers: (clusterId, key, at) => topology.targets(clusterId, key, 'managed_by', at),
          dataSource: (at) => evidenceSource.dataSource(at),
          github,
          proposals,
          issueRef: issues
            ? async (incidentId, fromRepo) => {
                const i = await issues.ensure(incidentId, 'repo_change');
                return i ? GitHubApp.ref(fromRepo, i.repo, i.number) : null;
              }
            : null,
          linkPull: issues
            ? (incidentId, pull) =>
                issues.link(incidentId, {
                  kind: 'pull',
                  url: pull.url,
                  title: pull.title,
                  repo: pull.repo,
                  number: pull.number,
                  refsInBody: false,
                })
            : null,
          closures,
          metrics,
        },
      );
      every(30_000, () => remediation.runOnce(), '自愈 PR');
    }
  }
  // 领域包变化后重算仍在触发的事件的阶段 A（ADR 0107）：限速，只算阶段 A，不触发模型
  if (c.stage_a.recompute_per_minute > 0) {
    every(
      60_000,
      async () => {
        for (const id of await stageA.stale(c.cluster_id, c.stage_a.recompute_per_minute)) {
          await stageA.recompute(id, 'pack_change');
        }
      },
      '领域包变化后的阶段 A 重算',
    );
  }
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
          url: `${c.public_url.replace(/\/+$/, '')}/actions/${p.proposal_id}`,
          title: `${p.action}: ${String((p.params as { title?: unknown }).title ?? p.target.display)}`,
          repo: null,
          number: null,
          refsInBody,
        }),
    });
    every(parseDuration('issues.interval', c.issues!.interval), () => issues.runOnce(), '事件 issue');
    // 拓扑与领域包覆盖的缺口（ADR 0171）：每个 (集群, 告警名) 一个 issue，标签另加 coverage，每小时上限与事件 issue 共用
    const coverage = new CoverageIssues(
      pool,
      github!,
      {
        repo: c.issues!.repo,
        labels: c.issues!.labels,
        titlePrefix: (c.issues!.title_prefix ?? c.notify.prefix).trim(),
        maxPerHour: c.issues!.max_per_hour,
        lookbackMs: parseDuration('issues.lookback', c.issues!.lookback),
        consoleUrl: c.public_url,
        language: c.stage_a.language,
      },
      metrics,
    );
    every(parseDuration('issues.interval', c.issues!.interval), () => coverage.runOnce(), '覆盖缺口 issue');
  }
  every(3600_000, () => purgeIdempotencyKeys(pool), '幂等键清理');
  every(3600_000, () => sessions.purgeExpired(), '会话清理');
  // 拓扑历史压缩（ADR 0144）：删除保留期之前已经关闭的行
  const topologyRetentionMs = parseDuration('topology.history_retention', c.topology.history_retention);
  every(
    3600_000,
    async () => {
      const r = await topology.compact(topologyRetentionMs);
      metrics.topologyCompacted.inc(r.deleted);
      if (r.deleted || r.backfilled) {
        logger.info('拓扑历史已压缩', { deleted: r.deleted, backfilled: r.backfilled });
      }
    },
    '拓扑历史压缩',
  );
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
    const additionsMs = parseDuration('ingest.reconcile.additions_interval', rc.additions_interval);
    const additions =
      rc.alertmanager_url && additionsMs > 0
        ? new AlertmanagerAdditions(
            c.cluster_id,
            rc.alertmanager_url,
            bearer,
            Math.min(10_000, additionsMs),
            ingest,
            metrics,
            c.ingest.self_label,
            c.ingest.watchdog_alertname,
          )
        : null;
    startReconcileLoop(
      parseDuration('ingest.reconcile.interval', rc.interval),
      signal,
      async () => {
        if (!leader.isLeader()) {
          // 不是主实例时不知道本地有哪些告警：重新成为主实例后等一轮完整对账再快速轮询
          additions?.reset();
          return { added: 0, resolved: 0, sources: [], firing: new Set<string>(), unseen: new Map<string, string[]>() };
        }
        const r = await reconcileOnce(
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
        additions?.update(r);
        return r;
      },
      metrics,
      (ok) => (reconcileOk = ok),
    );
    if (additions) {
      // 上一轮没有结束时跳过（Alertmanager 应答慢时不堆积请求）
      let busy = false;
      const t = setInterval(() => {
        if (busy || !leader.isLeader()) {
          return;
        }
        busy = true;
        additions
          .pollOnce()
          .catch((e: unknown) => logger.warn('Alertmanager 新增告警的快速轮询失败，下一轮重试', { error: e }))
          .finally(() => (busy = false));
      }, additionsMs);
      t.unref();
      signal.addEventListener('abort', () => clearInterval(t), { once: true });
    }
  }

  if (worker) {
    new WorkerEventMirror(pool, worker.url, worker.token, () => notify.syncNow(), metrics).run(signal);
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

  // 集群状态检测器（ADR 0105）：单集群时由本进程的 informer 计算对象状态，多集群时由各 reader 上报
  const detectors = c.detectors.enabled
    ? new DetectorService(
        pool,
        detectorSettings(c.detectors),
        async (clusterId, alerts) => {
          await ingest.write(clusterId, 'detector', 'detector', alerts, { detector: alerts.length });
        },
        metrics,
        // 退出或失去主实例身份时不写入检测器告警（ADR 0128）
        () => leader.isLeader() && !signal.aborted,
      )
    : null;
  if (detectors) {
    const firstSeen = new FirstSeen();
    every(
      parseDuration('detectors.interval', c.detectors.interval),
      async () => {
        const objects = informer?.healthObjects() ?? null;
        if (objects) {
          const now = Date.now();
          await detectors.report(
            c.cluster_id,
            objectHealth(objects as unknown as K8sObject[], firstSeen, now),
            true,
            new Date(now),
          );
        }
        await detectors.scan();
      },
      '集群状态检测',
    );
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
        // 放弃的消息内容（ADR 0145）不再重试，不算投递失败
        'SELECT channel, max(last_error) AS last_error FROM server.notify_messages WHERE last_error IS NOT NULL AND delivered_hash IS DISTINCT FROM desired_hash AND abandoned_at IS NULL AND attempts >= 3 GROUP BY channel',
      );
      // 放弃投递的消息内容（ADR 0173）：最近 1 小时内放弃的，按渠道
      const abandoned = await pool.query<{ channel: string; messages: number; reasons: string[] }>(
        `SELECT channel, count(*)::int AS messages, array_agg(DISTINCT abandoned_reason ORDER BY abandoned_reason) AS reasons
           FROM server.notify_messages WHERE abandoned_at > now() - interval '1 hour' GROUP BY channel`,
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
          notifyAbandoned: abandoned.rows,
          restoredAt: restored.rows[0]?.v ? new Date(restored.rows[0].v) : null,
          frozenClusters: frozen.rows.map((x) => x.cluster_id),
          now: new Date(),
        }),
      );
      await workerConditions.publish(workerRouteConditions(scheduler.modelRoutes()));
      await expireSpokeConditions(
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
    detectors,
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
      await optimization?.close();
      await changes.close();
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
