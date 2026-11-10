import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type SkillCall,
  type SkillCapability,
  type SkillFinding,
  type SkillHost,
  type SkillRun,
  type SkillSubject,
  type SkillSummary,
  type SkillTriggerHit,
} from '@srenautix/contract';
import { toIso, type PromqlEngine } from '@srenautix/integration-sdk';
import {
  renderMetrics,
  resolveSignal,
  skills as sdk,
  type EvidenceDataSource,
  type PackSet,
} from '@srenautix/packs-sdk';
import type pg from 'pg';
import type { Registry } from 'prom-client';
import type { Observed } from '../console-bff/conditions.js';
import { parseDuration } from '../kernel/files.js';
import type { GitHubApp } from '../github/app.js';
import { logger } from '../kernel/log.js';
import { appendAudit } from '../kernel/store/audit.js';
import { tx } from '../kernel/store/pool.js';
import type { SkillsConfig } from './config.js';
import type { SkillKube } from './kube.js';
import { SkillMetrics } from './metrics.js';
import { SkillPublisher } from './publisher.js';
import { SkillRegistry, type RegistryEvent } from './registry.js';
import { SkillRunner, type RunRow } from './runner.js';
import type { StepEnv } from './steps.js';

// 技能的组装与后台循环（ADR 0181 §4、§6、§7）：重新加载、触发（指标、告警、Kubernetes 对象状态、手动）、settle 与
// coalesce、每小时运行上限、执行、投递。后台循环只在主实例上调度（roles/server.ts）；告警风暴期间不开始新的运行。

export interface SkillServiceDeps {
  pool: pg.Pool;
  config: SkillsConfig;
  clusterId: string;
  hostVersion: string;
  packs: () => PackSet;
  engine: PromqlEngine;
  dataSource: (at: number) => Promise<EvidenceDataSource>;
  kube: SkillKube | null;
  kubeLimits: { tailLines: number; maxBytes: number };
  github: GitHubApp | null;
  repos: StepEnv['repos'];
  logsAvailable: boolean;
  repoMaxPerHour: number;
  lang: sdk.Lang;
  titlePrefix: string;
  consoleUrl: string;
  registry: Registry;
  /** Pod 的顶层属主（拓扑的 owned_by）；不知道时为 null */
  ownerOf: (clusterId: string, podKey: string) => Promise<string | null>;
  storm: () => boolean;
  now?: () => number;
}

const KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

export function subjectKey(s: SkillSubject): string {
  return `${s.kind}:${s.namespace}/${s.name}`;
}

/** 拓扑组件键 → 运行对象；不是工作负载时为 null */
export function subjectOf(key: string | null): SkillSubject | null {
  const m = key ? /^(Deployment|StatefulSet|DaemonSet):([a-z0-9-]+)\/(.+)$/.exec(key) : null;
  return m ? { kind: m[1] as SkillSubject['kind'], namespace: m[2]!, name: m[3]! } : null;
}

export class SkillRejected extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'SkillRejected';
  }
}

interface RunDbRow {
  run_id: string;
  cluster_id: string;
  skill: string;
  subject: SkillSubject;
  triggers: SkillTriggerHit[];
  inputs: Record<string, unknown>;
  state: SkillRun['state'];
  reason: SkillRun['reason'];
  requested_by: string | null;
  at: Date | null;
  not_before: Date;
  version: string | null;
  digest: string | null;
  steps: SkillRun['steps'];
  usage: SkillRun['usage'] | null;
  finding: SkillRun['finding'];
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const RUN_COLUMNS = `run_id, cluster_id, skill, subject, triggers, inputs, state, reason, requested_by, at, not_before, version,
  digest, steps, usage, finding, error, created_at, started_at, finished_at`;

const ZERO_USAGE = {
  metrics_queries: 0,
  logs_queries: 0,
  log_lines: 0,
  kube_reads: 0,
  github_requests: 0,
  code_files: 0,
  code_bytes: 0,
};

export function runOf(r: RunDbRow): SkillRun {
  return {
    run_id: r.run_id,
    cluster_id: r.cluster_id,
    skill: r.skill,
    version: r.version,
    digest: r.digest,
    subject: r.subject,
    triggers: r.triggers,
    inputs: r.inputs,
    state: r.state,
    reason: r.reason,
    requested_by: r.requested_by,
    at: r.at?.toISOString() ?? null,
    not_before: r.not_before.toISOString(),
    created_at: r.created_at.toISOString(),
    started_at: r.started_at?.toISOString() ?? null,
    finished_at: r.finished_at?.toISOString() ?? null,
    steps: r.steps,
    usage: r.usage ?? ZERO_USAGE,
    finding: r.finding,
    error: r.error,
  };
}

export class SkillService {
  readonly registry: SkillRegistry;
  readonly metrics: SkillMetrics;
  readonly publisher: SkillPublisher | null;
  private readonly runner: SkillRunner;
  private readonly now: () => number;
  private overrides = new Map<string, { paused: boolean; reason: string | null }>();
  private readonly lastEval = new Map<string, number>();
  private readonly seenTerminations = new Map<string, number>();
  private readonly seenEvictions = new Set<string>();
  /** 宿主具备的能力：指标总是有；日志、Kubernetes 只读、GitHub 仓库角色按配置 */
  private readonly hostCapabilities = new Set<SkillCapability>(['metrics.query_range']);

