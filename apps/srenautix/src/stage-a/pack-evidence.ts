import type { Alert, EntityRef, EvidenceResult, Incident, Labels } from '@srenautix/contract';
import { matchTypeByName, tryNodeKey } from '@srenautix/core';
import { toIso } from '@srenautix/integration-sdk';
import {
  durationSeconds,
  evaluateExcludes,
  evaluateRules,
  runCard,
  DEFAULT_WINDOW,
  type EvidenceDataSource,
  type Locale,
  type RuleContext,
  type SignalResolution,
} from '@srenautix/packs-sdk';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { EvidenceSource, PackRuntime } from './packs.js';
import type { EvidenceRun, EvidenceRunner, RuleHit, RuleProposer } from './ports.js';
import { parseStoredKey } from '../topology/keys.js';

/**
 * 组件 key → 组件类型（拓扑节点上由 components.yaml 匹配出的值）。正常通道查状态库，
 * 降级通道查最后一轮成功对账时的内存拓扑。
 */
export type ComponentTypeLookup = (clusterId: string, key: string) => Promise<string | null>;

export interface PackEvidenceOptions {
  locale: Locale;
  /** 同时执行的卡片数（数据源并发）。 */
  concurrency: number;
  /** 单个查询的超时。 */
  queryTimeoutMs: number;
}

interface Planned {
  card: string;
  entity: EntityRef;
  /** 覆盖卡片默认参数（查询模板的参数） */
  params?: Record<string, number | string | boolean>;
}

/** 数据源的查询回看：卡片窗口之前再留 24 小时，供 rate 等函数的回看范围使用。 */
const LOOKBACK_MS = 24 * 3600_000;

function entityKey(e: EntityRef): string {
  return `${e.cluster_id}|${e.kind}|${e.namespace ?? ''}|${e.name}`;
}

function entityOf(clusterId: string, key: string): EntityRef {
  const k = parseStoredKey(key);
  return { cluster_id: clusterId, kind: k.kind, namespace: k.namespace, name: k.name, uid: null };
}

/** 固定并发执行；signal 中止后不再开始新的任务，已开始的任务照常结束。 */
async function pool<T, R>(items: T[], n: number, signal: AbortSignal, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length && !signal.aborted) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

/**
 * 领域包证据链的执行（DESIGN §6.1、§7.1，ADR 0097）：
 * - 根因（有歧义时前两个候选）按组件类型声明的证据链执行，实体为根因组件；
 * - 每个能解析出实体的成员告警，不论分类来源（label、catalog、expression、default），按实体的组件类型执行证据链；
 *   告警归属的组件（例如 Pod 的属主 StatefulSet）与实体不同时，组件类型的证据链也执行；
 * - 告警目录条目声明的证据链作为补充；
 * - 组件类型取拓扑节点上由领域包匹配出的类型，没有拓扑节点或没有匹配时，按 kind、命名空间与名称静态匹配
 *   （领域包的自定义 kind 与告警里的 CRD 对象走这一条）；
 * - 只执行 applies_to.kinds 包含实体类型的卡，同一张卡对同一实体只执行一次。
 * 卡片窗口以事件首次触发时间为锚点，终点不晚于当前时间。
 */
export class PackEvidence implements EvidenceRunner {
  constructor(
    private readonly rt: PackRuntime,
    private readonly source: EvidenceSource,
    private readonly componentType: ComponentTypeLookup,
    private readonly o: PackEvidenceOptions,
    private readonly metrics: ServerMetrics,
  ) {}

  async run(inc: Incident, alerts: Alert[], signal: AbortSignal): Promise<EvidenceRun> {
    const plan: Planned[] = [];
    const seen = new Set<string>();
    const chainsRun: string[] = [];
    const add = (chains: string[], entity: EntityRef) => {
      for (const ck of chains) {
        const chain = this.rt.set.chains.get(ck);
        if (!chain) {
          continue;
        }
        let any = false;
        for (const c of chain.chain.cards) {
          const card = `${ck}/${c.id}`;
          if (!(c.applies_to?.kinds ?? ['Pod']).includes(entity.kind)) {
            continue;
          }
          any = true;
          const k = `${card}|${entityKey(entity)}`;
          if (!seen.has(k)) {
            seen.add(k);
            plan.push({ card, entity });
          }
        }
        if (any && !chainsRun.includes(ck)) {
          chainsRun.push(ck);
        }
      }
    };

    const types = this.rt.componentTypes();
    const typeOf = async (key: string, e: EntityRef): Promise<string | null> =>
      (await this.componentType(inc.cluster_id, key)) ??
      matchTypeByName(e.kind, e.namespace, e.name, types)?.id ??
      null;

    let rootComponentType: string | null = null;
    const roots = [inc.root.component, ...(inc.root.ambiguous ? [inc.candidates[1]?.component ?? null] : [])];
    for (const [i, key] of roots.entries()) {
      if (!key) {
        continue;
      }
      const entity = i === 0 && inc.root.entity ? inc.root.entity : entityOf(inc.cluster_id, key);
      const t = await typeOf(key, entity);
      if (i === 0) {
        rootComponentType = t;
      }
      if (t) {
        add(this.rt.typeChains(t), entity);
      }
    }
    for (const a of alerts) {
      if (!a.entity) {
        continue;
      }
      const own = tryNodeKey(a.entity.kind, a.entity.namespace, a.entity.name);
      const t = own ? await typeOf(own, a.entity) : null;
      if (t) {
        add(this.rt.typeChains(t), a.entity);
      }
      if (a.component && a.component !== own) {
        const ce = entityOf(inc.cluster_id, a.component);
        const ct = await typeOf(a.component, ce);
        if (ct) {
          add(this.rt.typeChains(ct), a.entity);
          add(this.rt.typeChains(ct), ce);
        }
      }
      if (a.classification.catalog_entry) {
        add(this.rt.alertChains(a.classification.catalog_entry), a.entity);
      }
    }

    const cards = await this.execute(plan, Date.parse(inc.first_firing_at), Date.now(), signal);
    return {
      cards: cards.map((c, i) => ({ ...c, ref: `card:${i + 1}` })),
      chains: chainsRun,
      runbooks: this.runbooks(chainsRun),
      rootComponentType,
    };
  }

