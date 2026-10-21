import { createHash } from 'node:crypto';
import type { ComponentType, EvidenceResult, Incident, RepositoryLayout, ResearchOutput } from '@srenautix/contract';
import { displayComponentName, matchTypeByName } from '@srenautix/core';
import {
  applicableRemediations,
  planRemediation,
  type EvidenceDataSource,
  type PackSet,
  type RemediationContext,
  type RemediationPlan,
} from '@srenautix/packs-sdk';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { componentNames } from '../incident/names.js';
import { alertsById } from '../ingest/store.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { ProposalService } from '../proposals/service.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import type { ConcreteObject } from '../topology/expand.js';
import { GitHubRepoReader } from './github-repo.js';
import { alertsOf, branchOf, cardsOf, keyCards, prBody, say, validatePlan, type Lang } from './render.js';

/**
 * 自愈 PR（ADR 0108）：研判结束、结论等级在 remediation.conclusions 中时，按领域包的修复模板生成补丁，
 * 校验后以 gitops_pr 提议交给 gateway 开 PR（server 不写 Git）。
 * - 每次研判每个模板只处理一次（server.remediation_attempts）；没有适用模板时记一行 '-'；
 * - 提议的来源为 rule，规则名 remediation-pr：gateway 策略为 gitops_pr 列出这条自动执行规则时自动签发，否则等待人工审批；
 * - 每小时上限、分支前缀、reviewers 与 main 的守护在 gateway；冻结只约束集群写入，gitops_pr 照常；
 * - 基准分支在计划与提议之间前进时不提交，下一轮重新计划。
 */
export interface RemediationRepository {
  repo: string;
  base_branch: string;
  files: RepositoryLayout;
}

export interface RemediationSettings {
  repositories: Record<string, RemediationRepository>;
  categories: string[];
  conclusions: string[];
  titlePrefix: string;
  language: Lang;
  consoleUrl: string;
  /** 每次研判最多提交的提议数 */
  maxPerRun: number;
  /** 只处理这段时间内结束的研判 */
  lookbackMs: number;
}

export interface RemediationDeps {
  packs: () => PackSet;
  componentTypes: () => readonly ComponentType[];
  componentType: (clusterId: string, key: string) => Promise<string | null>;
  /** 组件键 → 拓扑里的具体对象（ComponentExpander.concrete） */
  concrete: (clusterId: string, key: string, at: Date) => Promise<ConcreteObject>;
  dataSource: (at: number) => Promise<EvidenceDataSource | null>;
  github: GitHubApp;
  proposals: ProposalService;
  /** 事件 issue 的引用（开 PR 之前确保 issue 存在）；没有开启事件 issue 时为 null */
  issueRef: ((incidentId: string, fromRepo: string) => Promise<string | null>) | null;
  metrics: ServerMetrics;
}

export const REMEDIATION_RULE = 'srenautix/remediation-pr';

/** 研判结论达到这些等级时，修复模板按研判的根因匹配与解析目标（ADR 0126）；其余情况用事件根因 */
export const RESEARCH_ROOT_LEVELS: ReadonlySet<string> = new Set(['likely', 'evidence_consistent']);

/** 修复模板使用的根因组件：研判结论达到 likely 时取研判的根因，否则取事件根因 */
export function remediationRootKey(
  run: { root_component: string | null; conclusion_level: string },
  inc: Pick<Incident, 'root'>,
): string | null {
  return run.root_component !== null && RESEARCH_ROOT_LEVELS.has(run.conclusion_level)
    ? run.root_component
    : inc.root.component;
}

interface RunRow {
  run_id: string;
  incident_id: string;
  incident_version: number;
  conclusion_level: string;
  disposition: string | null;
  root_component: string | null;
  summary: string | null;
  evidence_fingerprint: string | null;
  output: ResearchOutput | null;
}

interface Attempt {
  key: string;
  outcome: 'proposed' | 'skipped' | 'rejected' | 'failed';
  code: string | null;
  reason: string | null;
  category?: string | null;
  repository?: string | null;
  branch?: string | null;
  base?: string | null;
  proposalId?: string | null;
  files?: string[];
}

class Deferred extends Error {}