  constructor(private readonly d: SkillServiceDeps) {
    this.now = d.now ?? Date.now;
    this.metrics = new SkillMetrics(d.registry);
    const host = this.hostCapabilities;
    if (d.logsAvailable) {
      host.add('logs.query');
    }
    if (d.kube) {
      host.add('kube.read');
    }
    if (d.github && (d.repos.business || d.repos.ops)) {
      host.add('issue.write');
      if (d.repos.business) {
        host.add('code.read');
      }
    }
    this.registry = new SkillRegistry({
      config: d.config,
      hostVersion: d.hostVersion,
      packs: d.packs,
      engine: d.engine,
      hostCapabilities: host,
      onEvent: (e) => this.onRegistryEvent(e),
    });
    this.publisher = d.github
      ? new SkillPublisher(
          d.pool,
          d.github,
          this.metrics,
          d.repoMaxPerHour,
          (skill) => this.registry.get(skill)?.skill?.manifest.budgets.hourly ?? null,
          this.now,
        )
      : null;
    this.runner = new SkillRunner({
      pool: d.pool,
      config: d.config,
      registry: this.registry,
      publisher: this.publisher,
      metrics: this.metrics,
      packs: d.packs,
      engine: d.engine,
      dataSource: d.dataSource,
      kube: d.kube,
      kubeLimits: d.kubeLimits,
      github: d.github,
      repos: d.repos,
      lang: d.lang,
      titlePrefix: d.titlePrefix,
      consoleUrl: d.consoleUrl,
      now: this.now,
    });
  }

  get reloadMs(): number {
    return parseDuration('skills.reload_interval', this.d.config.reload_interval);
  }

  get intervalMs(): number {
    return parseDuration('skills.interval', this.d.config.interval);
  }

  private async onRegistryEvent(e: RegistryEvent): Promise<void> {
    await tx(this.d.pool, (c) => appendAudit(c, e.kind, 'server', e.data));
    if (e.kind === 'skill.load_rejected') {
      this.metrics.loadFailures.inc({ skill: e.data.skill });
    }
  }

  /** 重新加载技能并刷新暂停状态与已加载版本的指标 */
  async reload(): Promise<void> {
    await this.registry.reload();
    await this.refreshOverrides();
    this.metrics.loaded.reset();
    for (const e of this.registry.list()) {
      if (e.skill) {
        this.metrics.loaded.set({ skill: e.name, version: e.skill.manifest.version, source: e.skill.source }, 1);
      }
    }
  }

  private async refreshOverrides(): Promise<void> {
    const r = await this.d.pool.query<{ skill: string; paused: boolean; reason: string | null }>(
      'SELECT skill, paused, reason FROM server.skill_overrides',
    );
    this.overrides = new Map(r.rows.map((x) => [x.skill, { paused: x.paused, reason: x.reason }]));
  }

  /** 主实例开始工作时：上一个主实例留下的 running 运行记为中断 */
  async recover(): Promise<void> {
    const r = await this.d.pool.query<{ run_id: string; skill: string }>(
      `UPDATE server.skill_runs SET state = 'failed', reason = 'interrupted', finished_at = now(),
         error = 'server 重启或失去主实例身份' WHERE state = 'running' RETURNING run_id, skill`,
    );
    for (const x of r.rows) {
      this.metrics.runs.inc({ skill: x.skill, trigger: 'unknown', outcome: 'interrupted' });
    }
  }

