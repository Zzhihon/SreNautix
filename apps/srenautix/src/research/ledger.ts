import type { Feedback, Hypothesis } from '@srenautix/contract';
import type { CardEntry, EvidenceBook } from './evidence.js';
import type { Subgraph } from './types.js';

// 假设账本（DESIGN §7.3）：由代码维护，模型只提出假设与检查。状态：
// pending 待检验；supported 支持；refuted 推翻；inconclusive 检验后仍无法判定。
// 人工反馈固定的状态（pinned）不会被之后的证据改变。

export type LedgerStatus = Hypothesis['status'];

export const HYPOTHESIS_IDS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/** 归并阈值 τ（DESIGN §4.2）：置信度不低于它的边才把邻居算进假设的范围 */
export const SCOPE_TAU = 0.6;

export interface LedgerEntry {
  id: string;
  parentId: string | null;
  rootComponent: string;
  mechanism: string;
  supporting: string[];
  refuting: string[];
  status: LedgerStatus;
  pinned: 'human_confirmed' | 'human_rejected' | null;
  /** 针对这个假设执行过的区分性检查（含失败的） */
  checksRun: number;
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
}

/**
 * 假设的范围：根因组件本身，它直接依赖的对象（边 from=根因，置信度不低于 τ，例如挂载的 PVC、所在节点），
 * 以及它拥有的对象（owned_by 指向根因，例如 Deployment 的 Pod）。调用根因的上游（边 to=根因 的其他关系）
 * 只会表现出症状，它们的异常卡不能证明根因。
 */
export function scopeOf(root: string, subgraph: Subgraph): Set<string> {
  const out = new Set([root]);
  for (const e of subgraph.edges) {
    if (e.confidence < SCOPE_TAU) {
      continue;
    }
    if (e.from === root) {
      out.add(e.to);
    } else if (e.to === root && e.relation === 'owned_by') {
      out.add(e.from);
    }
  }
  return out;
}

function hasData(c: CardEntry): boolean {
  return c.result.verdict !== 'undeterminable';
}

export class Ledger {
  readonly entries = new Map<string, LedgerEntry>();
  private changes = 0;

  constructor(
    private readonly book: EvidenceBook,
    private readonly subgraph: Subgraph,
  ) {}

