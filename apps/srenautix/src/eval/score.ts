import type { ConclusionLevel, Disposition, EvalCase, ResearchOutput } from '@srenautix/contract';
import type { RunAdmission } from '../remediation/admission.js';

// 单次运行的评分（DESIGN §14.4）：
// - 根因按集合判定：top-1 落在标准答案的根因集合内为命中；前 3 个候选覆盖集合中任一组件计入召回@3；
// - 处置判断与标准答案相同为正确；
// - "无法判定"（结论档位 inconclusive / undetermined）算弃权，用于覆盖率与选择性准确率；
// - benign 用例：处置为 ignore 且没有 evidence_consistent 为正确；abstain 用例：结论为弃权为正确。

/** 一个用例在一条路由上的一次运行 */
export interface RunRecord {
  caseId: string;
  run: number;
  routeId: string;
  model: string;
  /** completed：阶段 B 完成；stage_a_only / failed：没有模型结论 */
  state: 'completed' | 'stage_a_only' | 'failed';
  /** 结构化输出失败：模型输出无效、只出确定性报告 */
  structuredFailure: boolean;
  level: ConclusionLevel | null;
  disposition: Disposition | null;
  /** top-1 根因与排名前 3 的根因（按完整的账本排序，被推翻的假设在最后） */
  top: string[];
  cost: number;
  currency: string;
  inputTokens: number;
  outputTokens: number;
  /** 快照未命中率；reconstructed 模式为 null */
  missRate: number | null;
  fingerprints: string[];
  durationMs: number;
  error: string | null;
  /** 研判输出的提议草稿（动作与参数），自愈 PR 的度量用 */
  proposals: Array<{ action_id: string; params: Record<string, unknown> }>;
  /** 结论选中的研判根因（修复模板的匹配用，ADR 0138）；没有结论时为 null */
  root?: string | null;
  /** 输出账本中任一假设的支持证据里出现的卡片定义（标注的噪声信号按它判断，ADR 0153） */
  supportedCards?: string[];
  /** 自愈 PR 的运行级准入结果（ADR 0170，与 server 相同的规则）；没有研判输出时为 null */
  admission?: RunAdmission | null;
}

/** 研判输出中全部假设的支持证据对应的卡片定义（evidence_index 的 target 为 <卡片>@<组件>） */
export function supportedCards(out: ResearchOutput): string[] {
  const target = new Map((out.evidence_index ?? []).map((x) => [x.ref, x.target]));
  const cards = out.hypotheses
    .flatMap((h) => h.supporting)
    .filter((r) => r.startsWith('card:'))
    .map((r) => target.get(r)?.split('@')[0])
    .filter((x): x is string => x !== undefined);
  return [...new Set(cards)].sort();
}

export interface Scored {
  /** 有根因标准答案、计入 top-1 的运行 */
  rootScored: boolean;
  top1: boolean;
  recall3: boolean;
  abstained: boolean;
  dispositionScored: boolean;
  dispositionCorrect: boolean;
  /** benign / abstain 用例：出现 evidence_consistent 即为误报 */
  falsePositive: boolean;
  /** 用于 pass@1、pass^k 与配对比较的总体正确性 */
  correct: boolean;
}

const ABSTAIN: ReadonlySet<ConclusionLevel> = new Set(['inconclusive', 'undetermined']);

/**
 * 从研判输出取排名前 3 的根因组件：结论选中的在前，其余按完整的账本排序（支持、待检验、无法判定、推翻；同档保持输出中的
 * 账本顺序）。被推翻的假设排在最后，不从排序中删除（ADR 0133）
 */
export function topComponents(out: ResearchOutput): string[] {
  const rank: Record<string, number> = { supported: 0, pending: 1, inconclusive: 2, refuted: 3 };
  const chosen = out.conclusion.root_component;
  const others = out.hypotheses
    .filter((h) => h.root_component !== chosen)
    .sort((a, b) => (rank[a.status] as number) - (rank[b.status] as number))
    .map((h) => h.root_component);
  return [...new Set([...(chosen ? [chosen] : []), ...others])].slice(0, 3);
}

export function scoreRun(c: EvalCase, r: RunRecord): Scored {
  const roots = new Set(c.truth.root_components);
  const abstained = r.level === null || ABSTAIN.has(r.level);
  const top1 = !abstained && r.top[0] !== undefined && roots.has(r.top[0]);
  const recall3 = r.top.some((x) => roots.has(x));
  const rootScored = roots.size > 0 && (c.type === 'incident' || c.type === 'feedback' || c.type === 'scenario');
  const dispositionScored = c.truth.disposition !== null;
  const dispositionCorrect = dispositionScored && r.disposition === c.truth.disposition;
  const falsePositive = c.truth.forbid_evidence_consistent && r.level === 'evidence_consistent';
  let correct: boolean;
  switch (c.type) {
    case 'benign':
      correct = r.disposition === 'ignore' && !falsePositive;
      break;
    case 'abstain':
      correct = abstained;
      break;
    default:
      correct = top1;
  }
  return { rootScored, top1, recall3, abstained, dispositionScored, dispositionCorrect, falsePositive, correct };
}

/** 用例是否带有可评分的标准答案（只有标签、没有根因与处置判断的用例进入"稍后标注"队列） */
export function isLabeled(c: EvalCase): boolean {
  return (
    c.truth.root_components.length > 0 || c.truth.disposition !== null || c.type === 'benign' || c.type === 'abstain'
  );
}
