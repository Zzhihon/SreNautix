import type { Feedback, Hypothesis } from '@srenautix/contract';
import type { CardEntry, EvidenceBook } from './evidence.js';
import { checkDefinition, INCIDENT_SYMPTOM_RULES, targets, type Targeting, type TypeRule } from './targeting.js';
import type { Subgraph } from './types.js';

// 假设账本（DESIGN §7.3）：由代码维护，模型只提出假设与检查。状态：
// pending 待检验；supported 支持；refuted 推翻；inconclusive 检验后仍无法判定。
// 人工反馈固定的状态（pinned）不会被之后的证据改变。

export type LedgerStatus = Hypothesis['status'];

export const HYPOTHESIS_IDS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/** 归并阈值 τ（DESIGN §4.2）：置信度不低于它的边才把邻居算进假设的范围 */
export const SCOPE_TAU = 0.6;

/** 计入支持证据的成员告警角色（ADR 0122） */
const SUPPORTING_ROLES: ReadonlySet<string> = new Set(['cause', 'change', 'symptom']);

export interface LedgerEntry {
  id: string;
  /**
   * 假设所解释的对象（ADR 0146 §2.3）：事件研判为空串（全部假设解释同一个事件）；主动优化为发现的指纹，
   * 不同发现上的假设互不影响
   */
  group: string;
  parentId: string | null;
  rootComponent: string;
  mechanism: string;
  supporting: string[];
  refuting: string[];
  status: LedgerStatus;
  pinned: 'human_confirmed' | 'human_rejected' | null;
  /** 针对这个假设执行过、并且检验了它的机制的区分性检查数；测的信号与机制对不上的检查不算（ADR 0133） */
  checksRun: number;
  /** 针对这个假设执行过的检查产生的卡 */
  checkRefs: string[];
  /** 状态的依据，写入运行明细 */
  reasons: string[];
  /** 模型给出的排序位置（越小越靠前） */
  order: number;
}

export interface ModelHypothesis {
  id: string;
  parent_id: string | null;
  root_component: string;
  mechanism: string;
  supporting: string[];
  refuting: string[];
  /** 假设所解释的对象（LedgerEntry.group）；事件研判没有 */
  group?: string;
}

/**
 * 组件粒度（ADR 0121）：沿子图的 owned_by 向上取顶层属主，与阶段 A 的 componentOf 相同；
 * 例如 Pod → ReplicaSet → Deployment 取 Deployment，CNPG 实例 Pod 取 Cluster。子图中没有属主时就是它自己。
 */
export function ownerOf(key: string, subgraph: Subgraph): string {
  const parent = new Map<string, string>();
  for (const e of subgraph.edges) {
    if (e.relation === 'owned_by') {
      parent.set(e.from, e.to);
    }
  }
  let cur = key;
  const seen = new Set([cur]);
  for (let next = parent.get(cur); next !== undefined; next = parent.get(cur)) {
    if (seen.has(next)) {
      throw new Error(`owned_by 成环：${[...seen].join(' → ')} → ${next}`);
    }
    seen.add(next);
    cur = next;
  }
  return cur;
}

/** 组件本身加上沿 owned_by 向下的全部成员（例如 Deployment 的 ReplicaSet 与 Pod），与阶段 A 的 membersOf 相同 */
export function membersOf(root: string, subgraph: Subgraph): Set<string> {
  const out = new Set([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const e of subgraph.edges) {
      if (e.relation === 'owned_by' && e.to === queue[i] && e.confidence >= SCOPE_TAU && !out.has(e.from)) {
        out.add(e.from);
        queue.push(e.from);
      }
    }
  }
  return out;
}

/**
 * 假设的范围：根因组件本身，它直接依赖的对象（边 from=根因，置信度不低于 τ，例如挂载的 PVC、所在节点），
 * 以及沿 owned_by 向下它拥有的全部对象（例如 Deployment 的 ReplicaSet 与 Pod）。调用根因的上游
 * （边 to=根因 的其他关系）只会表现出症状，它们的异常卡不能证明根因。
 */
export function scopeOf(root: string, subgraph: Subgraph): Set<string> {
  const out = membersOf(root, subgraph);
  for (const e of subgraph.edges) {
    if (e.confidence >= SCOPE_TAU && e.from === root) {
      out.add(e.to);
    }
  }
  return out;
}

