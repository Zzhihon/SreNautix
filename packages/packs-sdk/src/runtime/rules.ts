// 规则提议的求值（DESIGN §6.3 rules.yaml）。阶段 A 用它从卡片结果得出确定性的提议。
// when 与参数值都是 CEL，上下文为：
//   incident：{id, version, severity, labels, alerts: [{alertname, role, severity, labels}]}
//   root：根因实体 {cluster_id, kind, namespace, name, component_type}
//   cards：卡片全局 id → {verdict, display_state, value, reason_kind}

import type { PackSet } from '../pack/compile.js';

export interface RuleContext {
  incident: Record<string, unknown>;
  root: { cluster_id: string; kind: string; namespace: string; name: string; component_type: string };
  cards: Record<string, { verdict: string; display_state: string; value: string; reason_kind: string }>;
}

export interface RuleProposal {
  pack: string;
  rule_id: string;
  action: string;
  params: Record<string, unknown>;
  title: { 'zh-CN'?: string; en?: string };
}

export interface RuleEvaluation {
  proposals: RuleProposal[];
  /** 求值出错的规则；不产生提议，原因进入阶段 A 报告 */
  errors: Array<{ pack: string; rule_id: string; error: string }>;
}

function plain(v: unknown): unknown {
  return typeof v === 'bigint' ? Number(v) : v;
}

export function evaluateRules(set: PackSet, ctx: RuleContext): RuleEvaluation {
  const out: RuleEvaluation = { proposals: [], errors: [] };
  const env = { incident: ctx.incident, root: ctx.root, cards: ctx.cards };
  for (const r of set.rules) {
    try {
      const hit = r.when(env);
      if (typeof hit !== 'boolean') {
        throw new TypeError('when 的结果不是 bool');
      }
      if (!hit) {
        continue;
      }
      const params = Object.fromEntries(
        Object.entries(r.rule.params as Record<string, string>).map(([k, expr]) => [k, plain(r.params[k]!(env))]),
      );
      out.proposals.push({ pack: r.pack, rule_id: r.rule.id, action: r.rule.action, params, title: r.rule.title });
    } catch (err) {
      out.errors.push({ pack: r.pack, rule_id: r.rule.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
