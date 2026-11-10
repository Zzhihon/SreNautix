import { createHash } from 'node:crypto';
import type {
  SignalAlternative,
  SkillCall,
  SkillRunReason,
  SkillStepRecord,
  SkillSubject,
  SkillTriggerHit,
  SkillUsage,
} from '@srenautix/contract';
import type { PromqlEngine } from '@srenautix/integration-sdk';
import { skills as sdk, type EvidenceDataSource, type PackSet } from '@srenautix/packs-sdk';
import type pg from 'pg';
import { parseDuration } from '../kernel/files.js';
import type { GitHubApp } from '../github/app.js';
import { logger } from '../kernel/log.js';
import { appendAudit, jcs } from '../kernel/store/audit.js';
import { tx } from '../kernel/store/pool.js';
import type { SkillsConfig } from './config.js';
import { Semaphore, SkillBudgetExceeded, SkillContext, SkillDenied, type Backend } from './context.js';
import type { SkillKube } from './kube.js';
import type { SkillMetrics } from './metrics.js';
import type { FindingAction, SkillPublisher } from './publisher.js';
import type { SkillEntry, SkillRegistry } from './registry.js';
import { occurrenceKey, runStep, StepInputError, subjectPods, type StepEnv } from './steps.js';

// 一次技能运行（ADR 0181 §3、§7）：按声明顺序执行步骤；when 为假的步骤记为 skipped、输出为步骤类型的空值；
// optional 的步骤遇到数据源错误时记为 failed、输出为空值，运行继续；能力、作用范围与预算的拒绝总是终止运行。
// issue.publish 在运行的事务里按指纹决定开新 issue、评论还是只计数，并记下这次运行报告过的发生。

export interface RunRow {
  run_id: string;
  cluster_id: string;
  skill: string;
  subject: SkillSubject;
  triggers: SkillTriggerHit[];
  inputs: Record<string, unknown>;
  at: Date | null;
}

export interface RunnerDeps {
  pool: pg.Pool;
  config: SkillsConfig;
  registry: SkillRegistry;
  publisher: SkillPublisher | null;
  metrics: SkillMetrics;
  packs: () => PackSet;
  engine: PromqlEngine;
  dataSource: (at: number) => Promise<EvidenceDataSource>;
  kube: SkillKube | null;
  kubeLimits: { tailLines: number; maxBytes: number };
  github: GitHubApp | null;
  repos: StepEnv['repos'];
  lang: sdk.Lang;
  titlePrefix: string;
  consoleUrl: string;
  now?: () => number;
}

export interface RunResult {
  reason: SkillRunReason;
  steps: SkillStepRecord[];
  usage: SkillUsage;
  finding: { fingerprint: string; generation: number; action: FindingAction } | null;
  error: string | null;
  version: string | null;
  digest: string | null;
  /** 每次外部访问（含被拒绝的访问） */
  calls: SkillCall[];
}

/** 运行的预算：清单与 skills.limits 取较小者 */
export function runBudget(
  m: sdk.LoadedSkill['manifest'],
  limits: SkillsConfig['limits'],
): SkillUsage & { duration_ms: number } {
  const r = m.budgets.run;
  return {
    duration_ms: Math.min(
      parseDuration('budgets.run.duration', r.duration),
      parseDuration('skills.limits.duration', limits.duration),
    ),
    metrics_queries: Math.min(r.metrics_queries, limits.metrics_queries),
    logs_queries: Math.min(r.logs_queries, limits.logs_queries),
    log_lines: Math.min(r.log_lines, limits.log_lines),
    kube_reads: Math.min(r.kube_reads, limits.kube_reads),
    github_requests: Math.min(r.github_requests, limits.github_requests),
    code_files: Math.min(r.code_files, limits.code_files),
    code_bytes: Math.min(r.code_bytes, limits.code_bytes),
  };
}

/** 指纹：sha256(技能名, 集群, 清单声明的值)，值按 JCS 规范化 */
export function fingerprint(skill: string, cluster: string, values: unknown[]): string {
  return createHash('sha256')
    .update(jcs([skill, cluster, ...values]))
    .digest('hex')
    .slice(0, 32);
}

/** 参数：清单的默认值，部署方在 skills.params 覆盖（类型必须相同） */
export function effectiveParams(
  m: sdk.LoadedSkill['manifest'],
  over: Record<string, string | number | boolean> | undefined,
) {
  const out = { ...(m.params ?? {}) } as Record<string, string | number | boolean>;
  for (const [k, v] of Object.entries(over ?? {})) {
    if (!(k in out)) {
      throw new StepInputError(`skills.params 覆盖了没有声明的参数 ${k}`);
    }
    if (typeof v !== typeof out[k]) {
      throw new StepInputError(`skills.params 的参数 ${k} 类型应为 ${typeof out[k]}`);
    }
    out[k] = v;
  }
  return out;
}

export class SkillRunner {
  private readonly semaphores: Record<Backend, Semaphore>;
  private readonly now: () => number;