/**
 * 账本的结构参数（ADR 0146 §2.7）：组件粒度、假设的范围、竞争关系与症状类型规则。
 * 事件研判用 subgraphFrame（按研判子图；根因组件不同的假设互为竞争假设）；主动优化按发现分组，
 * 同一发现上的假设互为竞争假设，范围是发现的实体与它挂到的组件（optimize/）。
 */
export interface LedgerFrame {
  /** 组件粒度的根因（ADR 0121） */
  componentOf(key: string): string;
  /** 根因组件本身与它拥有的对象 */
  membersOf(root: string): Set<string>;
  /** 假设的范围：成员加上直接依赖的对象 */
  scopeOf(root: string): Set<string>;
  /** a 是否是 b 的竞争假设（a、b 不是同一个假设） */
  rivals(a: LedgerEntry, b: LedgerEntry): boolean;
  /** 检查与机制对应的症状类型规则（ADR 0133） */
  rules: readonly TypeRule[];
}

/** 事件研判的账本结构：按研判子图，根因组件不同的假设互为竞争假设（ADR 0121） */
export function subgraphFrame(subgraph: Subgraph): LedgerFrame {
  return {
    componentOf: (key) => ownerOf(key, subgraph),
    membersOf: (root) => membersOf(root, subgraph),
    scopeOf: (root) => scopeOf(root, subgraph),
    rivals: (a, b) => a.rootComponent !== b.rootComponent,
    rules: INCIDENT_SYMPTOM_RULES,
  };
}

function hasData(c: CardEntry): boolean {
  return c.result.verdict !== 'undeterminable';
}

export class Ledger {
  readonly entries = new Map<string, LedgerEntry>();
  private changes = 0;
  private readonly frame: LedgerFrame;

  /** 第二个参数是研判子图（事件研判，等同 subgraphFrame）或账本结构 */
  constructor(
    private readonly book: EvidenceBook,
    structure: Subgraph | LedgerFrame,
  ) {
    this.frame = 'rivals' in structure ? structure : subgraphFrame(structure);
  }

