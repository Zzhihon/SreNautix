import type { ConclusionLevel, DomainGates, GateRecord, IndicatorUnit } from '@srenautix/contract';

// 建议的门槛（ADR 0146 §2.5）：按顺序经过 G1–G6，任何一道不通过都只记录原因码，写进目标报告，不创建 PR 或 issue。
// 门槛全部是确定性代码；输入由 server 从发现、模板求值结果与存储中的计数给出。

export type RecommendationKind = 'ops_pr' | 'business_issue';

export interface GateLimits {
  /** 每次运行最多通过的建议数 */
  perRun: number;
  /** 业务 issue：每个仓库每天 */
  issuesPerRepoPerDay: number;
  /** 优化类 ops PR：每小时、每周 */
  prsPerHour: number;
  prsPerWeek: number;
}

export const DEFAULT_GATE_LIMITS: GateLimits = { perRun: 2, issuesPerRepoPerDay: 3, prsPerHour: 1, prsPerWeek: 5 };

export const DEFAULT_GATES = {
  min_share: 0.2,
  min_gain_ratio: 0.1,
  min_gain_gap_ratio: 0.5,
} as const;

export interface GateInput {
  kind: RecommendationKind;
  domain: string;
  level: ConclusionLevel;
  share: number | null;
  gates: DomainGates;
  /** 模板 estimate 的求值（指标单位，按改善方向取正值）；求值失败时为 null */
  estimate: { lower: number; unit: IndicatorUnit } | null;
  /** 指标的当前统计值（基线）与差距 */
  current: number | null;
  gap: number | null;
  /** 模板 guard 的求值结果（G3），按模板中的顺序 */
  guards: ReadonlyArray<{ id: string; ok: boolean; say: string }>;
  novelty: {
    /** 同一发现已有 open、recommended、verifying 的建议 */
    active: boolean;
    /** 发现被拒绝后的冷却期内（且差距没有扩大 50% 以上） */
    coolingDown: boolean;
    /** 同一对象与参数 7 天内合并过 PR、验证还没有结束 */
    recentlyMerged: boolean;
  };
  counts: {
    /** 本次运行已经通过全部门槛的建议数 */
    thisRun: number;
    issuesToday: number;
    prsThisHour: number;
    prsThisWeek: number;
  };
  timing: {
    activeIncidentInScope: boolean;
    releaseInProgress: boolean;
    gatewayWriteAnomaly: boolean;
  };
  limits?: GateLimits;
}

export interface GateResult {
  passed: boolean;
  records: GateRecord[];
}

const RANK: Record<ConclusionLevel, number> = { undetermined: 0, inconclusive: 1, likely: 2, evidence_consistent: 3 };

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(4);
}

/** G2 的门槛：数据库等领域为指标当前值的 min_gain_ratio 与差距的 min_gain_gap_ratio 中较小者；compute 另有绝对下限 */
export function gainThreshold(i: GateInput): { threshold: number; basis: string } {
  const ratio = i.gates.min_gain_ratio ?? DEFAULT_GATES.min_gain_ratio;
  const gapRatio = i.gates.min_gain_gap_ratio ?? DEFAULT_GATES.min_gain_gap_ratio;
  const parts: Array<{ v: number; say: string }> = [];
  if (i.current !== null) {
    parts.push({ v: Math.abs(i.current) * ratio, say: `当前值的 ${ratio}` });
  }
  if (i.gap !== null && i.gap > 0) {
    parts.push({ v: i.gap * gapRatio, say: `差距的 ${gapRatio}` });
  }
  let threshold = parts.length ? Math.min(...parts.map((p) => p.v)) : 0;
  let basis = parts.length ? parts.map((p) => `${p.say} = ${fmt(p.v)}`).join('，') : '没有可比较的当前值与差距';
  const unit = i.estimate?.unit;
  if (unit === 'cores' && i.gates.min_cpu_cores !== undefined && i.gates.min_cpu_cores > threshold) {
    threshold = i.gates.min_cpu_cores;
    basis += `；每个工作负载至少 ${i.gates.min_cpu_cores} 核`;
  }
  if (unit === 'bytes' && i.gates.min_memory_bytes !== undefined && i.gates.min_memory_bytes > threshold) {
    threshold = i.gates.min_memory_bytes;
    basis += `；每个工作负载至少 ${i.gates.min_memory_bytes} 字节`;
  }
  return { threshold, basis };
}