  summaries(): SkillSummary[] {
    return this.registry.list().map((e) => this.registry.summary(e.name, this.overrides.get(e.name))!);
  }

  summary(name: string): SkillSummary | null {
    return this.registry.summary(name, this.overrides.get(name));
  }

  active(name: string): boolean {
    return this.registry.state(name, this.overrides.get(name)?.paused === true) === 'active';
  }

  host(): SkillHost {
    return {
      api_version: 'srenautix.io/skill/v1',
      contract: CONTRACT_VERSION,
      capabilities: [...this.hostCapabilities].sort(),
      step_kinds: [...sdk.STEP_KINDS.values()].map((k) => ({
        uses: k.uses,
        capabilities: [...k.capabilities],
        params: [...k.params],
      })),
    };
  }

  async setPaused(name: string, paused: boolean, reason: string | null, by: string): Promise<SkillSummary> {
    if (!this.registry.get(name)) {
      throw new SkillRejected(404, `没有技能 ${name}`);
    }
    await tx(this.d.pool, async (c) => {
      await c.query(
        `INSERT INTO server.skill_overrides (skill, paused, reason, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (skill) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_by = excluded.updated_by,
           updated_at = now()`,
        [name, paused, reason, by],
      );
      await appendAudit(c, paused ? 'skill.paused' : 'skill.resumed', by, { skill: name, reason });
    });
    await this.refreshOverrides();
    return this.summary(name)!;
  }

  private inScope(skill: sdk.LoadedSkill, s: SkillSubject): string | null {
    const m = skill.manifest;
    if (!m.scope.kinds.includes(s.kind)) {
      return `技能 ${m.name} 不处理 ${s.kind}`;
    }
    const sc = this.d.config.scope[m.name];
    if (sc && !sc.namespaces.includes('*') && !sc.namespaces.includes(s.namespace)) {
      return `命名空间 ${s.namespace} 不在 skills.scope.${m.name} 中`;
    }
    if (sc?.kinds && !sc.kinds.includes(s.kind)) {
      return `${s.kind} 不在 skills.scope.${m.name}.kinds 中`;
    }
    return null;
  }

  /**
   * 登记一次触发或手动请求：同一对象已有等待中的运行时并入它；否则新建，开始时刻为 settle 之后（手动运行不等 settle），
   * 并且不早于上一次运行开始之后 coalesce
   */
  async enqueue(
    name: string,
    subject: SkillSubject,
    hit: SkillTriggerHit,
    o: {
      manual?: boolean;
      requestedBy?: string | null;
      at?: string | null;
      inputs?: Record<string, unknown>;
      clusterId?: string;
    } = {},
  ): Promise<SkillRun> {
    const e = this.registry.get(name);
    if (!e?.skill) {
      throw new SkillRejected(404, `没有可用的技能 ${name}`);
    }
    if (!this.active(name)) {
      throw new SkillRejected(
        409,
        `技能 ${name} 的状态为 ${this.registry.state(name, this.overrides.get(name)?.paused === true)}`,
      );
    }
    const why = this.inScope(e.skill, subject);
    if (why) {
      throw new SkillRejected(403, why);
    }
    const m = e.skill.manifest;
    if (m.binding.required && !sdk.bindingOf(e.bindings, subject)) {
      throw new SkillRejected(400, `${subjectKey(subject)} 没有领域包的 ${name} 绑定`);
    }
    const settle = o.manual ? 0 : parseDuration('debounce.settle', m.debounce.settle);
    const coalesce = parseDuration('debounce.coalesce', m.debounce.coalesce);
    const cluster = o.clusterId ?? this.d.clusterId;
    const key = subjectKey(subject);
    // 开始时刻按状态库的时钟：settle 之后，并且不早于同一对象上一次运行开始之后 coalesce
    const r = await this.d.pool.query<RunDbRow>(
      `INSERT INTO server.skill_runs (run_id, cluster_id, skill, subject, subject_key, triggers, inputs, state, requested_by, at, not_before)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, greatest(
         now() + make_interval(secs => $10),
         (SELECT max(started_at) FROM server.skill_runs WHERE cluster_id = $2 AND skill = $3 AND subject_key = $5)
           + make_interval(secs => $12)))
       ON CONFLICT (cluster_id, skill, subject_key) WHERE state = 'pending' DO UPDATE
         SET triggers = CASE WHEN jsonb_array_length(server.skill_runs.triggers) >= 50 THEN server.skill_runs.triggers
                             ELSE server.skill_runs.triggers || excluded.triggers END,
             inputs = CASE WHEN $11 THEN excluded.inputs ELSE server.skill_runs.inputs END,
             at = CASE WHEN $11 THEN excluded.at ELSE server.skill_runs.at END,
             requested_by = coalesce(excluded.requested_by, server.skill_runs.requested_by),
             not_before = CASE WHEN $11 THEN least(server.skill_runs.not_before, excluded.not_before) ELSE server.skill_runs.not_before END
       RETURNING ${RUN_COLUMNS}`,
      [
        randomUUID(),
        cluster,
        name,
        JSON.stringify(subject),
        key,
        JSON.stringify([hit]),
        JSON.stringify(o.inputs ?? {}),
        o.requestedBy ?? null,
        o.at ? new Date(o.at) : null,
        settle / 1000,
        o.manual === true,
        coalesce / 1000,
      ],
    );
    return runOf(r.rows[0]!);
  }