  get changeCount(): number {
    return this.changes;
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  /** 组件粒度的根因（ADR 0121） */
  componentOf(key: string): string {
    return this.frame.componentOf(key);
  }

  /** 状态签名：用于判断"连续两步判定都没有变化" */
  signature(): string {
    return this.ranked()
      .map((e) => `${e.id}:${e.status}`)
      .join(',');
  }

  private set(e: LedgerEntry, status: LedgerStatus, reason: string): void {
    if (e.pinned || e.status === status) {
      return;
    }
    e.status = status;
    e.reasons.push(reason);
    this.changes++;
  }

  /** 合并上一次研判的账本（增量研判）：保留假设与状态 */
  seed(previous: readonly Hypothesis[]): void {
    previous.forEach((h, i) => {
      this.entries.set(h.id, {
        id: h.id,
        group: '',
        parentId: h.parent_id,
        rootComponent: this.componentOf(h.root_component),
        mechanism: h.mechanism,
        supporting: [],
        refuting: [],
        status: h.status,
        pinned: null,
        checksRun: 0,
        checkRefs: [],
        reasons: [`沿用上一次研判的状态 ${h.status}`],
        order: i,
      });
    });
  }

  /**
   * 合并模型提出的假设：新 id 加入，已有 id 更新机制与引用，状态由代码重新评估。
   * 引用只保留本次运行中存在的；删除的引用写入 notes。
   */
  merge(hyps: readonly ModelHypothesis[], notes: string[]): void {
    hyps.forEach((h, i) => {
      const keep = (refs: string[], what: string) => {
        const ok = refs.filter((r) => this.book.has(r));
        const bad = refs.filter((r) => !this.book.has(r));
        if (bad.length) {
          notes.push(`假设 ${h.id} 的${what}引用不存在，已删除：${bad.join('、')}`);
        }
        return [...new Set(ok)];
      };
      // 组件粒度：由控制器拥有的对象改为顶层属主
      const root = this.componentOf(h.root_component);
      if (root !== h.root_component) {
        notes.push(`假设 ${h.id} 的根因 ${h.root_component} 由 ${root} 拥有，按组件粒度改为 ${root}`);
      }
      const group = h.group ?? '';
      const prev = this.entries.get(h.id);
      const kept = prev !== undefined && prev.rootComponent === root && prev.group === group ? prev : null;
      if (prev && !kept) {
        notes.push(
          prev.group === group
            ? `假设 ${h.id} 的根因组件由 ${prev.rootComponent} 改为 ${root}，按新假设重新检验`
            : `假设 ${h.id} 所解释的发现由 ${prev.group} 改为 ${group}，按新假设重新检验`,
        );
      }
      const entry: LedgerEntry = {
        id: h.id,
        group,
        parentId: h.parent_id && h.parent_id !== h.id ? h.parent_id : null,
        rootComponent: root,
        mechanism: h.mechanism,
        supporting: keep(h.supporting, '支持'),
        refuting: keep(h.refuting, '反驳'),
        status: kept ? kept.status : 'pending',
        pinned: kept ? kept.pinned : null,
        checksRun: kept ? kept.checksRun : 0,
        checkRefs: kept ? kept.checkRefs : [],
        reasons: kept ? kept.reasons : [],
        order: i,
      };
      this.entries.set(h.id, entry);
    });
    for (const e of this.entries.values()) {
      if (e.parentId && !this.entries.has(e.parentId)) {
        notes.push(`假设 ${e.id} 的父假设 ${e.parentId} 不存在，已置空`);
        e.parentId = null;
      }
    }
    // 父子关系必须是树：沿父链走回自身时，在回到自身的那一步断开
    for (const e of this.entries.values()) {
      const seen = new Set([e.id]);
      let cur = e;
      while (cur.parentId) {
        if (seen.has(cur.parentId)) {
          notes.push(`假设 ${cur.id} 的父假设 ${cur.parentId} 构成环，已置空`);
          cur.parentId = null;
          break;
        }
        seen.add(cur.parentId);
        cur = this.entries.get(cur.parentId) as LedgerEntry;
      }
    }
  }

  /**
   * 反馈作为输入（DESIGN §7.4）：确认的根因固定为支持，否定的结论固定为推翻。
   * 只采用已绑定账号的反馈，同一事件以最新的一条为准。
   */
  applyFeedback(feedback: readonly Feedback[], previousConclusion: string | null, notes: string[]): void {
    const latest = [...feedback]
      .filter((f) => f.linked && f.verdict !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) {
      return;
    }
    const previousRoot = previousConclusion === null ? null : this.componentOf(previousConclusion);
    // previousRoot：反馈所针对的那次研判给出的根因组件
    if (latest.verdict === 'rejected' && previousRoot) {
      for (const e of this.entries.values()) {
        if (e.rootComponent === previousRoot) {
          e.status = 'refuted';
          e.pinned = 'human_rejected';
          e.reasons.push(`人工反馈否定了以 ${previousRoot} 为根因的结论`);
          notes.push(`反馈：假设 ${e.id}（${previousRoot}）固定为推翻`);
        }
      }
    }
    const confirmedRoot =
      latest.verdict === 'confirmed'
        ? previousRoot
        : latest.root_component === null
          ? null
          : this.componentOf(latest.root_component);
    if (!confirmedRoot) {
      return;
    }
    let hit = [...this.entries.values()].find((e) => e.rootComponent === confirmedRoot);
    if (!hit) {
      const id = HYPOTHESIS_IDS.find((x) => !this.entries.has(x));
      if (!id) {
        notes.push(`反馈给出的根因 ${confirmedRoot} 不在账本中，账本已满，没有加入`);
        return;
      }
      hit = {
        id,
        group: '',
        parentId: null,
        rootComponent: confirmedRoot,
        mechanism: latest.mechanism ?? '',
        supporting: [],
        refuting: [],
        status: 'supported',
        pinned: 'human_confirmed',
        checksRun: 0,
        checkRefs: [],
        reasons: [],
        order: -1,
      };
      this.entries.set(id, hit);
    }
    hit.status = 'supported';
    hit.pinned = 'human_confirmed';
    hit.reasons.push(`人工反馈确认根因为 ${confirmedRoot}`);
    notes.push(`反馈：假设 ${hit.id}（${confirmedRoot}）固定为支持`);
  }

  /**
   * 能作为支持证据的卡：异常、实体在假设范围内。来源有三个：模型引用的卡、针对这个假设的检查卡、
   * 实体是根因组件本身或它拥有的对象的阶段 A 卡（代码自动关联，模型漏引也不影响判定，ADR 0121）。
   * 根因依赖的对象上的卡只在模型引用时计入：依赖异常同样可以说明依赖本身才是根因。
   */
  supportCards(e: LedgerEntry): CardEntry[] {
    const scope = this.frame.scopeOf(e.rootComponent);
    const members = this.frame.membersOf(e.rootComponent);
    const fromRefs = e.supporting.map((r) => this.book.card(r)).filter((c): c is CardEntry => c !== undefined);
    const fromChecks = this.book.allCards.filter((c) => c.hypothesisId === e.id);
    const ownCards = this.book.allCards.filter(
      (c) => c.hypothesisId === null && c.component !== null && members.has(c.component),
    );
    const all = new Map([...fromRefs, ...fromChecks, ...ownCards].map((c) => [c.ref, c]));
    return [...all.values()].filter(
      (c) => c.result.verdict === 'abnormal' && c.component !== null && scope.has(c.component),
    );
  }

  /**
   * 能作为支持证据的成员告警（ADR 0122）：角色是 cause、change 或 symptom 的告警是告警规则判定的异常，
   * 与异常卡同样按范围计入：实体是根因本身或它拥有的对象时自动计入，实体是根因依赖的对象时只在模型引用时计入。
   * meta（观测缺口）与 forecast（预测）不计入。
   */
  supportAlerts(e: LedgerEntry): string[] {
    const scope = this.frame.scopeOf(e.rootComponent);
    const members = this.frame.membersOf(e.rootComponent);
    return this.book.alertEntries
      .filter(
        ([ref, m]) =>
          SUPPORTING_ROLES.has(m.role) &&
          m.component !== null &&
          (members.has(m.component) || (e.supporting.includes(ref) && scope.has(m.component))),
      )
      .map(([ref]) => ref);
  }

  /** 支持证据的数量：异常卡与成员告警 */
  supportCount(e: LedgerEntry): number {
    return this.supportCards(e).length + this.supportAlerts(e).length;
  }

  /** 根因组件自身的阶段 A 卡都有数据且都正常（至少一张）：没有支持卡时据此推翻 */
  rootAllNormal(e: LedgerEntry): CardEntry[] {
    const own = this.book.allCards.filter((c) => c.hypothesisId === null && c.component === e.rootComponent);
    return own.length > 0 && own.every((c) => c.result.verdict === 'normal') ? own : [];
  }

  /** 支持卡测的卡片定义：阶段 A 卡取卡片定义，检查卡取检查测的定义（ADR 0133） */
  supportDefinitions(e: LedgerEntry): Set<string> {
    return new Set(this.supportCards(e).map((c) => (c.check !== null ? checkDefinition(c.check) : c.result.card_id)));
  }

  /**
   * 针对假设的检查卡与假设机制是否对应（ADR 0133）：检查测的信号属于机制预示的症状，或与支持卡是同一个卡片定义。
   * 由小模型对照 refutes_if 判定的工具结果、以及不知道执行了什么的卡视为对应
   */
  targeting(e: LedgerEntry, c: CardEntry): Targeting {
    if (c.judgedBy === 'model') {
      return { related: true, basis: '由小模型对照 refutes_if 判定' };
    }
    if (c.check === null) {
      return { related: true, basis: '检查未知' };
    }
    return targets(c.check, e.mechanism, this.supportDefinitions(e), this.frame.rules);
  }

  /** 针对假设、并且检验了它的机制的检查卡 */
  private relatedCheck(e: LedgerEntry, c: CardEntry): boolean {
    return c.hypothesisId === e.id && this.targeting(e, c).related;
  }

  /**
   * 推翻假设的检查卡（ADR 0133、0134）：针对它、判定为正常、实体在范围内（或未知）、测的信号属于它的机制。
   * 成员上的这类卡在假设有支持证据时不改变账本状态（ADR 0121），但结论阶梯据此把档位限制在 inconclusive
   */
  refutingChecks(e: LedgerEntry): CardEntry[] {
    const scope = this.frame.scopeOf(e.rootComponent);
    return this.book.allCards.filter(
      (c) =>
        c.result.verdict === 'normal' && (c.component === null || scope.has(c.component)) && this.relatedCheck(e, c),
    );
  }

  /**
   * 与假设机制相反的正常卡（evidence_consistent 的第 3 个条件）：范围内、有数据，并且是下列之一：
   * 与支持卡是同一个卡定义（同一信号）；针对这个假设、测的信号属于它的机制的检查给出的正常结果（ADR 0133）；
   * 模型明确引用为反驳证据的卡。
   */
  contraryCards(e: LedgerEntry): CardEntry[] {
    const scope = this.frame.scopeOf(e.rootComponent);
    const supportDefs = new Set(this.supportCards(e).map((c) => c.result.card_id));
    return this.book.allCards.filter(
      (c) =>
        c.result.verdict === 'normal' &&
        hasData(c) &&
        ((c.hypothesisId === e.id && (c.component === null || scope.has(c.component)) && this.relatedCheck(e, c)) ||
          (c.component !== null && scope.has(c.component) && supportDefs.has(c.result.card_id)) ||
          (e.refuting.includes(c.ref) && c.component !== null && scope.has(c.component))),
    );
  }

  /** 按证据重新评估全部未固定的假设 */
  evaluate(): void {
    for (const e of this.entries.values()) {
      // 机制可能在下一轮 hypothesize 中改写，检查与机制的对应关系每次重新判断
      e.checksRun = this.countChecks(e);
      if (e.pinned) {
        continue;
      }
      // 检查卡判定为正常时直接推翻假设的，只有实体是根因本身或它直接依赖的对象的卡，以及实体未知的卡（工具结果）；
      // 实体是根因拥有的某个成员（例如多副本中的一个 Pod）的正常卡只作为相反的正常卡，在没有支持证据时才推翻（ADR 0121）；
      // 测的信号不属于假设机制的检查卡记为无关，不推翻（ADR 0133）
      const scope = this.frame.scopeOf(e.rootComponent);
      const members = this.frame.membersOf(e.rootComponent);
      const checks = this.book.allCards.filter(
        (c) =>
          this.relatedCheck(e, c) &&
          (c.component === null ||
            c.component === e.rootComponent ||
            (scope.has(c.component) && !members.has(c.component))),
      );
      const checkRefuted = checks.some((c) => c.result.verdict === 'normal');
      const support = [...this.supportCards(e).map((c) => c.ref), ...this.supportAlerts(e)];
      const contrary = [...this.contraryCards(e), ...(support.length === 0 ? this.rootAllNormal(e) : [])];
      if (checkRefuted || (contrary.length > 0 && support.length === 0)) {
        this.set(e, 'refuted', `相反的正常卡：${[...new Set(contrary.map((c) => c.ref))].join('、')}`);
      } else if (support.length > 0) {
        this.set(e, 'supported', `支持证据：${support.join('、')}`);
      } else if (e.checksRun > 0) {
        this.set(e, 'inconclusive', '检验后仍无法判定');
      }
    }
  }

  /** 检验了假设机制的检查数：记录过的检查卡中与机制对应的 */
  private countChecks(e: LedgerEntry): number {
    return e.checkRefs.filter((ref) => {
      const c = this.book.card(ref);
      return c !== undefined && this.relatedCheck(e, c);
    }).length;
  }

  /**
   * 记录一项针对假设执行完成的检查（失败的检查不记录）。ref 是检查产生的卡；不给出时取这个假设最近一张没有记录过的检查卡。
   * 检查测的信号不属于假设机制时记为无关，不算检验过（ADR 0133），返回写入运行明细的说明
   */
  noteCheckRun(id: string, ref?: string): string | null {
    const e = this.entries.get(id);
    if (!e) {
      return null;
    }
    const card =
      ref !== undefined
        ? this.book.card(ref)
        : this.book.allCards.filter((c) => c.hypothesisId === id && !e.checkRefs.includes(c.ref)).at(-1);
    if (!card) {
      return null;
    }
    e.checkRefs.push(card.ref);
    e.checksRun = this.countChecks(e);
    const t = this.targeting(e, card);
    if (t.related) {
      return null;
    }
    const note = `检查 ${card.ref}（${card.check}）测的信号不属于假设 ${e.id} 的机制，记为无关，不计入推翻：${t.basis}`;
    e.reasons.push(note);
    return note;
  }

  /** 排名：支持 > 待检验 > 无法判定 > 推翻；同档按支持卡数、阶段 A 候选得分、模型给出的顺序 */
  ranked(candidateScore: (component: string) => number = () => 0): LedgerEntry[] {
    const rank: Record<LedgerStatus, number> = { supported: 0, pending: 1, inconclusive: 2, refuted: 3 };
    return this.list().sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        this.supportCount(b) - this.supportCount(a) ||
        candidateScore(b.rootComponent) - candidateScore(a.rootComponent) ||
        a.order - b.order,
    );
  }

