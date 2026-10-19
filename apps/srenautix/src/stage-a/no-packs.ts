import type { Alert, EvidenceResult, Incident } from '@srenautix/contract';
import type { EvidenceRunner, RuleHit, RuleProposer } from './ports.js';

/**
 * 没有加载任何领域包时的阶段 A：没有证据卡、没有规则提议、没有排除规则。阶段 A 仍给出收敛后的事件、根因候选、
 * 时间线与确定性的处置判断；领域包运行时（packages/packs-sdk）加载后由它的实现替换。
 */
export class NoPackEvidence implements EvidenceRunner {
  async run(_incident: Incident, _alerts: Alert[], _signal: AbortSignal): Promise<EvidenceResult[]> {
    return [];
  }

  async rerun(
    _incident: Incident,
    _cards: EvidenceResult[],
    _windowTo: Date,
    _signal: AbortSignal,
  ): Promise<EvidenceResult[]> {
    return [];
  }

  runbooks(_incident: Incident): string[] {
    return [];
  }
}

export class NoPackRules implements RuleProposer {
  evaluate(_incident: Incident, _cards: EvidenceResult[]): RuleHit[] {
    return [];
  }

  excluded(_incident: Incident, _alerts: Alert[]): string | null {
    return null;
  }
}
