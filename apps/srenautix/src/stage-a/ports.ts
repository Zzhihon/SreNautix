import type { Alert, EvidenceResult, Incident, LocalizedText } from '@srenautix/contract';

/**
 * 阶段 A 依赖的两个执行器：证据卡（领域包的 CEL 判定，DESIGN §6.1）与规则提议（rules.yaml，§6.3）。
 * 两者都由领域包运行时（packages/packs-sdk）实现；server 只决定执行哪些卡、在什么窗口里执行。
 */
export interface EvidenceRunner {
  /**
   * 为事件执行证据链：根因候选（有歧义时前两个候选）与成员告警关联的证据链，以及沉默根因的探测卡。
   * 每张卡的结果编号 card:<n> 在本次运行内唯一。数据源固定并发、每卡 10 秒超时由运行时负责。
   */
  run(incident: Incident, alerts: Alert[], signal: AbortSignal): Promise<EvidenceResult[]>;
  /**
   * 控制台的"实时重跑"（DESIGN 附录 C）：只重跑这些已声明过的卡（card_id 与实体来自研判当时的结果），
   * 窗口终点为 windowTo，窗口长度沿用卡片定义。不提供任意查询。
   */
  rerun(incident: Incident, cards: EvidenceResult[], windowTo: Date, signal: AbortSignal): Promise<EvidenceResult[]>;
  /** 证据链对应的 runbook 引用 <pack>/<runbook 文件>#<锚点>。 */
  runbooks(incident: Incident): string[];
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
  evaluate(incident: Incident, cards: EvidenceResult[]): RuleHit[];
  /** 领域包的排除规则命中时返回规则 id（disposition=ignore）。 */
  excluded(incident: Incident, alerts: Alert[]): string | null;
}