  /**
   * 停止条件（DESIGN §7.3）：排名第一的假设有支持卡（只有成员告警支持的不算，ADR 0122），
   * 并且其余候选都已推翻或检验后仍无法判定
   */
  leaderSettled(leader: LedgerEntry | undefined): boolean {
    return (
      leader !== undefined &&
      leader.status === 'supported' &&
      this.supportCards(leader).length > 0 &&
      this.competitorsResolved(leader)
    );
  }

  /**
   * 竞争假设，按账本结构的 rivals 判断。事件研判为根因组件与 leader 不同的假设：同一组件上的多个假设（不同机制）
   * 都在解释同一个根因，它们之间不构成根因的竞争（ADR 0121）
   */
  competitors(leader: LedgerEntry): LedgerEntry[] {
    return this.list().filter((e) => e.id !== leader.id && this.frame.rivals(e, leader));
  }

  /** 账本结构的症状类型规则（控制器补选检查时与账本用同一套） */
  get rules(): readonly TypeRule[] {
    return this.frame.rules;
  }

  /** 竞争假设是否都已推翻或检验后无法判定 */
  competitorsResolved(leader: LedgerEntry): boolean {
    return this.competitors(leader).every(
      (e) => e.status === 'refuted' || (e.status === 'inconclusive' && e.checksRun > 0),
    );
  }