  constructor(private readonly d: RunnerDeps) {
    const c = d.config.concurrency;
    this.semaphores = {
      metrics: new Semaphore(c.metrics),
      logs: new Semaphore(c.logs),
      kube: new Semaphore(c.kube),
      github: new Semaphore(c.github),
    };
    this.now = d.now ?? Date.now;
  }

  async execute(run: RunRow, entry: SkillEntry, signal: AbortSignal): Promise<RunResult> {
    const skill = entry.skill!;
    const m = skill.manifest;
    const budget = runBudget(m, this.d.config.limits);
    const binding = sdk.bindingOf(entry.bindings, run.subject);
    const empty: SkillUsage = {
      metrics_queries: 0,
      logs_queries: 0,
      log_lines: 0,
      kube_reads: 0,
      github_requests: 0,
      code_files: 0,
      code_bytes: 0,
    };
    const base = { version: m.version, digest: skill.digest, usage: empty, finding: null, steps: [], calls: [] };
    if (m.binding.required && !binding) {
      return {
        ...base,
        reason: 'binding_missing',
        error: `${run.subject.kind} ${run.subject.namespace}/${run.subject.name} 没有绑定`,
      };
    }
    const at = run.at ? run.at.getTime() : this.now();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(budget.duration_ms)]);
    const re = subjectPods(run.subject);
    const ctx = new SkillContext({
      skill: skill.name,
      capabilities: this.d.registry.effective(skill.name).capabilities,
      namespace: run.subject.namespace,
      pods: () => ({ has: (p: string) => re.test(p) }) as ReadonlySet<string>,
      budget,
      semaphores: this.semaphores,
      metrics: this.d.metrics,
      signal: timeout,
      now: this.now,
    });
    const reported = await this.reported(run);
    let dsP: Promise<EvidenceDataSource> | undefined;
    const env: StepEnv = {
      ctx,
      lang: this.d.lang,
      clusterId: run.cluster_id,
      subject: run.subject,
      at,
      triggers: run.triggers,
      ds: () => (dsP ??= this.d.dataSource(at)),
      engine: this.d.engine,
      set: this.d.packs(),
      kube: this.d.kube,
      kubeLimits: this.d.kubeLimits,
      github: this.d.github,
      repos: this.d.repos,
      reported,
      related: () => this.related(run),
      resolved: new Map<string, SignalAlternative | null>(),
    };
    const scope: sdk.RefScope = {
      params: effectiveParams(m, this.d.config.params[skill.name]),
      inputs: run.inputs,
      binding: binding ? { id: binding.id, data: binding.data } : null,
      steps: {},
    };
    const steps: SkillStepRecord[] = [];
    let finding: RunResult['finding'] = null;
    let published = false;
    const finish = (reason: SkillRunReason, error: string | null): RunResult => ({
      reason,
      steps,
      usage: { ...ctx.usage },
      finding,
      error,
      version: m.version,
      digest: skill.digest,
      calls: ctx.calls,
    });
    try {
      for (const s of m.steps) {
        const started = this.now();
        ctx.step = s.id;
        const rec = (state: SkillStepRecord['state'], error: string | null) =>
          steps.push({
            id: s.id,
            uses: s.uses,
            state,
            started_at: new Date(started).toISOString(),
            duration_ms: this.now() - started,
            error,
          });
        if (s.when !== undefined && !sdk.truthy(sdk.resolveRefs(s.when, scope))) {
          scope.steps[s.id] = sdk.EMPTY_OUTPUTS[s.uses];
          rec('skipped', null);
          continue;
        }
        const w = sdk.resolveRefs(s.with ?? {}, scope) as Record<string, unknown>;
        try {
          if (s.uses === 'issue.publish@v1') {
            if (!this.d.publisher) {
              ctx.deny('issue.write', 'publish', {}, 'server 没有 GitHub App，不能开 issue');
            }
            finding = await this.publish(run, skill, scope, ctx, env, binding);
            published = true;
            scope.steps[s.id] = finding;
          } else {
            scope.steps[s.id] = await runStep(s.uses, w, env);
          }
          rec('succeeded', null);
        } catch (e) {
          if (e instanceof SkillDenied || e instanceof SkillBudgetExceeded || timeout.aborted) {
            rec('failed', e instanceof Error ? e.message : String(e));
            throw e;
          }
          if (s.optional && !(e instanceof StepInputError)) {
            rec('failed', e instanceof Error ? e.message.slice(0, 1000) : String(e));
            scope.steps[s.id] = sdk.EMPTY_OUTPUTS[s.uses];
            logger.warn('技能的可选步骤失败，运行继续', {
              skill: skill.name,
              run_id: run.run_id,
              step: s.id,
              error: e,
            });
            continue;
          }
          rec('failed', e instanceof Error ? e.message.slice(0, 1000) : String(e));
          throw e;
        }
      }
      ctx.step = null;
      if (!published) {
        return finish('no_occurrence', null);
      }
      return finish(
        finding!.action === 'open' ? 'published' : finding!.action === 'comment' ? 'commented' : 'counted',
        null,
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      if (e instanceof SkillDenied) {
        return finish('capability_denied', msg);
      }
      if (e instanceof SkillBudgetExceeded || (timeout.aborted && !signal.aborted)) {
        return finish('budget_exhausted', timeout.aborted ? `超过运行时长 ${budget.duration_ms / 1000} 秒` : msg);
      }
      if (signal.aborted) {
        return finish('interrupted', msg);
      }
      if (e instanceof StepInputError || e instanceof TypeError) {
        return finish('step_failed', msg);
      }
      return finish('datasource_error', msg);
    }
  }

  private subjectKey(run: RunRow): string {
    return `${run.subject.kind}:${run.subject.namespace}/${run.subject.name}`;
  }

  private async reported(run: RunRow): Promise<Set<string>> {
    const r = await this.d.pool.query<{ occurrence: string }>(
      'SELECT occurrence FROM server.skill_occurrences WHERE cluster_id = $1 AND skill = $2 AND subject_key = $3',
      [run.cluster_id, run.skill, this.subjectKey(run)],
    );
    return new Set(r.rows.map((x) => x.occurrence));
  }

  private async related(run: RunRow): Promise<number[]> {
    const r = await this.d.pool.query<{ number: number }>(
      `SELECT number FROM server.skill_findings
        WHERE cluster_id = $1 AND skill = $2 AND subject = $3::jsonb AND number IS NOT NULL ORDER BY number`,
      [run.cluster_id, run.skill, JSON.stringify(run.subject)],
    );
    return r.rows.map((x) => x.number);
  }

  /** issue.publish@v1：指纹 → 决定 → 渲染 → 写入发现与评论、记下报告过的发生，都在一个事务里 */
  private async publish(
    run: RunRow,
    skill: sdk.LoadedSkill,
    scope: sdk.RefScope,
    ctx: SkillContext,
    env: StepEnv,
    binding: sdk.ResolvedBinding | null,
  ): Promise<{ fingerprint: string; generation: number; action: FindingAction }> {
    const m = skill.manifest;
    const out = m.outputs.issue;
    const role = ctx.params('issue.write').repo_role ?? 'business';
    const repo = role === 'business' ? env.repos.business?.repo : env.repos.ops;
    if (!repo) {
      ctx.deny('issue.write', 'publish', { repo_role: role }, `没有 ${role} 角色的仓库`);
    }
    const fp = fingerprint(skill.name, run.cluster_id, sdk.resolveRefs(m.outputs.fingerprint, scope) as unknown[]);
    const labels = [
      ...new Set([
        ...((sdk.resolveRefs(out.labels, scope) as string[] | undefined) ?? []).filter((x) => typeof x === 'string'),
        'srenautix',
        `srenautix:${skill.name}`,
      ]),
    ];
    const publisher = this.d.publisher!;
    return tx(this.d.pool, async (c) => {
      const decision = await publisher.decide(c, run.cluster_id, skill.name, fp, async (f) => {
        if (f.state !== 'open' || f.number === null) {
          return f;
        }
        return ctx.call('issue.write', 'github', 'get_issue', { repo: f.repo, number: f.number }, () =>
          publisher.refresh(c, f),
        );
      });
      const view = {
        skill: { name: skill.name, version: m.version, digest: skill.digest },
        run: { id: run.run_id, url: `${this.d.consoleUrl.replace(/\/+$/, '')}/skills/runs/${run.run_id}` },
        subject: run.subject,
        params: scope.params,
        binding: binding ? { id: binding.id } : null,
        steps: scope.steps,
        finding: {
          fingerprint: fp,
          generation: decision.generation,
          previous_number: decision.previous_number,
          occurrences: decision.occurrences,
        },
      };
      const lang = this.d.lang;
      const title = sdk
        .renderTemplate((lang === 'zh-CN' ? out.title['zh-CN'] : out.title.en) ?? out.title.en ?? '', view)
        .replace(/\s+/g, ' ')
        .trim();
      const body = sdk.renderTemplate(skill.templates[out.templates[lang]]!, view);
      const comment = sdk.renderTemplate(skill.templates[out.comment_templates[lang]]!, view);
      await publisher.record(c, decision, {
        cluster: run.cluster_id,
        skill: skill.name,
        fingerprint: fp,
        subject: run.subject,
        repo: decision.target?.repo ?? repo,
        runId: run.run_id,
        title: `${this.d.titlePrefix ? `${this.d.titlePrefix} ` : ''}${title}`,
        body,
        comment,
        labels,
      });
      // 这次运行的发生都记为已报告
      for (const s of m.steps.filter((x) => x.uses === 'trigger.occurrences@v1')) {
        const o = scope.steps[s.id] as { occurrences?: sdk.Occurrence[] } | null;
        for (const occ of o?.occurrences ?? []) {
          await c.query(
            `INSERT INTO server.skill_occurrences (cluster_id, skill, subject_key, occurrence, run_id) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [run.cluster_id, skill.name, this.subjectKey(run), occurrenceKey(occ), run.run_id],
          );
        }
      }
      await appendAudit(c, 'skill.finding_recorded', 'server', {
        skill: skill.name,
        run_id: run.run_id,
        fingerprint: fp,
        generation: decision.generation,
        action: decision.action,
      });
      return { fingerprint: fp, generation: decision.generation, action: decision.action };
    });
  }
}
