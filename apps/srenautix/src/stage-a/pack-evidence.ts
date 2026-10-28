import {
  reasonText,
  type Alert,
  type EntityRef,
  type EvidenceResult,
  type Incident,
  type Labels,
  type RuleConclusion,
} from '@srenautix/contract';
import { matchTypeByName, sameKind, tryNodeKey } from '@srenautix/core';
import { toIso } from '@srenautix/integration-sdk';
import {
  cardWindow,
  compileSamples,
  durationSeconds,
  evaluateConclusions,
  evaluateExcludes,
  evaluateRules,
  type ConclusionInput,
  runCard,
  samplesDeadline,
  DEFAULT_WINDOW,
  type EvidenceDataSource,
  type Locale,
  type Redactor,
  resolveDisplayName,
  type RuleContext,
  type RunCardInput,
  type SignalResolution,
} from '@srenautix/packs-sdk';
import { countHits, redactText } from '../llm/redact.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { EvidenceSource, PackRuntime } from './packs.js';
import type { EvidenceRun, EvidenceRunner, RuleHit, RuleProposer } from './ports.js';
import { isLogicalComponent } from '../topology/expand.js';
import { parseStoredKey } from '../topology/keys.js';
import { cardApplies, splitCardCheckArgs } from './card-checks.js';
import { decideNovelty, isRoutine, sampleOffsets, type NoveltyOptions, type NoveltySample } from './novelty.js';
import { requiredEvidence } from './required.js';

/**
 * 组件 key → 组件类型（拓扑节点上由 components.yaml 匹配出的值）。正常通道查状态库，
 * 降级通道查最后一轮成功对账时的内存拓扑。
 */
export type ComponentTypeLookup = (clusterId: string, key: string) => Promise<string | null>;

/**
 * 逻辑组件 → 候选组件键（ComponentExpander.logicalCandidates，ADR 0130）；参数是落在这个逻辑组件上的告警。
 * 不是逻辑组件时为空。
 */
export type LogicalLookup = (clusterId: string, key: string, alerts: readonly Alert[], at: Date) => Promise<string[]>;

export interface PackEvidenceOptions {
  locale: Locale;
  /** 同时执行的卡片数（数据源并发）。 */
  concurrency: number;
  /** 单个查询的超时。 */
  queryTimeoutMs: number;
  /** 长期事件的卡片窗口最长多少（ADR 0149），默认 DEFAULT_MAX_CARD_WINDOW_MS */
  maxCardWindowMs?: number;
  /** 指标数据源的保留期：卡片窗口起点不早于评估时刻减去它（ADR 0149）；不填时不限 */
  metricsRetentionMs?: number | null;
  /** 证据基线（ADR 0153）：异常卡在事件之前的时段取基线样本；不填时不取 */
  novelty?: NoveltyOptions;
}

/** 长期事件的卡片窗口默认最长 24 小时：区间查询最多约 300 个点，步长不超过 5 分钟 */
export const DEFAULT_MAX_CARD_WINDOW_MS = 24 * 3600_000;

interface Planned {
  card: string;
  entity: EntityRef;
  /** 执行这张卡所为的组件：根因候选，或告警归属的组件（结论规则的 self 条件按它判断，ADR 0178） */
  component?: string;
  /** 覆盖卡片默认参数（查询模板的参数） */
  params?: Record<string, number | string | boolean>;
  /** 覆盖卡片定义的窗口（卡片检查，ADR 0116） */
  window?: { before: string; after: string };
  /** 实体上最晚开始的在场成员告警（unix 毫秒）；卡片窗口装不下它时按它重新锚定（ADR 0107 §7） */
  latest?: number;
}

/** 卡片的锚点：事件首次触发；实体上最晚开始的成员告警落在卡片窗口之后时（之后才升级的告警）按它重新锚定 */
function anchorOf(p: Planned, anchor: number, afterMs: number): number {
  return p.latest !== undefined && p.latest > anchor + afterMs ? p.latest : anchor;
}

/**
 * 每个实体（与告警归属的组件）上最晚开始的在场成员告警（unix 毫秒）：卡片窗口装不下它时按它重新锚定（ADR 0107 §7）。
 * 阶段 A 的证据卡与阶段 B 的检查（卡片检查与查询模板）用同一个函数，同一实体上两者看到的时间段相同（ADR 0131）。
 */
