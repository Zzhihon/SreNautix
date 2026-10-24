import { membersOf as subgraphMembers, ownerOf, type LedgerEntry, type LedgerFrame } from '../research/ledger.js';
import type { Subgraph } from '../research/types.js';
import { OPTIMIZATION_SYMPTOM_RULES } from './symptoms.js';

// 优化账本的结构（ADR 0146 §2.3、§2.7）：账本按发现分组。假设的根因是发现的实体（逻辑实体如 pg_statement，
// 或 Kubernetes 对象），分组键 group 是发现的指纹：
// - 同一发现上的假设互为竞争假设，不同发现的假设互不影响；
// - 支持卡的范围是发现的实体与它挂到的组件（Kubernetes 对象另加它拥有的成员，例如 Deployment 的 Pod）；
// - 症状类型规则在事件研判的集合上增加优化的类型。
// 输出契约中的 root_component 由控制器换回实体挂到的组件。

export interface FrameFinding {
  fingerprint: string;
  /** 发现的实体键（EntityKey） */
  entity: string;
  /** 实体挂到的拓扑组件 */
  component: string;
}

export function findingFrame(findings: readonly FrameFinding[], subgraph: Subgraph | null): LedgerFrame {
  const byEntity = new Map(findings.map((f) => [f.entity, f]));
  const members = (root: string): Set<string> => {
    const f = byEntity.get(root);
    if (subgraph && (!f || f.entity === f.component)) {
      return subgraphMembers(root, subgraph);
    }
    return new Set([root]);
  };
  return {
    componentOf: (key) => (byEntity.has(key) || !subgraph ? key : ownerOf(key, subgraph)),
    membersOf: members,
    scopeOf: (root) => {
      const out = members(root);
      const f = byEntity.get(root);
      if (f) {
        out.add(f.component);
      }
      return out;
    },
    rivals: (a: LedgerEntry, b: LedgerEntry) => a.group === b.group,
    rules: OPTIMIZATION_SYMPTOM_RULES,
  };
}