/**
 * 提议因绑定过时被拒绝（事件在读取与提议之间升了版本，例如对账补进一条告警）时最多重试的次数（ADR 0108 §13）。
 * 每 30 秒一轮，重试时按事件的当前版本重新判断：根因变了就等新版本的研判，只加了成员就绑定当前版本
 */
export const BINDING_RETRY_LIMIT = 5;

export class RemediationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly s: RemediationSettings,
    private readonly d: RemediationDeps,
  ) {}

  /** 一轮：处理最近结束、还没有处理过的研判 */
  async runOnce(limit = 5): Promise<number> {
    const r = await this.pool.query<RunRow>(
      `SELECT r.run_id, r.incident_id, r.incident_version, r.conclusion_level, r.disposition, r.root_component, r.summary,
              r.evidence_fingerprint, r.output
         FROM server.research_runs r
        WHERE r.state = 'completed' AND r.conclusion_level = ANY($1::text[])
          AND r.finished_at > now() - make_interval(secs => $2)
          AND (NOT EXISTS (SELECT 1 FROM server.remediation_attempts a WHERE a.run_id = r.run_id)
            -- 绑定过时的模板在上限内重试（ADR 0108 §13）；整次研判已判定不处理（key '-'）时不再重试
            OR (EXISTS (SELECT 1 FROM server.remediation_attempts a WHERE a.run_id = r.run_id
                          AND a.code = 'binding_stale' AND a.retries < $4)
                AND NOT EXISTS (SELECT 1 FROM server.remediation_attempts a WHERE a.run_id = r.run_id AND a.key = '-')))
        ORDER BY r.finished_at LIMIT $3`,
      [this.s.conclusions, this.s.lookbackMs / 1000, limit, BINDING_RETRY_LIMIT],
    );
    let n = 0;
    for (const run of r.rows) {
      try {
        n += await this.process(run);
      } catch (e) {
        if (e instanceof Deferred) {
          logger.info('自愈 PR 推迟到下一轮', { run_id: run.run_id, reason: e.message });
          continue;
        }
        logger.error('自愈 PR 处理失败', { run_id: run.run_id, error: e });
        await this.record(run, [
          { key: '-', outcome: 'failed', code: 'internal_error', reason: String((e as Error).message ?? e) },
        ]);
      }
    }
    return n;
  }

  private async process(run: RunRow): Promise<number> {
    const ir = await this.pool.query<{ body: Incident; version: number; state: string; suppressed: boolean }>(
      'SELECT body, version, state, suppressed FROM server.incidents WHERE incident_id = $1',
      [run.incident_id],
    );
    const row = ir.rows[0];
    const skipAll = (code: string, reason: string) =>
      this.record(run, [{ key: '-', outcome: 'skipped', code, reason }]).then(() => 0);
    if (!row || row.state === 'merged' || row.suppressed) {
      return skipAll('incident_closed', '事件已合并、被抑制或不存在');
    }
    // 事件在研判之后有了新版本：只有新版本触发了研判（根因、严重度或证据指纹变化，含被准入跳过的触发）时，这次研判的结论
    // 才算过时；只是加入了成员、其余不变的新版本不会再研判，结论仍然适用（ADR 0108 §10）
    if (row.version !== run.incident_version) {
      const newer = await this.pool.query<{ v: number }>(
        `SELECT max(incident_version)::int AS v FROM server.research_queue WHERE incident_id = $1 AND incident_version > $2`,
        [run.incident_id, run.incident_version],
      );
      const v = newer.rows[0]?.v;
      if (v !== null && v !== undefined) {
        return skipAll(
          'incident_changed',
          `事件已更新到版本 ${row.version}，版本 ${v} 重新触发了研判；这次研判针对版本 ${run.incident_version}`,
        );
      }
    }
    const inc = row.body;
    if (!inc.root.component) {
      return skipAll('no_root', '事件没有根因组件，提议无法绑定');
    }
    // 提议绑定事件的当前版本：版本没变时用研判自己的指纹；版本变了（指纹没有触发研判）时用当前版本阶段 A 的指纹
    const moved = row.version !== run.incident_version;
    const currentFp = async () =>
      (
        await this.pool.query<{ fp: string }>(
          'SELECT evidence_fingerprint AS fp FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2',
          [inc.incident_id, inc.incident_version],
        )
      ).rows[0]?.fp;
    const fp = moved ? await currentFp() : (run.evidence_fingerprint ?? (await currentFp()));
    if (!fp && moved) {
      throw new Deferred(`事件版本 ${row.version} 的阶段 A 报告还没有生成`);
    }
    if (!fp) {
      return skipAll('no_fingerprint', '没有当前版本的证据指纹');
    }
    const report = await this.pool.query<{ body: { cards: EvidenceResult[] } }>(
      'SELECT body FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2',
      [inc.incident_id, inc.incident_version],
    );
    const cards = report.rows[0]?.body.cards ?? [];
    const ctx = await this.context(inc, run, cards);
    const set = this.d.packs();
    const { applicable, errors } = applicableRemediations(set, ctx);
    for (const e of errors) {
      logger.warn('修复模板的适用条件求值出错', { key: e.key, error: e.message });
    }
    // 模板匹配用的根因与卡片写进日志：模板没有被尝试时，Kind 与影子环境的诊断能看到是根因还是卡片不满足条件
    logger.info('自愈 PR 的模板匹配', {
      run_id: run.run_id,
      incident_id: run.incident_id,
      root: ctx.root ? `${ctx.root.kind}:${ctx.root.namespace ?? ''}/${ctx.root.name}` : null,
      abnormal_cards: Object.entries(ctx.cards)
        .filter(([, c]) => c.verdict === 'abnormal')
        .map(([id]) => id),
      applicable: applicable.map((a) => a.key),
    });
    const wanted = applicable.filter((a) => this.s.categories.includes(a.category));
    if (!wanted.length) {
      return skipAll('no_template', applicable.length ? '适用的模板不在启用的类别中' : '没有适用的修复模板');
    }
    // 之前处理过这次研判：只重试绑定过时、还没到上限的模板，其余已经有结果的不重复处理（ADR 0108 §13）
    const prior = new Map(
      (
        await this.pool.query<{ key: string; code: string | null; retries: number }>(
          'SELECT key, code, retries FROM server.remediation_attempts WHERE run_id = $1',
          [run.run_id],
        )
      ).rows.map((x) => [x.key, x]),
    );
    const attempts: Attempt[] = [];
    let proposed = 0;
    // 每次研判的上限把之前已经提议的算在内
    let counted = (
      await this.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM server.remediation_attempts WHERE run_id = $1 AND outcome = 'proposed'",
        [run.run_id],
      )
    ).rows[0]!.n;
    const ds = await this.d.dataSource(Date.now()).catch(() => null);
    for (const a of wanted) {
      const before = prior.get(a.key);
      if (before && (before.code !== 'binding_stale' || before.retries >= BINDING_RETRY_LIMIT)) {
        continue;
      }
      if (counted >= this.s.maxPerRun) {
        attempts.push({
          key: a.key,
          outcome: 'skipped',
          code: 'per_run_limit',
          reason: `每次研判最多 ${this.s.maxPerRun} 个`,
          category: a.category,
        });
        continue;
      }
      const at = await this.one(run, inc, ctx, cards, a, ds, fp);
      attempts.push(at);
      if (at.outcome === 'proposed') {
        proposed++;
        counted++;
      }
    }
    await this.record(run, attempts);
    return proposed;
  }

  private async context(inc: Incident, run: RunRow, cards: EvidenceResult[]): Promise<RemediationContext> {
    const alerts = await alertsById(
      this.pool,
      inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id),
    );
    const rootKey = remediationRootKey(run, inc);
    let root: RemediationContext['root'] = null;
    if (rootKey) {
      // 根因组件展开到具体对象：Pod 取属主工作负载，Service 取它选中的唯一工作负载（ADR 0126）
      const o = await this.d.concrete(inc.cluster_id, rootKey, new Date());
      const e =
        o.key === inc.root.component && inc.root.entity
          ? inc.root.entity
          : { cluster_id: inc.cluster_id, kind: o.kind, namespace: o.namespace, name: o.name };
      const type =
        (await this.d.componentType(inc.cluster_id, o.key)) ??
        matchTypeByName(e.kind, e.namespace, e.name, this.d.componentTypes())?.id ??
        null;
      root = {
        cluster_id: e.cluster_id,
        kind: e.kind,
        namespace: e.namespace,
        name: e.name,
        node: e.kind === 'Node' ? e.name : null,
        component_type: type,
      };
    }
    return {
      incident: inc as unknown as Record<string, unknown>,
      root,
      cards: cardsOf(cards),
      alerts: alertsOf(alerts),
      // 触发这次修复的研判结论（模板按处置判断与结论等级适用，例如研判判为 ignore 的误报告警降级）
      research: {
        disposition: run.disposition ?? run.output?.disposition ?? 'undetermined',
        level: run.conclusion_level,
      },
    };
  }

  private async one(
    run: RunRow,
    inc: Incident,
    ctx: RemediationContext,
    cards: EvidenceResult[],
    a: { key: string; category: string; repository: string },
    ds: EvidenceDataSource | null,
    fp: string,
  ): Promise<Attempt> {
    const base: Attempt = { key: a.key, outcome: 'skipped', code: null, reason: null, category: a.category };
    const repo = this.s.repositories[a.repository];
    if (!repo) {
      return { ...base, code: 'repository_missing', reason: `remediation.repositories 没有仓库角色 ${a.repository}` };
    }
    const reader = new GitHubRepoReader(this.d.github, repo.repo, repo.base_branch);
    let plan: RemediationPlan;
    try {
      const p = await planRemediation(this.d.packs(), a.key, ctx, { repo: reader, layout: repo.files }, ds, Date.now());
      if (p.kind === 'skipped') {
        return { ...base, repository: repo.repo, code: p.code, reason: say(p.reason, this.s.language) };
      }
      plan = p;
    } catch (e) {
      if (e instanceof GitHubError) {
        throw new Deferred(`读取仓库 ${repo.repo} 失败：${e.message}`);
      }
      return {
        ...base,
        outcome: 'failed',
        repository: repo.repo,
        code: 'plan_error',
        reason: String((e as Error).message ?? e),
      };
    }
    const files = plan.files.map((f) => f.path);
    const problems = await validatePlan(plan, repo.files, (p) => reader.read(p));
    if (problems.length) {
      return {
        ...base,
        outcome: 'failed',
        repository: repo.repo,
        base: plan.base,
        files,
        code: 'validation_failed',
        reason: problems
          .map((p) => `${p.path ?? '补丁'}：${p.message}`)
          .join('；')
          .slice(0, 1000),
      };
    }
    // 计划与提议之间 base 前进：补丁可能已经不适用，下一轮按新的 base 重新计划
    const head = await new GitHubRepoReader(this.d.github, repo.repo, repo.base_branch).head().catch(() => null);
    if (head !== plan.base) {
      throw new Deferred(
        `${repo.repo} 的 ${repo.base_branch} 已从 ${plan.base.slice(0, 12)} 前进到 ${head?.slice(0, 12)}`,
      );
    }
    const digest = createHash('sha256').update(plan.patch).digest('hex');
    const branch = branchOf(inc.incident_id, plan.category, digest);
    const shownRoot = remediationRootKey(run, inc) ?? inc.root.component!;
    const names = await componentNames(this.pool, inc.cluster_id, [shownRoot]);
    const rootName = displayComponentName(shownRoot, names);
    const title =
      `${this.s.titlePrefix ? `${this.s.titlePrefix} ` : ''}${say(plan.title, this.s.language)}：${rootName}`.slice(
        0,
        120,
      );
    const out = run.output;
    const h = out?.hypotheses.find((x) => x.id === out.conclusion.hypothesis_id) ?? null;
    const supporting = new Set<string>(h?.supporting ?? []);
    const refs = this.d.issueRef ? await this.d.issueRef(inc.incident_id, repo.repo) : null;
    const body = prBody({
      lang: this.s.language,
      plan,
      incidentId: inc.incident_id,
      incidentLabel: inc.label,
      root: rootName,
      run: { runId: run.run_id, summary: run.summary, level: run.conclusion_level },
      cards: keyCards(cards, supporting),
      consoleUrl: this.s.consoleUrl,
      refs,
    });
    try {
      const r = await this.d.proposals.create(
        { source: 'rule', callerId: REMEDIATION_RULE },
        {
          incident_id: inc.incident_id,
          binding: {
            incident_version: inc.incident_version,
            root_component: inc.root.component!,
            evidence_fingerprint: fp,
          },
          action: 'gitops_pr',
          params: { repository: repo.repo, base: repo.base_branch, title, body, patch: plan.patch, branch },
          research_run_id: run.run_id,
          rule_id: REMEDIATION_RULE,
          hypothesis_id: h?.id ?? null,
          evidence_refs: [...supporting].slice(0, 12),
          expected_effect: say(plan.verify.say, this.s.language).slice(0, 300),
        },
      );
      const p = r.proposal;
      const rejected = p.state === 'rejected_by_policy';
      return {
        ...base,
        outcome: rejected ? 'rejected' : 'proposed',
        code: rejected ? 'policy' : null,
        reason: rejected
          ? p.policy_checks
              .filter((c) => !c.passed)
              .map((c) => `${c.name}：${c.detail}`)
              .join('；')
              .slice(0, 1000)
          : null,
        repository: repo.repo,
        branch,
        base: plan.base,
        proposalId: p.proposal_id,
        files,
      };
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        // 原因码按提议服务的错误区分：gateway 仅提议（且不接受 gitops_pr）与绑定过时是两回事
        const code =
          e.code === 'propose_only'
            ? 'gateway_propose_only'
            : e.code === 'target_unresolved'
              ? 'target_unresolved'
              : 'binding_stale';
        return { ...base, repository: repo.repo, code, reason: e.message, base: plan.base, files };
      }
      throw e;
    }
  }

  private async record(run: RunRow, attempts: Attempt[]): Promise<void> {
    const recorded: Attempt[] = [];
    await tx(this.pool, async (c) => {
      for (const a of attempts) {
        const ins = await c.query(
          `INSERT INTO server.remediation_attempts (run_id, key, incident_id, incident_version, outcome, code, reason, category,
             repository, branch, base, proposal_id, files)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (run_id, key) DO UPDATE SET outcome = excluded.outcome, code = excluded.code, reason = excluded.reason,
             category = excluded.category, repository = excluded.repository, branch = excluded.branch, base = excluded.base,
             proposal_id = excluded.proposal_id, files = excluded.files, incident_version = excluded.incident_version,
             retries = server.remediation_attempts.retries + 1, created_at = now()
           -- 只有绑定过时的尝试可以被重试覆盖（ADR 0108 §13）
           WHERE server.remediation_attempts.code = 'binding_stale'`,
          [
            run.run_id,
            a.key,
            run.incident_id,
            run.incident_version,
            a.outcome,
            a.code,
            a.reason,
            a.category ?? null,
            a.repository ?? null,
            a.branch ?? null,
            a.base ?? null,
            a.proposalId ?? null,
            JSON.stringify(a.files ?? []),
          ],
        );
        if (!ins.rowCount) {
          continue;
        }
        recorded.push(a);
        this.d.metrics.remediations.inc({ category: a.category ?? 'none', outcome: a.outcome });
        await appendAudit(c, 'remediation.attempt', 'server', {
          run_id: run.run_id,
          incident_id: run.incident_id,
          key: a.key,
          outcome: a.outcome,
          code: a.code,
          proposal_id: a.proposalId ?? null,
          branch: a.branch ?? null,
          base: a.base ?? null,
        });
      }
    });
    // 每次研判的处理结果写进日志：跳过与失败的原因只在状态库里时，Kind 与影子环境的诊断看不到自愈 PR 为什么没有出现
    for (const a of recorded) {
      logger.info('自愈 PR 处理结果', {
        run_id: run.run_id,
        incident_id: run.incident_id,
        incident_version: run.incident_version,
        key: a.key,
        outcome: a.outcome,
        code: a.code,
        reason: a.reason,
        proposal_id: a.proposalId ?? null,
        branch: a.branch ?? null,
      });
    }
  }
}