export function memberLatest(alerts: readonly Alert[]): (entity: EntityRef) => number | undefined {
  const latest = new Map<string, number>();
  const note = (k: string | null, t: number) => {
    if (k !== null && Number.isFinite(t) && t > (latest.get(k) ?? -Infinity)) {
      latest.set(k, t);
    }
  };
  for (const a of alerts) {
    const t = Date.parse(a.starts_at);
    note(a.entity ? entityKey(a.entity) : null, t);
    note(a.component, t);
  }
  return (entity) =>
    latest.get(entityKey(entity)) ?? latest.get(tryNodeKey(entity.kind, entity.namespace, entity.name) ?? '');
}

/** 数据源的查询回看：卡片窗口之前再留 24 小时，供 rate 等函数的回看范围使用。 */
const LOOKBACK_MS = 24 * 3600_000;

function entityKey(e: EntityRef): string {
  return `${e.cluster_id}|${e.kind}|${e.namespace ?? ''}|${e.name}`;
}

function strings(l: Labels | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(l ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function entityOf(clusterId: string, key: string): EntityRef {
  const k = parseStoredKey(key);
  return { cluster_id: clusterId, kind: k.kind, namespace: k.namespace, name: k.name, uid: null };
}

/** 错误样例的脱敏（ADR 0177）：与出站模块相同的规则（DESIGN §8.4），样例写进报告之前就已脱敏 */
export const redactSamples: Redactor = (text) => {
  const r = redactText(text);
  return { text: r.text, hits: countHits(r.hits) };
};

/** promise 完成时取它的结果；signal 先中止时为 null，promise 之后的失败只记日志 */
async function untilAborted<T>(p: Promise<T>, signal: AbortSignal, what: string): Promise<T | null> {
  if (signal.aborted) {
    p.catch((err: unknown) => logger.warn('期限之后结束的任务失败', { task: what, error: err }));
    return null;
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const r = await Promise.race([p, aborted]);
    if (r === null) {
      p.catch((err: unknown) => logger.warn('期限之后结束的任务失败', { task: what, error: err }));
    }
    return r;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
 * - 逻辑组件（根因或告警归属的组件，例如 component:catalog）映射到候选工作负载，候选按自己的组件类型执行证据链（ADR 0130）；
 * - 组件类型取拓扑节点上由领域包匹配出的类型，没有拓扑节点或没有匹配时，按 kind、命名空间与名称静态匹配
 *   （领域包的自定义 kind 与告警里的 CRD 对象走这一条）；
 * - 只执行 applies_to.kinds 包含实体类型的卡，同一张卡对同一实体只执行一次。
 * 卡片窗口以事件首次触发时间为锚点，终点不晚于当前时间；评估时刻晚于锚定窗口的终点时（长期事件），终点取评估时刻，
 * 起点不早于终点减去最大窗口（ADR 0149）。
 */
export class PackEvidence implements EvidenceRunner {
  constructor(
    private readonly rt: PackRuntime,
    private readonly source: EvidenceSource,
    private readonly componentType: ComponentTypeLookup,
    private readonly o: PackEvidenceOptions,
    private readonly metrics: ServerMetrics,
    /** 逻辑组件的候选；没有时逻辑组件上只执行告警目录条目声明的证据链 */
    private readonly logical: LogicalLookup | null = null,
  ) {}

  /** now：评估时刻（默认当前时间）；评测与回放传入快照的 as_of，卡片窗口与信号探测都不晚于它 */
  async run(inc: Incident, alerts: Alert[], signal: AbortSignal, now = Date.now()): Promise<EvidenceRun> {
    const plan: Planned[] = [];
    const seen = new Map<string, Planned>();
    const chainsRun: string[] = [];
    const latestOf = memberLatest(alerts);
    const add = (chains: string[], entity: EntityRef, component: string | null) => {
      for (const ck of chains) {
        const chain = this.rt.set.chains.get(ck);
        if (!chain) {
          continue;
        }
        let any = false;
        for (const c of chain.chain.cards) {
          const card = `${ck}/${c.id}`;
          // 卡片按不带 API 组的 kind 声明，实体的 kind 取拓扑的写法（Application.argoproj.io）：按 sameKind 比较
          if (!(c.applies_to?.kinds ?? ['Pod']).some((k) => sameKind(k, entity.kind))) {
            continue;
          }
          any = true;
          const k = `${card}|${entityKey(entity)}`;
          if (!seen.has(k)) {
            const l = latestOf(entity);
            const p: Planned = {
              card,
              entity,
              ...(component !== null ? { component } : {}),
              ...(l !== undefined ? { latest: l } : {}),
            };
            seen.set(k, p);
            plan.push(p);
          }
        }
        if (any && !chainsRun.includes(ck)) {
          chainsRun.push(ck);
        }
      }
    };

    const types = this.rt.componentTypes();
    // 求出了组件类型的组件（结论规则按求值对象的组件类型筛选，ADR 0178）
    const typed: Record<string, string> = {};
    const typeOf = async (key: string, e: EntityRef): Promise<string | null> => {
      const t =
        (await this.componentType(inc.cluster_id, key)) ??
        matchTypeByName(e.kind, e.namespace, e.name, types)?.id ??
        null;
      if (t !== null) {
        typed[key] ??= t;
      }
      return t;
    };

    // 要求可读名称的组件：键 → 组件类型、实体与它所在告警的标签、注解（第一个出现的告警）
    const named = new Map<string, { type: string; entity: EntityRef; alert: Alert | null }>();
    const wantName = (key: string, type: string | null, entity: EntityRef, alert: Alert | null) => {
      if (type && this.hasDisplayName(type)) {
        const cur = named.get(key);
        if (!cur || (!cur.alert && alert)) {
          named.set(key, { type, entity, alert });
        }
      }
    };

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
      wantName(key, t, entity, null);
      if (t) {
        add(this.rt.typeChains(t), entity, key);
      }
    }
    for (const a of alerts) {
      if (!a.entity) {
        continue;
      }
      const own = tryNodeKey(a.entity.kind, a.entity.namespace, a.entity.name);
      // 告警实体上的卡属于告警归属的组件（例如 Pod 上的卡属于它的 StatefulSet 或 CNPG 集群）
      const owner = a.component ?? own;
      const t = own ? await typeOf(own, a.entity) : null;
      if (t) {
        add(this.rt.typeChains(t), a.entity, owner);
      }
      if (own) {
        wantName(own, t, a.entity, a);
      }
      if (a.component && a.component !== own) {
        const ce = entityOf(inc.cluster_id, a.component);
        const ct = await typeOf(a.component, ce);
        wantName(a.component, ct, ce, a);
        if (ct) {
          add(this.rt.typeChains(ct), a.entity, a.component);
          add(this.rt.typeChains(ct), ce, a.component);
        }
      }
      if (a.classification.catalog_entry) {
        add(this.rt.alertChains(a.classification.catalog_entry), a.entity, owner);
      }
    }

    // 逻辑组件（根因或告警归属的组件）映射到候选工作负载，候选按自己的组件类型执行证据链（ADR 0130）
    if (this.logical) {
      const logical = [
        ...new Set(
          [...roots, ...alerts.map((a) => a.component)].filter((k): k is string => isLogicalComponent(k ?? '')),
        ),
      ];
      for (const key of logical) {
        const on = alerts.filter((a) => a.component === key);
        for (const cand of await this.logical(inc.cluster_id, key, on, new Date(now))) {
          const e = entityOf(inc.cluster_id, cand);
          const t = await typeOf(cand, e);
          if (t) {
            add(this.rt.typeChains(t), e, key);
          }
        }
      }
    }

    const extend = this.extendTo(inc, now);
    const cards = await this.execute(plan, Date.parse(inc.first_firing_at), now, signal, extend);
    // 组件名称在首次触发时求值；长期事件不早于最近一个最大窗口的起点（与卡片窗口一致）
    const namesAt = Math.max(Math.min(Date.parse(inc.first_firing_at), now), extend.until - extend.maxWindowMs);
    const names = await this.names(named, Math.min(namesAt, now), signal);
    const planned = new Map(
      plan.filter((p) => p.component).map((p) => [`${p.card}|${entityKey(p.entity)}`, p.component!]),
    );
    const refd = cards.map((c, i) => ({ ...c, ref: `card:${i + 1}` }));
    const cardComponents: Record<string, string> = {};
    for (const c of refd) {
      const k = c.entity ? planned.get(`${c.card_id}|${entityKey(c.entity)}`) : undefined;
      if (k !== undefined) {
        cardComponents[c.ref] = k;
      }
    }
    return {
      cards: refd,
      cardComponents,
      componentTypes: typed,
      chains: chainsRun,
      runbooks: this.runbooks(chainsRun),
      rootComponentType,
      names,
      required: requiredEvidence((entry) => this.rt.requiredCards(entry), alerts, cards),
    };
  }

  private hasDisplayName(type: string): boolean {
    return this.rt.componentTypes().some((t) => t.id === type && (t.display_name?.length ?? 0) > 0);
  }

  /**
   * 组件的可读名称（ADR 0101）：在事件锚点按组件类型声明的来源求值（packs-sdk 的 resolveDisplayName）。
   * 名称只用于显示：数据源错误由运行时吞掉，其他异常记日志后跳过这个组件，不影响证据卡与阶段 A。
   */
  private async names(
    named: Map<string, { type: string; entity: EntityRef; alert: Alert | null }>,
    at: number,
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (!named.size || signal.aborted) {
      return out;
    }
    let ds: EvidenceDataSource;
    try {
      ds = await this.source.dataSource(at);
    } catch (e) {
      logger.warn('组件名称：数据源不可用，跳过', { error: e });
      return out;
    }
    await pool([...named.entries()], this.o.concurrency, signal, async ([key, n]) => {
      try {
        const v = await resolveDisplayName(
          this.rt.set,
          n.type,
          {
            entity: {
              cluster_id: n.entity.cluster_id,
              kind: n.entity.kind,
              namespace: n.entity.namespace,
              name: n.entity.name,
              node: n.entity.kind === 'Node' ? n.entity.name : null,
            },
            labels: strings(n.alert?.labels),
            annotations: strings(n.alert?.annotations),
          },
          ds,
          at,
        );
        if (v) {
          out[key] = v.slice(0, 200);
        }
      } catch (e) {
        logger.warn('组件名称求值失败，显示组件键', { component: key, type: n.type, error: e });
      }
    });
    return out;
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
   * 锚点与卡片检查相同（runCardCheck，ADR 0131），终点不晚于 now。模板不存在或卡没有执行（例如窗口为空）时抛出。
   */
  async runTemplate(
    inc: Incident,
    templateId: string,
    args: Record<string, number | string | boolean>,
    entity: EntityRef,
    alerts: readonly Alert[],
    now: number,
    signal: AbortSignal,
  ): Promise<EvidenceResult> {
    const t = this.rt.templates.find((x) => x.id === templateId);
    if (!t) {
      throw new Error(`没有查询模板 ${templateId}`);
    }
    const latest = memberLatest(alerts)(entity);
    const [r] = await this.execute(
      [{ card: t.card, entity, params: args, ...(latest !== undefined ? { latest } : {}) }],
      Date.parse(inc.first_firing_at),
      now,
      signal,
      this.extendTo(inc, now),
    );
    if (!r) {
      throw new Error(`查询模板 ${templateId} 没有执行（见 server 日志）`);
    }
    return { ...r, ref: 'card:1' };
  }

  /**
   * 卡片检查（ADR 0116）：在 entity 上执行证据链的卡 card；args 中的 window_before/window_after 覆盖卡片的窗口，
   * 其余覆盖卡片的默认参数。
   * 锚点与阶段 A 相同（ADR 0131）：事件首次触发；alerts（研判所用事件版本的在场成员告警）里 entity 上最晚开始的告警
   * 落在窗口之后时按它重新锚定。终点不晚于 now（研判时刻）。卡片不存在、不适用于实体的 kind 或没有执行时抛出。
   */
  async runCardCheck(
    inc: Incident,
    card: string,
    args: Record<string, unknown>,
    entity: EntityRef,
    alerts: readonly Alert[],
    now: number,
    signal: AbortSignal,
  ): Promise<EvidenceResult> {
    const e = this.rt.set.cards.get(card);
    if (!e || e.chain === null) {
      throw new Error(`没有证据链的卡 ${card}`);
    }
    if (!cardApplies(e, entity.kind)) {
      throw new Error(`卡 ${card} 不适用于 ${entity.kind}`);
    }
    const { params, window } = splitCardCheckArgs(e, args);
    const latest = memberLatest(alerts)(entity);
    const [r] = await this.execute(
      [{ card, entity, params, ...(window ? { window } : {}), ...(latest !== undefined ? { latest } : {}) }],
      Date.parse(inc.first_firing_at),
      now,
      signal,
      this.extendTo(inc, now),
    );
    if (!r) {
      throw new Error(`卡 ${card} 没有执行（见 server 日志）`);
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

  /**
   * 长期事件的窗口（ADR 0149）：评估时刻为 now，已恢复的事件为恢复时刻（不晚于 now）；它晚于锚定窗口的终点时，
   * 卡片窗口终点取评估时刻，起点不早于终点减去最大窗口，也不早于数据保留期。
   */
  private extendTo(inc: Incident | null, now: number): NonNullable<RunCardInput['extend']> {
    const ended = inc?.ended_at ? Date.parse(inc.ended_at) : NaN;
    const retention = this.o.metricsRetentionMs ?? null;
    return {
      until: Number.isFinite(ended) ? Math.min(ended, now) : now,
      maxWindowMs: this.o.maxCardWindowMs ?? DEFAULT_MAX_CARD_WINDOW_MS,
      ...(retention !== null ? { notBefore: now - retention } : {}),
    };
  }

  /** 执行计划中的卡；结果按计划顺序，没有完成（中止或运行时错误）的卡不出现在结果中。 */
  private async execute(
    plan: Planned[],
    anchor: number,
    now: number,
    signal: AbortSignal,
    extend: RunCardInput['extend'] = undefined,
  ): Promise<Array<Omit<EvidenceResult, 'ref'>>> {
    if (!plan.length) {
      return [];
    }
    // 标签档案与信号备选在卡片窗口的终点探测（不晚于 now）：事件开始两小时之后重跑或回放时，
    // 按事件当时的数据选择备选，不按墙上时钟（否则 [当前−2h, 当前] 内没有序列，每张卡都是 source_error）。
    // 长期事件的窗口终点是评估时刻，在那里探测（锚点时指标可能还不存在，ADR 0149）；评估时刻没有数据的信号
    // （数据在窗口后段之前就断了，例如回放、重启后补跑）再在锚定窗口的终点探测
    const afterOf = (p: Planned) =>
      durationSeconds((p.window ?? this.rt.set.cards.get(p.card)!.def.window ?? DEFAULT_WINDOW).after) * 1000;
    const anchoredOf = (p: Planned) => anchorOf(p, anchor, afterOf(p)) + afterOf(p);
    const endOf = (p: Planned) => (extend && extend.until > anchoredOf(p) ? extend.until : anchoredOf(p));
    const probeAt = Math.min(now, Math.max(...plan.map(endOf)));
    const fallbackAt = Math.min(now, Math.max(...plan.map(anchoredOf)));
    const ds: EvidenceDataSource = await this.source.dataSource(probeAt, Date.now(), fallbackAt);
    const keys = new Set(plan.flatMap((p) => Object.values(this.rt.set.cards.get(p.card)!.signals)));
    const resolutions: Map<string, SignalResolution> = await this.source.resolve(this.rt.set, keys, ds, probeAt);
    const missing = [...keys].filter((k) => resolutions.get(k)?.index === null);
    if (fallbackAt < probeAt && missing.length) {
      for (const [k, r] of await this.source.resolve(this.rt.set, missing, ds, fallbackAt)) {
        if (r.index !== null) {
          resolutions.set(k, r);
        }
      }
    }
    type Done = Omit<EvidenceResult, 'ref'>;
    // 每张卡实际使用的锚点（证据基线按它平移，ADR 0153）
    const anchors = new Map<Planned, number>();
    const results = await pool(plan, this.o.concurrency, signal, async (p): Promise<Done | null> => {
      const e = this.rt.set.cards.get(p.card)!;
      const before = durationSeconds((p.window ?? e.def.window ?? DEFAULT_WINDOW).before) * 1000;
      const at = anchorOf(p, anchor, afterOf(p));
      anchors.set(p, at);
      const started = performance.now();
      try {
        const run = runCard({
          set: this.rt.set,
          card: p.card,
          entity: {
            cluster_id: p.entity.cluster_id,
            kind: p.entity.kind,
            namespace: p.entity.namespace,
            name: p.entity.name,
            node: p.entity.kind === 'Node' ? p.entity.name : null,
          },
          anchor: at,
          now,
          ds,
          engine: this.source.engine,
          resolutions,
          clock: { from: toIso(at - before - LOOKBACK_MS), to: toIso(now) },
          locale: this.o.locale,
          timeoutMs: this.o.queryTimeoutMs,
          redact: redactSamples,
          ...(p.params ? { params: p.params } : {}),
          ...(p.window ? { window: p.window } : {}),
          ...(extend ? { extend } : {}),
        });
        // 错误样例卡（ADR 0177）在证据期限到达时不再等待日志查询，结果记原因码 samples_deadline
        const r = e.def.samples ? await untilAborted(run, signal, p.card) : await run;
        if (r === null) {
          return this.deadline(p, at, now, extend);
        }
        this.metrics.evidenceCards.inc({ display_state: r.display_state });
        this.metrics.evidenceCardSeconds.observe((performance.now() - started) / 1000);
        if (r.samples?.code) {
          this.metrics.terminal('stage_a', r.samples.code);
        }
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
          unit: r.unit ?? 'none',
          observations: r.observations ?? {},
          params: r.params ?? {},
          conditions: r.conditions ?? [],
          baseline: r.baseline ?? null,
          impact: r.impact ?? false,
          category: r.category ?? null,
          value_number: r.value_number ?? null,
          ...(r.samples ? { samples: r.samples } : {}),
        };
      } catch (err) {
        // 渲染与判定的错误由运行时记在卡片里；这里只剩窗口为空等计划本身的问题
        this.metrics.evidenceCards.inc({ display_state: 'runtime_error' });
        logger.warn('证据卡没有执行', { card: p.card, entity: entityKey(p.entity), error: err });
        return null;
      }
    });
    if (signal.aborted) {
      logger.warn('证据卡执行被中止，未完成的卡不进入报告（错误样例卡记 samples_deadline）', {
        planned: plan.length,
        done: results.filter((r) => r).length,
      });
    }
    // 期限到达时还没有开始的错误样例卡同样出结果，记原因码（ADR 0177）；其余没有开始的卡不进入报告
    const filled = plan.map((p, i) =>
      results[i] === undefined && signal.aborted && this.rt.set.cards.get(p.card)!.def.samples
        ? this.deadline(p, anchorOf(p, anchor, afterOf(p)), now, extend)
        : (results[i] ?? null),
    );
    const done = plan
      .map((p, i) => ({ p, r: filled[i] }))
      .filter((x): x is { p: Planned; r: Done } => x.r !== null && x.r !== undefined);
    const o = this.o.novelty;
    if (o?.enabled && !signal.aborted) {
      // 声明 baseline: false 的卡描述的是这次故障的类型，不和事件之前的时段比较（ADR 0164）
      await this.baseline(
        done
          .filter((x) => x.r.verdict === 'abnormal' && this.rt.set.cards.get(x.p.card)!.def.baseline !== false)
          .map((x) => ({ ...x, at: anchors.get(x.p)! })),
        o,
        ds,
        resolutions,
        signal,
      );
    }
    return done.map((x) => x.r);
  }

  /**
   * 证据期限内没有执行完的错误样例卡（ADR 0177）：无法判定，原因为数据源报错，样例为空并记原因码 samples_deadline，
   * 研判与消息据此知道错误日志没有取到。窗口为空时与其他卡一样不进入报告
   */
  private deadline(
    p: Planned,
    at: number,
    now: number,
    extend: RunCardInput['extend'],
  ): Omit<EvidenceResult, 'ref'> | null {
    const e = this.rt.set.cards.get(p.card)!;
    let w: { from: number; to: number };
    try {
      w = cardWindow(e, at, now, p.window, extend);
    } catch (err) {
      if (!(err instanceof RangeError)) {
        throw err;
      }
      logger.warn('证据卡没有执行', { card: p.card, entity: entityKey(p.entity), error: err });
      return null;
    }
    this.metrics.evidenceCards.inc({ display_state: 'undeterminable' });
    this.metrics.terminal('stage_a', 'samples_deadline');
    return {
      card_id: e.key,
      title: e.def.title,
      threshold: null,
      series: [],
      entity: { ...p.entity },
      window: { from: toIso(w.from), to: toIso(w.to) },
      verdict: 'undeterminable',
      display_state: 'undeterminable',
      reason: {
        kind: 'source_error',
        text: reasonText('stage_a', 'samples_deadline', this.o.locale),
      },
      value: null,
      table: null,
      queries: [],
      egress: e.def.egress,
      anomaly_started_at: null,
      evaluated_at: new Date().toISOString(),
      unit: e.def.display?.unit ?? 'none',
      observations: {},
      params: { ...(e.def.params ?? {}), ...(p.params ?? {}) },
      conditions: [],
      baseline: null,
      impact: e.def.impact ?? false,
      category: e.def.category ?? null,
      value_number: null,
      samples: samplesDeadline(compileSamples(e.def.samples!, e.def.refs, e.def.egress)),
    };
  }

  /**
   * 证据基线（ADR 0153）：每张异常卡在同一实体上、按同样长度的窗口在事件之前的各个时段重新执行，判定写入 novelty。
   * 样本时段由 sampleOffsets 给出；窗口整体平移，锚点在窗口中的位置不变（长期事件的锚点早于窗口起点时取窗口起点）；
   * 参数与信号备选沿用事件窗口的。超出期限没有取完的样本不计入，样本不足时为 unknown。
   */
  private async baseline(
    abnormal: Array<{ p: Planned; r: Omit<EvidenceResult, 'ref'>; at: number }>,
    o: NoveltyOptions,
    ds: EvidenceDataSource,
    resolutions: Map<string, SignalResolution>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!abnormal.length) {
      return;
    }
    const limit = AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs)]);
    const notBefore = this.o.metricsRetentionMs ? Date.now() - this.o.metricsRetentionMs : -Infinity;
    const tasks = abnormal.flatMap((x, card) => {
      const from = Date.parse(x.r.window.from);
      const to = Date.parse(x.r.window.to);
      const at = Math.min(Math.max(x.at, from), to);
      return sampleOffsets(o, to - from)
        .filter((offset) => from - offset.ms >= notBefore)
        .map((offset) => ({ card, from, to, at, offset }));
    });
    const samples: NoveltySample[][] = abnormal.map(() => []);
    await pool(tasks, this.o.concurrency, limit, async (t) => {
      const x = abnormal[t.card]!;
      const shift = t.offset.ms;
      try {
        const r = await runCard({
          set: this.rt.set,
          card: x.p.card,
          entity: {
            cluster_id: x.p.entity.cluster_id,
            kind: x.p.entity.kind,
            namespace: x.p.entity.namespace,
            name: x.p.entity.name,
            node: x.p.entity.kind === 'Node' ? x.p.entity.name : null,
          },
          anchor: t.at - shift,
          now: t.to - shift,
          ds,
          engine: this.source.engine,
          resolutions,
          clock: { from: toIso(t.from - shift - LOOKBACK_MS), to: toIso(Date.now()) },
          locale: this.o.locale,
          timeoutMs: this.o.queryTimeoutMs,
          redact: redactSamples,
          window: { before: `${t.at - t.from}ms`, after: `${t.to - t.at}ms` },
          ...(x.p.params ? { params: x.p.params } : {}),
        });
        samples[t.card]!.push({
          offset: t.offset,
          window: r.window,
          verdict: r.verdict,
          value: r.value_number ?? null,
        });
      } catch (err) {
        // 渲染与判定的错误由运行时记在卡片里；这里只剩窗口为空等计划本身的问题，这个样本不计入
        logger.warn('证据基线的样本没有执行', {
          card: x.p.card,
          entity: entityKey(x.p.entity),
          offset_ms: shift,
          error: err,
        });
      }
    });
    const incomplete = limit.aborted;
    abnormal.forEach((x, i) => {
      const own = samples[i]!.sort((a, b) => a.offset.ms - b.offset.ms);
      x.r.novelty = decideNovelty(x.r, own, o, incomplete);
      this.metrics.evidenceNovelty.inc({ status: x.r.novelty.status });
    });
    if (incomplete) {
      logger.warn('证据基线在期限内没有取完', { cards: abnormal.length, samples: tasks.length });
    }
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

/**
 * 阶段 A 报告最多带的规则结论数（与契约 StageAReport.rule_conclusions 的 maxItems 一致）：研判中它们占用假设 h7–h9
 */
export const MAX_RULE_CONCLUSIONS = 3;

/**
 * 结论规则的求值输入（ADR 0178）：求值对象依次为根因候选（按排名）、根因、事件组件、成员告警的组件与卡所为的组件，去重；
 * 成员告警按事件成员顺序编号 alert:<n>（与阶段 A 时间线、研判证据簿相同），变更按事件顺序编号 change:<n>，
 * 关联分级取 Incident.change_links。
 */
export function conclusionInput(inc: Incident, alerts: readonly Alert[], run: EvidenceRun): ConclusionInput {
  const order = [
    ...inc.candidates.map((c) => c.component),
    inc.root.component,
    ...inc.components,
    ...alerts.map((a) => a.component),
    ...Object.values(run.cardComponents ?? {}),
  ].filter((k): k is string => typeof k === 'string' && k !== '');
  const byId = new Map(alerts.map((a) => [a.alert_id, a]));
  const members = inc.members.filter((m) => m.left_version === null);
  const grades = new Map((inc.change_links ?? []).map((l) => [l.change_id, l.grade]));
  return {
    components: [...new Set(order)].map((key) => ({ key, type: run.componentTypes?.[key] ?? null })),
    cards: run.cards.map((c) => ({
      ref: c.ref,
      card_id: c.card_id,
      component: run.cardComponents?.[c.ref] ?? null,
      verdict: c.verdict,
      routine: isRoutine(c),
      observations: c.observations,
    })),
    alerts: members.flatMap((m, i) => {
      const a = byId.get(m.alert_id);
      return a
        ? [
            {
              ref: `alert:${i + 1}`,
              alertname: a.alertname,
              labels: a.labels,
              role: a.classification.role,
              component: a.component,
            },
          ]
        : [];
    }),
    changes: inc.changes.map((c, k) => ({
      ref: `change:${k + 1}`,
      kind: c.kind,
      targets: [...c.targets, ...c.refs],
      grade: grades.get(c.change_id) ?? null,
    })),
  };
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
    // 同一张卡对多个实体执行时，以根因实体上的结果为准（根因的卡排在前面）。
    // 证据基线判为常态的异常卡按正常给出（ADR 0153），与修复模板的上下文相同
    for (const c of run.cards) {
      const routine = isRoutine(c);
      cards[c.card_id] ??= {
        verdict: routine ? 'normal' : c.verdict,
        display_state: routine ? 'normal' : c.display_state,
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

  /** 确定性结论规则（ADR 0178）：按根因候选的排名排列的命中，最多 MAX_RULE_CONCLUSIONS 条 */
  conclude(inc: Incident, alerts: Alert[], run: EvidenceRun): RuleConclusion[] {
    if (!this.rt.set.conclusions.length) {
      return [];
    }
    const hits = evaluateConclusions(this.rt.set.conclusions, conclusionInput(inc, alerts, run));
    for (const h of hits) {
      this.metrics.ruleConclusions.inc({ rule: h.rule.key });
    }
    return hits.slice(0, MAX_RULE_CONCLUSIONS).map((h) => {
      // 每个条件至少有一条满足它的证据，命中的规则必然有依据
      const [first, ...rest] = h.basis;
      if (first === undefined) {
        throw new Error(`结论规则 ${h.rule.key} 命中但没有依据`);
      }
      return {
        rule_id: h.rule.key,
        title: h.rule.title,
        root_component: h.root,
        mechanism: h.rule.mechanism,
        level: 'likely' as const,
        basis: [first, ...rest],
        card_conditions: h.rule.cards.map((c) => ({ ...c, observations: [...c.observations] })),
      };
    });
  }
}