  get changeCount(): number {
    return this.changes;
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()];
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
        parentId: h.parent_id,
        rootComponent: h.root_component,
        mechanism: h.mechanism,
        supporting: [],
        refuting: [],
        status: h.status,
        pinned: null,
        checksRun: 0,
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
      const prev = this.entries.get(h.id);
      if (prev && prev.rootComponent !== h.root_component) {
        notes.push(`假设 ${h.id} 的根因组件由 ${prev.rootComponent} 改为 ${h.root_component}，按新假设重新检验`);
      }
      const entry: LedgerEntry = {
        id: h.id,
        parentId: h.parent_id && h.parent_id !== h.id ? h.parent_id : null,
        rootComponent: h.root_component,
        mechanism: h.mechanism,
        supporting: keep(h.supporting, '支持'),
        refuting: keep(h.refuting, '反驳'),
        status: prev && prev.rootComponent === h.root_component ? prev.status : 'pending',
        pinned: prev && prev.rootComponent === h.root_component ? prev.pinned : null,
        checksRun: prev && prev.rootComponent === h.root_component ? prev.checksRun : 0,
        reasons: prev && prev.rootComponent === h.root_component ? prev.reasons : [],
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
  applyFeedback(feedback: readonly Feedback[], previousRoot: string | null, notes: string[]): void {
    const latest = [...feedback]
      .filter((f) => f.linked && f.verdict !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) {
      return;
    }
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
    const confirmedRoot = latest.verdict === 'confirmed' ? previousRoot : latest.root_component;
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
        parentId: null,
        rootComponent: confirmedRoot,
        mechanism: latest.mechanism ?? '',
        supporting: [],
        refuting: [],
        status: 'supported',
        pinned: 'human_confirmed',
        checksRun: 0,
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
   * 实体就是假设根因组件本身的阶段 A 卡（代码自动关联，模型漏引也不影响判定）。
   */
  supportCards(e: LedgerEntry): CardEntry[] {
    const scope = scopeOf(e.rootComponent, this.subgraph);
    const fromRefs = e.supporting.map((r) => this.book.card(r)).filter((c): c is CardEntry => c !== undefined);
    const fromChecks = this.book.allCards.filter((c) => c.hypothesisId === e.id);
    const ownCards = this.book.allCards.filter((c) => c.hypothesisId === null && c.component === e.rootComponent);
    const all = new Map([...fromRefs, ...fromChecks, ...ownCards].map((c) => [c.ref, c]));
    return [...all.values()].filter(
      (c) => c.result.verdict === 'abnormal' && c.component !== null && scope.has(c.component),
    );
  }

  /** 根因组件自身的阶段 A 卡都有数据且都正常（至少一张）：没有支持卡时据此推翻 */
  rootAllNormal(e: LedgerEntry): CardEntry[] {
    const own = this.book.allCards.filter((c) => c.hypothesisId === null && c.component === e.rootComponent);
    return own.length > 0 && own.every((c) => c.result.verdict === 'normal') ? own : [];
  }

  /**
   * 与假设机制相反的正常卡（evidence_consistent 的第 3 个条件）：范围内、有数据，并且是下列之一：
   * 与支持卡是同一个卡定义（同一信号）；针对这个假设的检查给出的正常结果；模型明确引用为反驳证据的卡。
   */
  contraryCards(e: LedgerEntry): CardEntry[] {
    const scope = scopeOf(e.rootComponent, this.subgraph);
    const supportDefs = new Set(this.supportCards(e).map((c) => c.result.card_id));
    return this.book.allCards.filter(
      (c) =>
        c.result.verdict === 'normal' &&
        hasData(c) &&
        (c.hypothesisId === e.id ||
          (c.component !== null && scope.has(c.component) && supportDefs.has(c.result.card_id)) ||
          (e.refuting.includes(c.ref) && c.component !== null && scope.has(c.component))),
    );
  }

  /** 按证据重新评估全部未固定的假设 */
  evaluate(): void {
    for (const e of this.entries.values()) {
      if (e.pinned) {
        continue;
      }
      const checks = this.book.allCards.filter((c) => c.hypothesisId === e.id);
      const checkRefuted = checks.some((c) => c.result.verdict === 'normal');
      const support = this.supportCards(e);
      const contrary = [...this.contraryCards(e), ...(support.length === 0 ? this.rootAllNormal(e) : [])];
      if (checkRefuted || (contrary.length > 0 && support.length === 0)) {
        this.set(e, 'refuted', `相反的正常卡：${[...new Set(contrary.map((c) => c.ref))].join('、')}`);
      } else if (support.length > 0) {
        this.set(e, 'supported', `支持卡：${support.map((c) => c.ref).join('、')}`);
      } else if (e.checksRun > 0) {
        this.set(e, 'inconclusive', '检验后仍无法判定');
      }
    }
  }

  noteCheckRun(id: string): void {
    const e = this.entries.get(id);
    if (e) {
      e.checksRun++;
    }
  }

  /** 排名：支持 > 待检验 > 无法判定 > 推翻；同档按支持卡数、阶段 A 候选得分、模型给出的顺序 */
  ranked(candidateScore: (component: string) => number = () => 0): LedgerEntry[] {
    const rank: Record<LedgerStatus, number> = { supported: 0, pending: 1, inconclusive: 2, refuted: 3 };
    return this.list().sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        this.supportCards(b).length - this.supportCards(a).length ||
        candidateScore(b.rootComponent) - candidateScore(a.rootComponent) ||
        a.order - b.order,
    );
  }

  /** 竞争假设（除 leader 外）是否都已推翻或检验后无法判定 */
  competitorsResolved(leader: LedgerEntry): boolean {
    return this.list()
      .filter((e) => e.id !== leader.id)
      .every((e) => e.status === 'refuted' || (e.status === 'inconclusive' && e.checksRun > 0));
  }

  /** 是否至少检验过一个竞争假设（有检查执行，或状态已由证据确定） */
  competitorTested(leader: LedgerEntry): boolean {
    return this.list().some((e) => e.id !== leader.id && (e.checksRun > 0 || e.status === 'refuted'));
  }

  toContract(): Hypothesis[] {
    return this.list()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        parent_id: e.parentId,
        root_component: e.rootComponent,
        mechanism: e.mechanism,
        supporting: [...new Set([...e.supporting, ...this.supportCards(e).map((c) => c.ref)])],
        refuting: [...new Set([...e.refuting, ...this.contraryCards(e).map((c) => c.ref)])],
        status: e.status,
      }));
  }
}