  /**
   * 是否检验过竞争假设并把它排除（ADR 0124）：至少一个竞争假设已推翻，或执行过检查后仍无法判定；
   * 并且没有任何竞争假设同样处于支持状态（检查结果同样支持竞争假设时，检查没有区分两者）
   */
  competitorTested(leader: LedgerEntry): boolean {
    const others = this.competitors(leader);
    return (
      others.some((e) => e.status === 'refuted' || (e.status === 'inconclusive' && e.checksRun > 0)) &&
      !others.some((e) => e.status === 'supported')
    );
  }

  /** 同样处于支持状态的竞争假设 */
  supportedCompetitors(leader: LedgerEntry): LedgerEntry[] {
    return this.competitors(leader).filter((e) => e.status === 'supported');
  }

  /**
   * 处于支持状态的根因组件（去重）。同一组件上的多个支持假设算一个，供模型弃权时的代选判断"唯一"（ADR 0120）
   */
  supportedRoots(): string[] {
    const roots = this.list()
      .filter((e) => e.status === 'supported')
      .map((e) => e.rootComponent);
    return [...new Set(roots)];
  }

  /**
   * 契约中的账本按排名排列，包含全部假设（ADR 0133）：被推翻的排在最后，不从排序中删除；评测的召回@3 按这个顺序计算
   */
  toContract(candidateScore?: (component: string) => number): Hypothesis[] {
    return this.ranked(candidateScore).map((e) => ({
      id: e.id,
      parent_id: e.parentId,
      root_component: e.rootComponent,
      mechanism: e.mechanism,
      supporting: [...new Set([...e.supporting, ...this.supportCards(e).map((c) => c.ref), ...this.supportAlerts(e)])],
      refuting: [...new Set([...e.refuting, ...this.contraryCards(e).map((c) => c.ref)])],
      status: e.status,
      status_reasons: e.reasons.map((r) => r.slice(0, 500)),
      checks_run: e.checksRun,
    }));
  }
}
