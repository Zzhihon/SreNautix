import type { EvidenceResult } from '@srenautix/contract';
import {
  domainRows,
  renderMetrics,
  runCard,
  type DomainRows,
  type EvidenceDataSource,
  type PackSet,
  type RenderEntity,
  type SignalResolution,
} from '@srenautix/packs-sdk';
import type { PromqlEngine } from '@srenautix/integration-sdk';
import { redactSamples } from '../stage-a/pack-evidence.js';
import { usesDbstats } from '../stage-a/packs.js';
import { hourly, HOUR_MS } from './stats.js';
import type { BackendLimiter } from './limits.js';

// 目标运行的证据（ADR 0146 §2.2、§3.1）：基线、差距、份额与门槛用到的每个数值都来自信号卡——
// 指标按实体渲染为固定的模板查询（目标不提交自由查询），区间不超过 14 天、超过 1 天时步长不小于 5 分钟（按小时取值时步长为
// 1 小时）、每个查询不超过 50 条序列；诊断卡与份额卡在组件上执行一次，按行得到逻辑实体。
// 每次后端查询都经 BackendLimiter（主动分析的并发、每小时上限与负载保护）。

export const MAX_RANGE_MS = 14 * 24 * HOUR_MS;
export const MAX_SERIES = 50;

/** 目标运行的数据源（optimize/datasource.ts 的 GoalSources）：run 给出时 dbstats 读取用这个运行的两次采样 */
export interface GoalMetricsSource {
  readonly engine: PromqlEngine;
  dataSource(at: number, run?: string | null): Promise<EvidenceDataSource>;
  resolve(
    set: PackSet,
    keys: Iterable<string>,
    ds: EvidenceDataSource,
    at: number,
  ): Promise<Map<string, SignalResolution>>;
}

export class GoalDataUnavailable extends Error {
  override name = 'GoalDataUnavailable';
}

export interface DomainCardRun {
  result: Omit<EvidenceResult, 'ref'>;
  rows: DomainRows;
}

export class GoalEvidence {
  constructor(
    private readonly set: () => PackSet,
    private readonly source: GoalMetricsSource,
    private readonly limiter: BackendLimiter,
    private readonly o: { locale: 'zh-CN' | 'en'; queryTimeoutMs: number },
  ) {}

