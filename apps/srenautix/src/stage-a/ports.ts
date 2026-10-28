import type { Alert, EvidenceResult, Incident, LocalizedText, RuleConclusion } from '@srenautix/contract';
import type { RequiredEvidence } from './required.js';

/** 一次证据链执行的结果。 */
export interface EvidenceRun {
  /** 每张卡的结果编号 card:<n> 在本次运行内唯一；根因的卡在前。 */
  cards: EvidenceResult[];
  /** 执行过的证据链全局键 <pack>/<chain id>（排除规则只在这些证据链上求值）。 */
  chains: string[];
  /** 执行过的证据链对应的 runbook 引用 <pack>/<runbook 文件>#<锚点>。 */
  runbooks: string[];
  /** 根因组件匹配到的组件类型（components.yaml）；没有根因或没有匹配时为 null。 */
  rootComponentType: string | null;
  /**
   * 组件的可读名称（契约 2.10.0 的 ComponentType.display_name，ADR 0101）：组件键 → 名称。只用于显示，
   * 求不出名称的组件不在其中；求值失败不影响证据卡。
   */
  names?: Record<string, string>;
  /** 成员告警的最低取证集合与缺口（ADR 0153）；没有声明 required_cards 的告警不在其中 */
  required?: RequiredEvidence[];
  /**
   * 卡（card:<n>）所为的组件：根因候选上的卡属于候选，告警实体上的卡属于告警归属的组件（ADR 0178）。结论规则的 self 条件
   * 按它判断；没有记录的卡只满足 incident 范围的条件
   */
  cardComponents?: Record<string, string>;
  /** 本次执行中求出了组件类型的组件：组件键 → 组件类型（结论规则按它筛选求值对象） */
  componentTypes?: Record<string, string>;
}

/**
 * 阶段 A 依赖的两个执行器：证据卡（领域包的 CEL 判定，DESIGN §6.1）与规则提议（rules.yaml，§6.3）。
 * 两者都由领域包运行时（packages/packs-sdk）实现；server 只决定执行哪些卡、在什么窗口里执行。
 */
export interface EvidenceRunner {
  /**
   * 为事件执行证据链：根因候选（有歧义时前两个候选）的组件类型与成员告警的告警目录条目声明的证据链。
   * 数据源固定并发、每张卡的查询超时由运行时负责；signal 中止后未完成的卡不出现在结果中。
   */
  run(incident: Incident, alerts: Alert[], signal: AbortSignal): Promise<EvidenceRun>;
  /**
   * 控制台的"实时重跑"（DESIGN 附录 C）：只重跑这些已声明过的卡（card_id 与实体来自研判当时的结果），
   * 窗口终点为 windowTo，窗口长度沿用卡片定义。不提供任意查询；领域包中已经没有的卡不出现在结果中。
   */
  rerun(incident: Incident, cards: EvidenceResult[], windowTo: Date, signal: AbortSignal): Promise<EvidenceResult[]>;
}

export interface RuleHit {
  pack: string;
  ruleId: string;
  action: string;
  params: Record<string, unknown>;
  title: LocalizedText;
  expectedEffect: LocalizedText | null;
}

export interface RuleProposer {
  /** 领域包的确定性规则（when 为 CEL，引用 incident、root、cards）；只能引用目录中已有的动作。 */
  evaluate(incident: Incident, alerts: Alert[], run: EvidenceRun): RuleHit[];
  /**
   * 执行过的证据链中，排除规则（chains.yaml 的 excludes）命中时返回规则的引用
   * `<pack>/<chain id>#excludes[<序号>]`（disposition=ignore）。
   */
  excluded(incident: Incident, alerts: Alert[], run: EvidenceRun): string | null;
  /**
   * 领域包的确定性结论规则（conclusions.yaml，ADR 0178）在事件涉及的每个组件上的命中，按根因候选的排名排列，最多
   * MAX_RULE_CONCLUSIONS 条。
   */
  conclude(incident: Incident, alerts: Alert[], run: EvidenceRun): RuleConclusion[];
}