export function evaluateGates(i: GateInput): GateResult {
  const limits = i.limits ?? DEFAULT_GATE_LIMITS;
  const records: GateRecord[] = [];
  const pass = (gate: GateRecord['gate'], detail: string) => records.push({ gate, passed: true, code: 'ok', detail });
  const fail = (gate: GateRecord['gate'], code: string, detail: string): GateResult => {
    records.push({ gate, passed: false, code, detail: detail.slice(0, 500) });
    return { passed: false, records };
  };

  // G1 证据档位
  const minShare = i.gates.min_share ?? DEFAULT_GATES.min_share;
  if (i.kind === 'ops_pr') {
    if (i.level !== 'evidence_consistent') {
      return fail('G1', 'level_too_low', `ops PR 要求 evidence_consistent，结论档位为 ${i.level}`);
    }
  } else {
    if (RANK[i.level] < RANK.likely) {
      return fail('G1', 'level_too_low', `业务 issue 要求 likely 及以上，结论档位为 ${i.level}`);
    }
    if (i.share === null || i.share < minShare) {
      return fail('G1', 'share_too_low', `业务 issue 要求份额不低于 ${minShare}，份额为 ${i.share ?? '未知'}`);
    }
  }
  pass('G1', `结论档位 ${i.level}${i.share !== null ? `，份额 ${fmt(i.share)}` : ''}`);

  // G2 预期收益
  if (!i.estimate) {
    return fail('G2', 'estimate_unavailable', '模板的预期收益无法从卡片的确定值求出');
  }
  const g = gainThreshold(i);
  if (!(i.estimate.lower >= g.threshold) || i.estimate.lower <= 0) {
    return fail(
      'G2',
      'gain_below_threshold',
      `预期收益下界 ${fmt(i.estimate.lower)} 低于门槛 ${fmt(g.threshold)}（${g.basis}）`,
    );
  }
  pass('G2', `预期收益下界 ${fmt(i.estimate.lower)}，门槛 ${fmt(g.threshold)}（${g.basis}）`);

  // G3 安全约束：模板 guard 全部成立；原因码为 guard 的 id
  const broken = i.guards.find((x) => !x.ok);
  if (broken) {
    return fail('G3', broken.id, broken.say);
  }
  pass('G3', i.guards.length ? `约束 ${i.guards.map((x) => x.id).join('、')} 全部成立` : '模板没有约束');

  // G4 新颖性
  if (i.novelty.active) {
    return fail('G4', 'duplicate_active', '同一发现已有未结束的建议');
  }
  if (i.novelty.coolingDown) {
    return fail('G4', 'cooldown', `发现被拒绝后的冷却期（${i.gates.cooldown ?? '30d'}）内，差距没有扩大 50% 以上`);
  }
  if (i.novelty.recentlyMerged) {
    return fail('G4', 'recently_merged', '同一对象与参数 7 天内合并过 PR，等它的验证结束');
  }
  pass('G4', '没有重复、冷却与最近合并的建议');

  // G5 数量
  if (i.counts.thisRun >= limits.perRun) {
    return fail('G5', 'run_limit', `每次运行最多 ${limits.perRun} 个建议`);
  }
  if (i.kind === 'business_issue' && i.counts.issuesToday >= limits.issuesPerRepoPerDay) {
    return fail('G5', 'daily_issue_limit', `业务仓库每天最多 ${limits.issuesPerRepoPerDay} 个 issue`);
  }
  if (i.kind === 'ops_pr' && i.counts.prsThisHour >= limits.prsPerHour) {
    return fail('G5', 'hourly_pr_limit', `优化类 ops PR 每小时最多 ${limits.prsPerHour} 个`);
  }
  if (i.kind === 'ops_pr' && i.counts.prsThisWeek >= limits.prsPerWeek) {
    return fail('G5', 'weekly_pr_limit', `优化类 ops PR 每周最多 ${limits.prsPerWeek} 个`);
  }
  pass('G5', '在每次运行、每天与每小时的数量上限之内');

  // G6 时机
  if (i.timing.activeIncidentInScope) {
    return fail('G6', 'active_incident', '范围内的组件有活动事件，推迟到下一轮');
  }
  if (i.timing.releaseInProgress) {
    return fail('G6', 'release_in_progress', '有进行中的发布，推迟到下一轮');
  }
  if (i.timing.gatewayWriteAnomaly) {
    return fail('G6', 'gateway_write_anomaly', 'gateway 有冻结之外的写入异常，推迟到下一轮');
  }
  pass('G6', '时机合适');
  return { passed: true, records };
}
