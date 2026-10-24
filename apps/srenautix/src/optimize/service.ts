import { loadSqlParser, PostgresDbstatsAdapter, statementFingerprintSync } from '@srenautix/integration-sdk';
import type { PackSet } from '@srenautix/packs-sdk';
import type pg from 'pg';
import type { Registry } from 'prom-client';
import type { ServerConfig } from '../config/server.js';
import type { GitHubApp } from '../github/app.js';
import { OptimizationIssues } from '../github/optimization-issues.js';
import { logger } from '../log.js';
import type { ProposalService } from '../proposals/service.js';
import type { EvidenceSource } from '../stage-a/packs.js';
import type { TopologyStore } from '../topology/store.js';
import { parseStoredKey } from '../topology/keys.js';
import { KubeArgoReader } from './argo.js';
import { RepoCodeCache } from './code/tree.js';
import { GoalSources } from './datasource.js';
import { GoalEvidence } from './evidence.js';
import { packLoadGuard } from './guards.js';
import { BackendLimiter, OptimizationMetrics } from './limits.js';
import { GoalPublisher } from './publisher.js';
import { GoalRunner } from './runner.js';
import type { OptimizationStore } from './store.js';
import { GoalVerifier } from './verifier.js';

// server 的主动优化组装（ADR 0146 §2、§6）：只在 optimization.enabled 时创建。数据源、负载保护与信号量、runner、
// 建议与投递、验证循环；后台循环由 roles/server.ts 只在主实例上调度。

export interface OptimizationParts {
  sources: GoalSources;
  evidence: GoalEvidence;
  limiter: BackendLimiter;
  runner: GoalRunner;
  publisher: GoalPublisher;
  verifier: GoalVerifier;
  loopMs: number;
  close(): Promise<void>;
}

export interface OptimizationDeps {
  config: ServerConfig;
  pool: pg.Pool;
  store: OptimizationStore;
  set: () => PackSet;
  evidenceSource: EvidenceSource;
  topology: TopologyStore;
  github: GitHubApp | null;
  proposals: ProposalService;
  registry: Registry;
  storm: () => boolean;
  budgetExhausted: () => boolean;
  locale: 'zh-CN' | 'en';
  queryTimeoutMs: number;
}

const durationMs = (d: string) => {
  const m = /^(\d+)(s|m)$/.exec(d) as RegExpExecArray;
  return Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000);
};

export async function createOptimization(d: OptimizationDeps): Promise<OptimizationParts> {
  const c = d.config;
  const o = c.optimization;
  const metrics = new OptimizationMetrics(d.registry);
  const db = o.dbstats
    ? new PostgresDbstatsAdapter({
        id: 'dbstats',
        host: o.dbstats.host,
        port: o.dbstats.port,
        database: o.dbstats.database,
        user: o.dbstats.user,
        password_file: o.dbstats.password_file,
        ssl: o.dbstats.ssl,
        hourly_limit: o.limits.dbstats.per_hour,
        text_hourly_limit: o.limits.dbstats.statement_text_per_hour,
        onPrivilegeReport: (r) => {
          if (r.readable_tables.length) {
            logger.error('dbstats 的角色能读取业务表，集成不可用（DatasourceOverPrivileged）', {
              role: r.role,
              tables: r.readable_tables.slice(0, 10),
            });
          }
        },
      })
    : null;
  const dbCluster = o.dbstats?.cluster ?? null;
  const sources = new GoalSources(
    d.evidenceSource,
    db && dbCluster ? { id: 'dbstats', cluster: dbCluster, read: (req) => db.read(req) } : null,
  );
  // 负载保护（§6.2）在 limiter 里调用 evidence，evidence 又经 limiter 执行：先建 limiter，保护函数延迟取 evidence
  let evidence: GoalEvidence | null = null;
  const guardEntity = (backend: string) => {
    if (backend !== 'dbstats' || !dbCluster) {
      return null;
    }
    const p = parseStoredKey(dbCluster);
    return { cluster_id: c.cluster_id, kind: p.kind, namespace: p.namespace, name: p.name, node: null, uid: null };
  };
  const limiter = new BackendLimiter(o.limits, metrics, (backend, signal) =>
    packLoadGuard(d.set, evidence as GoalEvidence, guardEntity)(backend, signal),
  );
  evidence = new GoalEvidence(d.set, sources, limiter, { locale: d.locale, queryTimeoutMs: d.queryTimeoutMs });
  const runner = new GoalRunner({
    pool: d.pool,
    store: d.store,
    evidence,
    set: d.set,
    topology: (clusterId, at) => d.topology.at(clusterId, at),
    limiter,
    storm: d.storm,
    budgetExhausted: d.budgetExhausted,
    sampling: sources,
  });
  const business = o.repositories.business;
  let code: { cache: RepoCodeCache; fingerprint: (sql: string) => string | null } | null = null;
  if (business && d.github) {
    await loadSqlParser();
    code = { cache: new RepoCodeCache(d.github), fingerprint: (sql) => statementFingerprintSync(sql) };
  }
  const publisher = new GoalPublisher({
    pool: d.pool,
    store: d.store,
    set: d.set,
    github: d.github,
    repositories: c.remediation.repositories,
    business: business ? { repo: business.repo, code: business.code, default_branch: business.default_branch } : null,
    proposals: d.proposals,
    issues: business && d.github ? new OptimizationIssues(d.pool, d.github) : null,
    dataSource: (at) => d.evidenceSource.dataSource(at),
    code,
    language: c.stage_a.language,
    consoleUrl: c.public_url,
    titlePrefix: o.title_prefix,
  });
  const verifier = new GoalVerifier({
    pool: d.pool,
    store: d.store,
    evidence,
    set: d.set,
    github: d.github,
    proposals: d.proposals,
    language: c.stage_a.language,
    argo: o.argo ? new KubeArgoReader(c.kube_reads.kubeconfig ?? c.topology.kubeconfig, o.argo.namespace) : null,
  });
  return {
    sources,
    evidence,
    limiter,
    runner,
    publisher,
    verifier,
    loopMs: durationMs(o.loop_interval),
    close: async () => {
      await db?.close();
    },
  };
}