  /** 后台一轮：执行到期的运行（一次一个），然后投递 issue 与评论 */
  async tickOnce(signal: AbortSignal): Promise<void> {
    await this.refreshOverrides();
    if (!this.d.storm()) {
      for (let i = 0; i < 5 && !signal.aborted; i++) {
        if (!(await this.runOne(signal))) {
          break;
        }
      }
    }
    await this.publisher?.deliverOnce();
  }

  /** 取一个到期的运行执行；没有时返回 false */
  async runOne(signal: AbortSignal): Promise<boolean> {
    const claimed = await tx(this.d.pool, async (c) => {
      const r = await c.query<RunDbRow>(
        `SELECT ${RUN_COLUMNS} FROM server.skill_runs WHERE state = 'pending' AND not_before <= now()
          ORDER BY not_before LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = r.rows[0];
      if (!row) {
        return null;
      }
      const e = this.registry.get(row.skill);
      if (!e?.skill || !this.active(row.skill)) {
        await c.query(
          `UPDATE server.skill_runs SET state = 'failed', reason = 'unavailable', finished_at = now(), error = $2 WHERE run_id = $1`,
          [
            row.run_id,
            `技能的状态为 ${this.registry.state(row.skill, this.overrides.get(row.skill)?.paused === true)}`,
          ],
        );
        this.metrics.runs.inc({
          skill: row.skill,
          trigger: row.triggers[0]?.kind ?? 'unknown',
          outcome: 'unavailable',
        });
        return { row, entry: null };
      }
      const cap = e.skill.manifest.budgets.hourly.runs;
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM server.skill_runs WHERE skill = $1 AND started_at > now() - interval '1 hour'`,
        [row.skill],
      );
      if (n.rows[0]!.n >= cap) {
        await c.query(`UPDATE server.skill_runs SET not_before = now() + interval '10 minutes' WHERE run_id = $1`, [
          row.run_id,
        ]);
        logger.info('技能运行达到每小时上限，推迟', { skill: row.skill, run_id: row.run_id, cap });
        return { row, entry: null };
      }
      await c.query(
        `UPDATE server.skill_runs SET state = 'running', started_at = now(), version = $2, digest = $3 WHERE run_id = $1`,
        [row.run_id, e.skill.manifest.version, e.skill.digest],
      );
      await appendAudit(c, 'skill.run_started', 'server', {
        skill: row.skill,
        run_id: row.run_id,
        version: e.skill.manifest.version,
        digest: e.skill.digest,
        subject: row.subject,
        triggers: row.triggers.map((t) => t.trigger),
      });
      return { row, entry: e };
    });
    if (!claimed) {
      return false;
    }
    if (!claimed.entry) {
      return true;
    }
    const { row, entry } = claimed;
    const started = this.now();
    const run: RunRow = {
      run_id: row.run_id,
      cluster_id: row.cluster_id,
      skill: row.skill,
      subject: row.subject,
      triggers: row.triggers,
      inputs: row.inputs,
      at: row.at,
    };
    const result = await this.runner.execute(run, entry, signal);
    const calls = result.calls;
    await tx(this.d.pool, async (c) => {
      await c.query(
        `UPDATE server.skill_runs SET state = $2, reason = $3, finished_at = now(), steps = $4, usage = $5, finding = $6, error = $7
          WHERE run_id = $1`,
        [
          row.run_id,
          ['published', 'commented', 'counted', 'no_occurrence'].includes(result.reason) ? 'succeeded' : 'failed',
          result.reason,
          JSON.stringify(result.steps),
          JSON.stringify(result.usage),
          result.finding ? JSON.stringify(result.finding) : null,
          result.error,
        ],
      );
      for (const call of calls) {
        await c.query('INSERT INTO server.skill_run_calls (run_id, seq, body) VALUES ($1, $2, $3)', [
          row.run_id,
          call.seq,
          JSON.stringify(call),
        ]);
      }
      await appendAudit(c, 'skill.run_finished', 'server', {
        skill: row.skill,
        run_id: row.run_id,
        version: result.version,
        digest: result.digest,
        reason: result.reason,
        usage: result.usage,
        finding: result.finding,
        denied: calls.filter((x) => x.outcome === 'denied').length,
        error: result.error,
      });
      for (const d of calls.filter((x) => x.outcome === 'denied')) {
        await appendAudit(c, 'skill.call_denied', 'server', { skill: row.skill, run_id: row.run_id, call: d });
      }
    });
    this.metrics.runs.inc({ skill: row.skill, trigger: row.triggers[0]?.kind ?? 'unknown', outcome: result.reason });
    this.metrics.runSeconds.observe({ skill: row.skill }, (this.now() - started) / 1000);
    logger.info('技能运行结束', { skill: row.skill, run_id: row.run_id, reason: result.reason, error: result.error });
    return true;
  }