  /**
   * 指标在窗口 [from, to) 内的按小时取值：查询结果的多条序列相加。没有可用的信号备选、数据源失败或超过上限时抛出
   * GoalDataUnavailable（基线据此判为无法判定）
   */
  async indicatorHourly(
    indicator: string,
    entity: RenderEntity,
    params: Record<string, number | string | boolean>,
    window: { from: number; to: number },
    signal: AbortSignal,
  ): Promise<Array<[number, number | null]>> {
    const set = this.set();
    const ind = set.indicators.get(indicator);
    if (!ind) {
      throw new GoalDataUnavailable(`领域包中没有指标 ${indicator}`);
    }
    if (window.to - window.from > MAX_RANGE_MS) {
      throw new GoalDataUnavailable('基线窗口超过 14 天');
    }
    const ds = await this.source.dataSource(window.to);
    const resolution = (await this.source.resolve(set, [ind.signal], ds, window.to)).get(ind.signal);
    if (!resolution?.alternative) {
      throw new GoalDataUnavailable(
        `指标 ${indicator} 的信号 ${ind.signal} 没有可用备选${resolution ? `：${resolution.rejected.map((r) => r.reason).join('；')}` : ''}`,
      );
    }
    if (resolution.kind !== 'metrics' || !ds.labelProfile) {
      throw new GoalDataUnavailable(`指标 ${indicator} 的信号不是指标信号，或指标数据源不可用`);
    }
    const expr = renderMetrics(this.source.engine, resolution.alternative, {
      entity,
      params,
      windowSeconds: 3600,
      profile: ds.labelProfile,
    });
    const iso = (t: number) => new Date(t).toISOString();
    const r = await this.limiter.run(
      'metrics',
      'optimization',
      () =>
        ds.queryRange({
          expr,
          dialect: resolution.alternative?.dialect === 'metricsql' ? 'metricsql' : 'promql',
          window: { from: iso(window.from), to: iso(window.to) },
          step_seconds: 3600,
          clock_window: { from: iso(window.from), to: iso(window.to) },
          timeout_ms: this.o.queryTimeoutMs,
          max_series: MAX_SERIES,
        }),
      { signal },
    );
    if (!r.ok) {
      throw new GoalDataUnavailable(`指标 ${indicator} 的查询没有执行：${r.reason}`);
    }
    const sums = new Map<number, number>();
    for (const s of r.value.series) {
      s.times.forEach((t, i) => {
        const v = s.values[i];
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          sums.set(t, (sums.get(t) ?? 0) + v);
        }
      });
    }
    return hourly(
      [...sums.entries()].map(([t, v]) => [t, v] as const),
      window.from,
      window.to,
    );
  }

  /** 在组件上执行领域的诊断卡或份额卡，按行得到逻辑实体（packs-sdk domainRows） */
  async domainCard(
    domain: string,
    item: { id: string; card: string },
    entity: RenderEntity & { uid: string | null },
    now: number,
    signal: AbortSignal,
    run: string | null = null,
  ): Promise<DomainCardRun> {
    const c = await this.card(item.card, entity, {}, now, signal, run);
    return { result: c.result, rows: domainRows(this.set(), domain, item.id, item.card, c.judgeInput) };
  }

  /**
   * 区分性检查的查询模板（领域的 templates）：在组件上执行模板附带的卡，参数（调用方已按模板 schema 校验）覆盖卡片默认参数
   */
  async template(
    templateId: string,
    params: Record<string, number | string | boolean>,
    entity: RenderEntity & { uid: string | null },
    now: number,
    signal: AbortSignal,
    run: string | null = null,
  ): Promise<Omit<EvidenceResult, 'ref'>> {
    const t = this.set().templates.find((x) => x.id === templateId);
    if (!t) {
      throw new GoalDataUnavailable(`没有查询模板 ${templateId}`);
    }
    return (await this.card(t.card, entity, params, now, signal, run)).result;
  }

  /**
   * 语句的规范化文本（dbstats statements.text，常量已是 $n）：业务 issue 的 sql 锚点（slow-statement）。
   * 每次最多 10 条，占用语句文本的每小时配额（§6.1）；数据源没有 dbstats 或请求被拒绝时返回空映射，模板按 no_anchor 跳过
   */
  async statementTexts(
    entity: RenderEntity,
    queryids: readonly string[],
    now: number,
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(queryids)].slice(0, 10);
    if (!ids.length) {
      return out;
    }
    const ds = await this.source.dataSource(now);
    if (!ds.dbstats) {
      return out;
    }
    const read = ds.dbstats.bind(ds);
    const r = await this.limiter.run(
      'dbstats',
      'optimization',
      () =>
        read(
          entity,
          { op: 'statements.text', args: { queryids: ids as [string, ...string[]] } },
          { at: now, rate: false },
        ),
      { signal, quota: ['dbstats_text'] },
    );
    if (!r.ok) {
      return out;
    }
    for (const row of r.value.current.rows) {
      const q = row.queryid;
      const text = row.query;
      if ((typeof q === 'string' || typeof q === 'number') && typeof text === 'string' && text) {
        out.set(String(q), text);
      }
    }
    return out;
  }

  /** 验证计划的卡片（verify.cards）：在实体上按卡片默认参数执行 */
  async checkCard(
    cardKey: string,
    entity: RenderEntity & { uid: string | null },
    now: number,
    signal: AbortSignal,
  ): Promise<Omit<EvidenceResult, 'ref'>> {
    return (await this.card(cardKey, entity, {}, now, signal, null)).result;
  }

  /**
   * PostgreSQL 参数的当前值（dbstats settings.get）：GUC 的验证起点核对新值已经生效（§2.6）。
   * 数据源没有 dbstats 时返回 null（不核对），读取失败抛出 GoalDataUnavailable
   */
  async settings(
    entity: RenderEntity,
    names: readonly string[],
    now: number,
    signal: AbortSignal,
  ): Promise<Map<string, { setting: string; unit: string | null }> | null> {
    const ds = await this.source.dataSource(now);
    if (!ds.dbstats || !names.length) {
      return null;
    }
    const read = ds.dbstats.bind(ds);
    const r = await this.limiter.run(
      'dbstats',
      'optimization',
      () =>
        read(
          entity,
          { op: 'settings.get', args: { names: names.slice(0, 20) as [string, ...string[]] } },
          { at: now, rate: false },
        ),
      { signal },
    );
    if (!r.ok) {
      throw new GoalDataUnavailable(`读取 PostgreSQL 参数没有执行：${r.reason}`);
    }
    const out = new Map<string, { setting: string; unit: string | null }>();
    for (const row of r.value.current.rows) {
      if (typeof row.name === 'string' && row.setting !== undefined && row.setting !== null) {
        out.set(row.name, { setting: String(row.setting), unit: typeof row.unit === 'string' ? row.unit : null });
      }
    }
    return out;
  }

  /** 负载保护卡（§6.2）：在实体上执行，返回判定；执行失败抛出 GoalDataUnavailable */
  async guardCard(
    cardKey: string,
    entity: RenderEntity & { uid: string | null },
    now: number,
    signal: AbortSignal,
  ): Promise<Omit<EvidenceResult, 'ref'>> {
    return (await this.card(cardKey, entity, {}, now, signal, null, true)).result;
  }

  /** 卡片是否引用 dbstats 信号 */
  usesDbstats(cardKey: string): boolean {
    return usesDbstats(this.set(), cardKey);
  }

  private async card(
    cardKey: string,
    entity: RenderEntity & { uid: string | null },
    params: Record<string, number | string | boolean>,
    now: number,
    signal: AbortSignal,
    run: string | null,
    guard = false,
  ): Promise<{ result: Omit<EvidenceResult, 'ref'>; judgeInput: Parameters<typeof domainRows>[4] }> {
    const set = this.set();
    const item = { card: cardKey };
    const e = set.cards.get(item.card);
    if (!e) {
      throw new GoalDataUnavailable(`没有卡片 ${item.card}`);
    }
    const ds = await this.source.dataSource(now, run);
    const resolutions = await this.source.resolve(set, Object.values(e.signals), ds, now);
    const exec = () =>
      runCard({
        set,
        card: item.card,
        entity,
        anchor: now,
        now,
        ds,
        engine: this.source.engine,
        resolutions,
        clock: { from: new Date(now - 24 * HOUR_MS).toISOString(), to: new Date(now).toISOString() },
        locale: this.o.locale,
        timeoutMs: this.o.queryTimeoutMs,
        redact: redactSamples,
        ...(Object.keys(params).length ? { params } : {}),
      });
    let c: Awaited<ReturnType<typeof runCard>>;
    if (guard) {
      // 负载保护卡本身只读指标（§6.2），不经负载保护（否则递归），计入指标的配额
      const r = await this.limiter.run('metrics', 'optimization', exec, { signal, skipGuard: true });
      if (!r.ok) {
        throw new GoalDataUnavailable(`负载保护卡 ${item.card} 没有执行：${r.reason}`);
      }
      c = r.value;
    } else {
      // 引用 dbstats 信号的卡直接查询 PostgreSQL：按 dbstats 的并发、配额与负载保护执行
      const r = await this.limiter.run(usesDbstats(set, cardKey) ? 'dbstats' : 'metrics', 'optimization', exec, {
        signal,
      });
      if (!r.ok) {
        throw new GoalDataUnavailable(`卡片 ${item.card} 没有执行：${r.reason}`);
      }
      c = r.value;
    }
    const result: Omit<EvidenceResult, 'ref'> = {
      card_id: c.card_id,
      title: c.title,
      threshold: c.threshold,
      series: [],
      entity: { ...c.entity!, uid: entity.uid },
      window: c.window,
      verdict: c.verdict,
      display_state: c.display_state,
      reason: c.reason,
      value: c.value,
      table: c.table,
      queries: c.queries,
      egress: c.egress,
      anomaly_started_at: c.anomaly_started_at ?? null,
      evaluated_at: c.evaluated_at,
      unit: c.unit ?? 'none',
      observations: c.observations ?? {},
      params: c.params ?? {},
      conditions: c.conditions ?? [],
      baseline: c.baseline ?? null,
      impact: c.impact ?? false,
      category: c.category ?? null,
      value_number: c.value_number ?? null,
      ...(c.samples ? { samples: c.samples } : {}),
    };
    return { result, judgeInput: c.judgeInput };
  }
}
