import type { Alert, EvidenceResult, Incident } from '@srenautix/contract';
import type { EvidenceRun, EvidenceRunner, RuleHit, RuleProposer } from './ports.js';

/**
 * 没有证据数据源时的阶段 A（测试与只验证接入的部署）：没有证据卡、没有规则提议、没有排除规则。
 * 阶段 A 仍给出收敛后的事件、根因候选、时间线与确定性的处置判断。
 */
export class NoPackEvidence implements EvidenceRunner {
  async run(_incident: Incident, _alerts: Alert[], _signal: AbortSignal): Promise<EvidenceRun> {
    return { cards: [], chains: [], runbooks: [], rootComponentType: null };
  }

  async rerun(
    _incident: Incident,
    _cards: EvidenceResult[],
    _windowTo: Date,
    _signal: AbortSignal,
  ): Promise<EvidenceResult[]> {
    return [];
  }
}

export class NoPackRules implements RuleProposer {
  evaluate(_incident: Incident, _alerts: Alert[], _run: EvidenceRun): RuleHit[] {
    return [];
  }

  excluded(_incident: Incident, _alerts: Alert[], _run: EvidenceRun): string | null {
    return null;
  }
}