  // ---- 触发 ----

  private activeSkills(): sdk.LoadedSkill[] {
    return this.registry
      .list()
      .filter((e) => e.skill && this.active(e.name))
      .map((e) => e.skill!);
  }

  /** 指标触发：每个触发按自己的 interval 执行；绑定了工作负载的技能只看绑定的工作负载，否则看作用范围内的命名空间 */
  async metricTriggersOnce(): Promise<void> {
    if (this.d.storm()) {
      return;
    }
    const now = this.now();
    const set = this.d.packs();
    for (const skill of this.activeSkills()) {
      const m = skill.manifest;
      const occurrenceSignals = new Set(
        m.steps
          .filter((s) => s.uses === 'trigger.occurrences@v1')
          .map((s) => (s.with as { signal?: string } | undefined)?.signal),
      );
      const params = { ...(m.params ?? {}), ...(this.d.config.params[m.name] ?? {}) };
      for (const t of m.triggers) {
        if (t.kind !== 'metric') {
          continue;
        }
        const k = `${m.name}/${t.id}`;
        const every = parseDuration('interval', t.interval ?? '60s');
        if (now - (this.lastEval.get(k) ?? 0) < every) {
          continue;
        }
        this.lastEval.set(k, now);
        try {
          await this.evalMetricTrigger(skill, t, params, occurrenceSignals.has(t.signal), set, now);
        } catch (e) {
          logger.warn('技能的指标触发执行失败，下一轮重试', { skill: m.name, trigger: t.id, error: e });
        }
      }
    }
  }