  async rerun(inc: Incident, cards: EvidenceResult[], windowTo: Date, signal: AbortSignal): Promise<EvidenceResult[]> {
    const wanted = cards.filter((c) => c.entity && this.rt.set.cards.has(c.card_id));
    const out: EvidenceResult[] = [];
    // 窗口终点为 windowTo：锚点取 windowTo 减去卡片窗口的 after
    await pool(wanted, this.o.concurrency, signal, async (c) => {
      const def = this.rt.set.cards.get(c.card_id)!.def;
      const after = durationSeconds((def.window ?? DEFAULT_WINDOW).after) * 1000;
      const [r] = await this.execute(
        [{ card: c.card_id, entity: c.entity! }],
        windowTo.getTime() - after,
        windowTo.getTime(),
        signal,
      );
      if (r) {
        out.push({ ...r, ref: c.ref });
      }
    });
    logger.info('证据卡实时重跑', { incident_id: inc.incident_id, cards: out.length });
    return wanted.map((c) => out.find((x) => x.ref === c.ref)).filter((x): x is EvidenceResult => x !== undefined);
  }

  /**
   * 阶段 B 区分性检查的查询模板：在 entity 上执行模板附带的卡，参数覆盖卡片默认参数。
   * 窗口以事件首次触发时间为锚点，终点不晚于 now。模板不存在或卡没有执行（例如窗口为空）时抛出。
   */
  async runTemplate(
    inc: Incident,
    templateId: string,
    args: Record<string, number | string | boolean>,
    entity: EntityRef,
    now: number,
    signal: AbortSignal,
  ): Promise<EvidenceResult> {
    const t = this.rt.templates.find((x) => x.id === templateId);
    if (!t) {
      throw new Error(`没有查询模板 ${templateId}`);
    }
    const [r] = await this.execute(
      [{ card: t.card, entity, params: args }],
      Date.parse(inc.first_firing_at),
      now,
      signal,
    );
    if (!r) {
      throw new Error(`查询模板 ${templateId} 没有执行（见 server 日志）`);
    }
    return { ...r, ref: 'card:1' };
  }

  private runbooks(chains: string[]): string[] {
    const out: string[] = [];
    for (const ck of chains) {
      const ch = this.rt.set.chains.get(ck);
      if (ch?.chain.runbook) {
        const ref = `${ch.pack}/${ch.chain.runbook}`;
        if (!out.includes(ref)) {
          out.push(ref);
        }
      }
    }
    return out;
  }