  private async evalMetricTrigger(
    skill: sdk.LoadedSkill,
    t: Extract<sdk.LoadedSkill['manifest']['triggers'][number], { kind: 'metric' }>,
    params: Record<string, unknown>,
    isOccurrenceSignal: boolean,
    set: PackSet,
    now: number,
  ): Promise<void> {
    const sig = set.signals.get(t.signal)!;
    const ds = await this.d.dataSource(now);
    const clock = { from: toIso(now - 2 * 3600_000), to: toIso(now) };
    const res = await resolveSignal(t.signal, sig.signal, ds, this.d.engine, toIso(now), clock);
    if (!res.alternative || !ds.labelProfile) {
      return;
    }
    const value = (v: unknown) =>
      sdk.asRef(v)?.kind === 'param' ? params[(sdk.asRef(v) as { path: string }).path] : v;
    const threshold = t.condition ? Number(value(t.condition.value)) : 0;
    const op = t.condition?.op ?? 'gt';
    const ok = (v: number) =>
      op === 'gt' ? v > threshold : op === 'ge' ? v >= threshold : op === 'lt' ? v < threshold : v <= threshold;
    const forMs = t.for ? parseDuration('for', String(value(t.for))) : 0;
    const entry = this.registry.get(skill.name)!;
    const entities: Array<{ kind: string; namespace: string; name: string; subject: SkillSubject | null }> = [];
    if (skill.manifest.binding.required) {
      for (const b of entry.bindings) {
        for (const w of b.workloads) {
          entities.push({ ...w, subject: w });
        }
      }
    } else {
      const sc = this.d.config.scope[skill.name];
      for (const n of sc?.namespaces ?? ['*']) {
        entities.push(
          n === '*'
            ? { kind: 'cluster', namespace: '', name: this.d.clusterId, subject: null }
            : { kind: 'Namespace', namespace: n, name: n, subject: null },
        );
      }
    }
    for (const ent of entities) {
      const expr = renderMetrics(this.d.engine, res.alternative, {
        entity: { cluster_id: this.d.clusterId, kind: ent.kind, namespace: ent.namespace || null, name: ent.name },
        params: {},
        windowSeconds: Math.round(parseDuration('window', t.window) / 1000),
        profile: ds.labelProfile,
      });
      const from = now - Math.max(forMs, 60_000);
      const r = await ds.queryRange({
        expr,
        dialect: res.alternative.dialect === 'metricsql' ? 'metricsql' : 'promql',
        window: { from: toIso(from), to: toIso(now) },
        step_seconds: 60,
        clock_window: { from: toIso(now - 24 * 3600_000), to: toIso(now) },
        timeout_ms: 30_000,
        max_series: 200,
      });
      for (const s of r.series) {
        const vals = s.values.filter((v): v is number => v !== null && Number.isFinite(v));
        const last = vals[vals.length - 1];
        if (
          last === undefined ||
          !ok(last) ||
          (forMs > 0 && (vals.length < Math.max(1, Math.floor(forMs / 60_000) * 0.8) || !vals.every(ok)))
        ) {
          continue;
        }
        const pod = s.labels[ds.labelProfile.pod] ?? s.labels.pod;
        const nsName = s.labels[ds.labelProfile.namespace] ?? s.labels.namespace ?? ent.namespace;
        if (!pod || !nsName) {
          continue;
        }
        const subject = ent.subject ?? subjectOf(await this.d.ownerOf(this.d.clusterId, `Pod:${nsName}/${pod}`));
        if (!subject || !KINDS.has(subject.kind)) {
          continue;
        }
        const container = s.labels[ds.labelProfile.container] ?? s.labels.container ?? null;
        const hit: SkillTriggerHit = {
          trigger: t.id,
          kind: 'metric',
          at: toIso(now),
          detail: `${pod}${container ? `/${container}` : ''} ${t.signal} = ${last}`.slice(0, 500),
          pod,
          container,
          cause: isOccurrenceSignal ? null : 'near_limit',
        };
        await this.tryEnqueue(skill.name, subject, hit);
      }
    }
  }

  private async tryEnqueue(name: string, subject: SkillSubject, hit: SkillTriggerHit): Promise<void> {
    try {
      const r = await this.enqueue(name, subject, hit);
      logger.info('技能触发', { skill: name, trigger: hit.trigger, subject: subjectKey(subject), run_id: r.run_id });
    } catch (e) {
      if (!(e instanceof SkillRejected)) {
        throw e;
      }
      logger.debug('技能触发没有登记', {
        skill: name,
        trigger: hit.trigger,
        subject: subjectKey(subject),
        reason: e.message,
      });
    }
  }

  /** 告警触发：游标之后开始触发、标签全部匹配的告警 */
  async alertTriggersOnce(): Promise<void> {
    const skills = this.activeSkills().filter((s) => s.manifest.triggers.some((t) => t.kind === 'alert'));
    const cur = await this.d.pool.query<{ at: Date }>("SELECT at FROM server.skill_cursors WHERE name = 'alerts'");
    const since = cur.rows[0]?.at ?? new Date(this.now() - 5 * 60_000);
    const rows = await this.d.pool.query<{ alertname: string; labels: Record<string, string>; starts_at: Date }>(
      `SELECT alertname, labels, starts_at FROM server.alert_state
        WHERE cluster_id = $1 AND status = 'firing' AND starts_at > $2 ORDER BY starts_at LIMIT 500`,
      [this.d.clusterId, since],
    );
    for (const a of rows.rows) {
      for (const skill of skills) {
        for (const t of skill.manifest.triggers) {
          if (t.kind !== 'alert') {
            continue;
          }
          const labels: Record<string, string | undefined> = { alertname: a.alertname, ...a.labels };
          const matchers = t.matchers as Record<string, string[]>;
          if (!Object.entries(matchers).every(([k, vs]) => vs.includes(labels[k] ?? ''))) {
            continue;
          }
          const ns = labels.namespace;
          const direct = ns
            ? labels.statefulset
              ? `StatefulSet:${ns}/${labels.statefulset}`
              : labels.deployment
                ? `Deployment:${ns}/${labels.deployment}`
                : labels.daemonset
                  ? `DaemonSet:${ns}/${labels.daemonset}`
                  : null
            : null;
          const subject = subjectOf(
            direct ?? (ns && labels.pod ? await this.d.ownerOf(this.d.clusterId, `Pod:${ns}/${labels.pod}`) : null),
          );
          if (subject) {
            await this.tryEnqueue(skill.name, subject, {
              trigger: t.id,
              kind: 'alert',
              at: a.starts_at.toISOString(),
              detail: a.alertname,
              pod: labels.pod ?? null,
              container: labels.container ?? null,
              cause: null,
            });
          }
        }
      }
    }
    const last = rows.rows[rows.rows.length - 1]?.starts_at;
    if (last) {
      await this.d.pool.query(
        `INSERT INTO server.skill_cursors (name, at) VALUES ('alerts', $1) ON CONFLICT (name) DO UPDATE SET at = excluded.at`,
        [last],
      );
    }
  }