  /** 执行计划中的卡；结果按计划顺序，没有完成（中止或运行时错误）的卡不出现在结果中。 */
  private async execute(
    plan: Planned[],
    anchor: number,
    now: number,
    signal: AbortSignal,
  ): Promise<Array<Omit<EvidenceResult, 'ref'>>> {
    if (!plan.length) {
      return [];
    }
    const ds: EvidenceDataSource = await this.source.dataSource(now);
    const keys = new Set(plan.flatMap((p) => Object.values(this.rt.set.cards.get(p.card)!.signals)));
    const resolutions: Map<string, SignalResolution> = await this.source.resolve(this.rt.set, keys, ds, now);
    type Done = Omit<EvidenceResult, 'ref'>;
    const results = await pool(plan, this.o.concurrency, signal, async (p): Promise<Done | null> => {
      const e = this.rt.set.cards.get(p.card)!;
      const before = durationSeconds((e.def.window ?? DEFAULT_WINDOW).before) * 1000;
      const started = performance.now();
      try {
        const r = await runCard({
          set: this.rt.set,
          card: p.card,
          entity: {
            cluster_id: p.entity.cluster_id,
            kind: p.entity.kind,
            namespace: p.entity.namespace,
            name: p.entity.name,
            node: p.entity.kind === 'Node' ? p.entity.name : null,
          },
          anchor,
          now,
          ds,
          engine: this.source.engine,
          resolutions,
          clock: { from: toIso(anchor - before - LOOKBACK_MS), to: toIso(now) },
          locale: this.o.locale,
          timeoutMs: this.o.queryTimeoutMs,
          ...(p.params ? { params: p.params } : {}),
        });
        this.metrics.evidenceCards.inc({ display_state: r.display_state });
        this.metrics.evidenceCardSeconds.observe((performance.now() - started) / 1000);
        // 只保留契约中的 EvidenceResult 字段（判定明细与原始数据不进入报告）
        return {
          card_id: r.card_id,
          title: r.title,
          threshold: r.threshold,
          series: r.series,
          entity: { ...r.entity!, uid: p.entity.uid },
          window: r.window,
          verdict: r.verdict,
          display_state: r.display_state,
          reason: r.reason,
          value: r.value,
          table: r.table,
          queries: r.queries,
          egress: r.egress,
          anomaly_started_at: r.anomaly_started_at ?? null,
          evaluated_at: r.evaluated_at,
        };
      } catch (err) {
        // 渲染与判定的错误由运行时记在卡片里；这里只剩窗口为空等计划本身的问题
        this.metrics.evidenceCards.inc({ display_state: 'runtime_error' });
        logger.warn('证据卡没有执行', { card: p.card, entity: entityKey(p.entity), error: err });
        return null;
      }
    });
    if (signal.aborted) {
      logger.warn('证据卡执行被中止，未完成的卡不进入报告', {
        planned: plan.length,
        done: results.filter((r) => r).length,
      });
    }
    return results.filter((r): r is Done => r !== null && r !== undefined);
  }
}

/** 全部成员告警共有的标签。 */
function commonLabels(alerts: Alert[]): Labels {
  if (!alerts.length) {
    return {};
  }
  const [first, ...rest] = alerts;
  return Object.fromEntries(
    Object.entries(first!.labels).filter(([k, v]) => rest.every((a) => a.labels[k] === v)),
  ) as Labels;
}

/** 领域包的规则提议（rules.yaml）：when 与参数值都是 CEL，上下文为 incident、root、cards。 */
export class PackRules implements RuleProposer {
  constructor(
    private readonly rt: PackRuntime,
    private readonly metrics: ServerMetrics,
  ) {}

  /** 规则提议与排除规则共用的 CEL 上下文；没有根因实体时为 null（两者都不求值）。 */
  private context(inc: Incident, alerts: Alert[], run: EvidenceRun): RuleContext | null {
    const root = inc.root.entity;
    if (!root) {
      return null;
    }
    const cards: RuleContext['cards'] = {};
    // 同一张卡对多个实体执行时，以根因实体上的结果为准（根因的卡排在前面）
    for (const c of run.cards) {
      cards[c.card_id] ??= {
        verdict: c.verdict,
        display_state: c.display_state,
        value: c.value ?? '',
        reason_kind: c.reason.kind,
      };
    }
    return {
      incident: {
        id: inc.incident_id,
        version: inc.incident_version,
        severity: inc.severity,
        labels: commonLabels(alerts),
        alerts: alerts.map((a) => ({
          alertname: a.alertname,
          role: a.classification.role,
          severity: a.severity,
          labels: a.labels,
        })),
      },
      root: {
        cluster_id: root.cluster_id,
        kind: root.kind,
        namespace: root.namespace ?? '',
        name: root.name,
        component_type: run.rootComponentType ?? '',
      },
      cards,
    };
  }

  evaluate(inc: Incident, alerts: Alert[], run: EvidenceRun): RuleHit[] {
    const ctx = this.context(inc, alerts, run);
    if (!ctx || !this.rt.set.rules.length) {
      return [];
    }
    const ev = evaluateRules(this.rt.set, ctx);
    for (const e of ev.errors) {
      this.metrics.ruleErrors.inc({ rule: `${e.pack}/${e.rule_id}` });
      logger.warn('规则提议求值出错', { incident_id: inc.incident_id, rule: `${e.pack}/${e.rule_id}`, error: e.error });
    }
    return ev.proposals.map((p) => {
      const rule = this.rt.set.rules.find((r) => r.pack === p.pack && r.rule.id === p.rule_id)!.rule;
      return {
        pack: p.pack,
        ruleId: p.rule_id,
        action: p.action,
        params: p.params,
        title: p.title,
        expectedEffect: rule.expected_effect ?? null,
      };
    });
  }

  /** 执行过的证据链上的排除规则，按声明顺序取第一条命中；求值出错的规则不命中。 */
  excluded(inc: Incident, alerts: Alert[], run: EvidenceRun): string | null {
    const ctx = this.context(inc, alerts, run);
    if (!ctx || !run.chains.length) {
      return null;
    }
    const ev = evaluateExcludes(this.rt.set, run.chains, ctx);
    for (const e of ev.errors) {
      const ref = `${e.chain}#excludes[${e.index}]`;
      this.metrics.ruleErrors.inc({ rule: ref });
      logger.warn('排除规则求值出错', { incident_id: inc.incident_id, rule: ref, error: e.error });
    }
    return ev.hit ? `${ev.hit.chain}#excludes[${ev.hit.index}]` : null;
  }
}