  /**
   * Kubernetes 触发：informer 缓存中的 Pod。容器最近一次终止的原因在 terminated_reasons 中（每个容器的每次终止一次），
   * 或 Pod 以 pod_reasons 中的原因结束（每个 Pod 一次）。只看最近 15 分钟内的终止，server 启动时不回补更早的
   */
  async kubeTriggersOnce(
    objects: ReadonlyArray<{
      kind: string;
      metadata: {
        name: string;
        namespace?: string;
        uid?: string;
        ownerReferences?: Array<{ kind: string; name: string }>;
      };
      status?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    const skills = this.activeSkills().filter((s) => s.manifest.triggers.some((t) => t.kind === 'kube'));
    if (!skills.length) {
      return;
    }
    const rs = new Map<string, string | null>();
    for (const o of objects) {
      if (o.kind === 'ReplicaSet' && o.metadata.namespace) {
        const d = o.metadata.ownerReferences?.find((x) => x.kind === 'Deployment');
        rs.set(`${o.metadata.namespace}/${o.metadata.name}`, d ? d.name : null);
      }
    }
    const now = this.now();
    for (const p of objects) {
      if (p.kind !== 'Pod' || !p.metadata.namespace) {
        continue;
      }
      const ns = p.metadata.namespace;
      const owner = p.metadata.ownerReferences?.[0];
      const subject: SkillSubject | null = !owner
        ? null
        : owner.kind === 'ReplicaSet'
          ? rs.get(`${ns}/${owner.name}`)
            ? { kind: 'Deployment', namespace: ns, name: rs.get(`${ns}/${owner.name}`)! }
            : null
          : KINDS.has(owner.kind)
            ? { kind: owner.kind as SkillSubject['kind'], namespace: ns, name: owner.name }
            : null;
      if (!subject) {
        continue;
      }
      const st = p.status ?? {};
      const statuses =
        (st.containerStatuses as
          | Array<{ name: string; lastState?: { terminated?: { reason?: string; finishedAt?: string | Date } } }>
          | undefined) ?? [];
      for (const skill of skills) {
        for (const t of skill.manifest.triggers) {
          if (t.kind !== 'kube') {
            continue;
          }
          for (const c of statuses) {
            const term = c.lastState?.terminated;
            const at = term?.finishedAt ? new Date(term.finishedAt).getTime() : NaN;
            if (
              !term?.reason ||
              !t.match.terminated_reasons?.includes(term.reason) ||
              !Number.isFinite(at) ||
              now - at > 15 * 60_000
            ) {
              continue;
            }
            const key = `${skill.manifest.name}/${ns}/${p.metadata.name}/${c.name}`;
            if ((this.seenTerminations.get(key) ?? 0) >= at) {
              continue;
            }
            this.seenTerminations.set(key, at);
            await this.tryEnqueue(skill.manifest.name, subject, {
              trigger: t.id,
              kind: 'kube',
              at: new Date(at).toISOString(),
              detail: `${p.metadata.name}/${c.name} ${term.reason}`,
              pod: p.metadata.name,
              container: c.name,
              cause: term.reason === 'OOMKilled' ? 'oom_killed' : null,
            });
          }
          const reason = typeof st.reason === 'string' ? st.reason : null;
          if (reason && t.match.pod_reasons?.includes(reason)) {
            const key = `${skill.manifest.name}/${p.metadata.uid ?? `${ns}/${p.metadata.name}`}`;
            if (!this.seenEvictions.has(key)) {
              this.seenEvictions.add(key);
              await this.tryEnqueue(skill.manifest.name, subject, {
                trigger: t.id,
                kind: 'kube',
                at: toIso(now),
                detail: `${p.metadata.name} ${reason}`,
                pod: p.metadata.name,
                container: null,
                cause: reason === 'Evicted' ? 'evicted' : null,
              });
            }
          }
        }
      }
    }
  }

  // ---- 读取 ----

  async runs(name: string, limit: number): Promise<SkillRun[]> {
    const r = await this.d.pool.query<RunDbRow>(
      `SELECT ${RUN_COLUMNS} FROM server.skill_runs WHERE skill = $1 ORDER BY created_at DESC LIMIT $2`,
      [name, limit],
    );
    return r.rows.map(runOf);
  }

  async run(runId: string): Promise<{ run: SkillRun; calls: SkillCall[]; finding: SkillFinding | null } | null> {
    const r = await this.d.pool.query<RunDbRow>(`SELECT ${RUN_COLUMNS} FROM server.skill_runs WHERE run_id = $1`, [
      runId,
    ]);
    const row = r.rows[0];
    if (!row) {
      return null;
    }
    const calls = await this.d.pool.query<{ body: SkillCall }>(
      'SELECT body FROM server.skill_run_calls WHERE run_id = $1 ORDER BY seq',
      [runId],
    );
    let finding: SkillFinding | null = null;
    if (row.finding) {
      const f = await this.d.pool.query<{
        cluster_id: string;
        skill: string;
        fingerprint: string;
        generation: number;
        subject: SkillSubject;
        state: SkillFinding['state'];
        repo: string;
        number: number | null;
        url: string | null;
        occurrences: number;
        first_seen_at: Date;
        last_seen_at: Date;
        cooldown_until: Date | null;
        previous_number: number | null;
      }>(
        `SELECT cluster_id, skill, fingerprint, generation, subject, state, repo, number, url, occurrences, first_seen_at, last_seen_at,
                cooldown_until, previous_number
           FROM server.skill_findings WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
        [row.cluster_id, row.skill, row.finding.fingerprint, row.finding.generation],
      );
      const x = f.rows[0];
      finding = x
        ? {
            ...x,
            first_seen_at: x.first_seen_at.toISOString(),
            last_seen_at: x.last_seen_at.toISOString(),
            cooldown_until: x.cooldown_until?.toISOString() ?? null,
          }
        : null;
    }
    return { run: runOf(row), calls: calls.rows.map((c) => c.body), finding };
  }

  /** 状态条：没有通过校验的技能、清单要求而没有授予的能力 */
  conditions(): Observed[] {
    const out: Observed[] = [];
    for (const e of this.registry.list()) {
      if (e.error) {
        out.push({
          type: 'SkillLoadFailed',
          subject: e.name,
          active: true,
          reason: e.skill ? 'KeptPrevious' : 'NoVersion',
          message: e.error,
        });
      }
      if (this.d.config.enabled.includes(e.name) && e.skill) {
        const missing = this.registry.effective(e.name).missing;
        if (missing.length) {
          out.push({
            type: 'SkillCapabilityMissing',
            subject: e.name,
            active: true,
            reason: 'NotGranted',
            message: `技能 ${e.name} 需要的能力没有授予或 server 不具备：${missing.join('、')}`,
          });
        }
      }
    }
    for (const name of this.d.config.enabled) {
      if (!this.registry.get(name)) {
        out.push({
          type: 'SkillLoadFailed',
          subject: name,
          active: true,
          reason: 'NotFound',
          message: `skills.enabled 中的技能 ${name} 不在任何来源中`,
        });
      }
    }
    return out;
  }
}
