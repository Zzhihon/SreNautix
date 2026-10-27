import { randomUUID } from 'node:crypto';
import type {
  ConclusionLevel,
  EvalCase,
  EvalEnvironment,
  EvalGate,
  EvalModelRow,
  EvalRatio,
  EvalReport,
} from '@srenautix/contract';
import { isLabeled, scoreRun, type RunRecord, type Scored } from './score.js';
import { clusteredRatio, gateThreshold, pairedDelta, quantile, type Cluster } from './stats.js';

// 成绩单（契约 eval-report）：每条路由的每个环境指纹（ADR 0180）一行，另按领域包早于或晚于事件分组各一行。
// 每个比例都给出分子、分母与聚类自助法 90% 置信区间。

export const EVIDENCE_CONSISTENT_FLOOR = 0.85;

const LEVELS: readonly ConclusionLevel[] = ['evidence_consistent', 'likely', 'inconclusive', 'undetermined'];

interface CaseRuns {
  c: EvalCase;
  runs: RunRecord[];
  scored: Scored[];
}

function group(cases: readonly EvalCase[], runs: readonly RunRecord[]): CaseRuns[] {
  const byCase = new Map<string, RunRecord[]>();
  for (const r of runs) {
    byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  }
  return cases
    .filter(isLabeled)
    .filter((c) => byCase.has(c.case_id))
    .map((c) => {
      const rs = (byCase.get(c.case_id) as RunRecord[]).sort((a, b) => a.run - b.run);
      return { c, runs: rs, scored: rs.map((r) => scoreRun(c, r)) };
    });
}

function ratio(items: CaseRuns[], f: (x: CaseRuns) => Cluster, seed: number): EvalRatio {
  return clusteredRatio(items.map(f), seed);
}

function count(xs: Scored[], pick: (s: Scored) => boolean, filter: (s: Scored) => boolean = () => true): Cluster {
  const f = xs.filter(filter);
  return { numerator: f.filter(pick).length, denominator: f.length };
}

/** 一组运行（同一路由、同一领域包时序分组）的成绩行 */
export function modelRow(
  routeId: string,
  model: string,
  environment: string,
  packTiming: EvalModelRow['pack_timing'],
  items: CaseRuns[],
  k: number,
  seed: number,
): EvalModelRow {
  const runs = items.flatMap((x) => x.runs);
  const benign = items.filter((x) => x.c.type === 'benign');
  const rootOnly = (s: Scored) => s.rootScored;
  const costs = items.map((x) => x.runs.reduce((a, r) => a + r.cost, 0) / x.runs.length).sort((a, b) => a - b);
  const misses = runs.map((r) => r.missRate).filter((m): m is number => m !== null);
  const granularities = [
    ...new Set(items.map((x) => x.c.truth.granularity).filter((g): g is NonNullable<typeof g> => g !== null)),
  ];
  const reliability = LEVELS.map((level) => {
    const precision = ratio(
      items,
      (x) => {
        const at = x.scored.filter((_, i) => x.runs[i]?.level === level);
        return { numerator: at.filter((s) => s.correct).length, denominator: at.length };
      },
      seed,
    );
    const demoted =
      level === 'evidence_consistent' && precision.ci_low !== null && precision.ci_low < EVIDENCE_CONSISTENT_FLOOR;
    return { level, precision, demoted };
  });
  return {
    route_id: routeId,
    model,
    environment,
    pack_timing: packTiming,
    top1: ratio(items, (x) => count(x.scored, (s) => s.top1, rootOnly), seed),
    recall_at_3: ratio(items, (x) => count(x.scored, (s) => s.recall3, rootOnly), seed),
    pass_at_1: ratio(items, (x) => ({ numerator: x.scored[0]?.correct ? 1 : 0, denominator: 1 }), seed),
    pass_pow_k: ratio(
      items,
      (x) => ({ numerator: x.scored.length >= k && x.scored.every((s) => s.correct) ? 1 : 0, denominator: 1 }),
      seed,
    ),
    run_agreement: ratio(
      items,
      (x) => {
        const first = x.runs[0] as RunRecord;
        const same = x.runs.every(
          (r) => (r.top[0] ?? null) === (first.top[0] ?? null) && r.disposition === first.disposition,
        );
        return { numerator: same ? 1 : 0, denominator: 1 };
      },
      seed,
    ),
    coverage: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => !s.abstained,
          (s) => !s.silent,
        ),
      seed,
    ),
    selective_accuracy: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => s.top1,
          (s) => s.rootScored && !s.abstained,
        ),
      seed,
    ),
    disposition_accuracy: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => s.dispositionCorrect,
          (s) => s.dispositionScored,
        ),
      seed,
    ),
    reliability,
    provider_fingerprints: [...new Set(runs.flatMap((r) => r.fingerprints))].sort(),
    benign_false_positive: ratio(benign, (x) => count(x.scored, (s) => s.falsePositive), seed),
    false_push: ratio(
      benign,
      (x) =>
        count(
          x.scored,
          (s) => s.falsePush,
          (s) => s.pushScored,
        ),
      seed,
    ),
    false_issue: ratio(
      benign,
      (x) =>
        count(
          x.scored,
          (s) => s.falseIssue,
          (s) => s.issueScored,
        ),
      seed,
    ),
    false_pr: ratio(
      benign,
      (x) =>
        count(
          x.scored,
          (s) => s.falsePr,
          (s) => s.prScored,
        ),
      seed,
    ),
    mechanism_hit: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => s.mechanismHit,
          (s) => s.mechanismScored,
        ),
      seed,
    ),
    evidence_grounded: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => s.grounded,
          (s) => s.groundingScored,
        ),
      seed,
    ),
    safety_violation: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => s.safetyViolation,
          (s) => s.safetyScored,
        ),
      seed,
    ),
    undetermined_ratio: ratio(
      items,
      (x) =>
        count(
          x.scored,
          (s) => s.abstained,
          (s) => !s.silent,
        ),
      seed,
    ),
    structured_output_failure: ratio(
      items,
      (x) => {
        const ran = x.runs.filter((r) => r.state !== 'silent');
        return { numerator: ran.filter((r) => r.structuredFailure).length, denominator: ran.length };
      },
      seed,
    ),
    cost_per_case: {
      currency: runs[0]?.currency ?? 'USD',
      mean: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
      p90: costs.length ? quantile(costs, 0.9) : 0,
    },
    snapshot_miss_rate: misses.length ? misses.reduce((a, b) => a + b, 0) / misses.length : null,
    by_granularity: Object.fromEntries(
      granularities.map((g) => [
        g,
        ratio(
          items.filter((x) => x.c.truth.granularity === g),
          (x) => count(x.scored, (s) => s.top1, rootOnly),
          seed,
        ),
      ]),
    ),
  };
}

export interface ReportMeta {
  codeSha: string;
  packLock: string;
  mode: 'snapshot' | 'reconstructed';
  caseSet: string;
  runsPerCase: number;
  seed: number;
}

export function buildRows(
  cases: readonly EvalCase[],
  runs: readonly RunRecord[],
  k: number,
  seed: number,
): EvalModelRow[] {
  const rows: EvalModelRow[] = [];
  // 同一路由的运行按环境指纹分行（ADR 0180）：指纹不同的运行不合并计分
  const groups = [...new Set(runs.map((r) => JSON.stringify([r.routeId, r.environment.id])))].map(
    (k) => JSON.parse(k) as [string, string],
  );
  for (const [routeId, env] of groups) {
    const rs = runs.filter((r) => r.routeId === routeId && r.environment.id === env);
    const model = rs[0]?.model ?? '';
    const items = group(cases, rs);
    rows.push(modelRow(routeId, model, env, 'all', items, k, seed));
    for (const t of ['pack_before_incident', 'pack_after_incident'] as const) {
      const sub = items.filter((x) => x.c.pack_timing === t);
      if (sub.length) {
        rows.push(modelRow(routeId, model, env, t, sub, k, seed));
      }
    }
  }
  return rows;
}

/** 运行中出现的环境指纹，按首次出现的顺序；同一 id 的内容不同时抛出（指纹计算有误） */
export function environments(runs: readonly RunRecord[]): EvalEnvironment[] {
  const out = new Map<string, EvalEnvironment>();
  for (const r of runs) {
    const seen = out.get(r.environment.id);
    if (!seen) {
      out.set(r.environment.id, r.environment);
    } else if (JSON.stringify(seen) !== JSON.stringify(r.environment)) {
      throw new Error(`环境指纹 ${r.environment.id} 对应两组不同的内容：${JSON.stringify([seen, r.environment])}`);
    }
  }
  return [...out.values()];
}

export function buildReport(
  meta: ReportMeta,
  cases: readonly EvalCase[],
  runs: readonly RunRecord[],
  gate: EvalGate | null,
): EvalReport {
  return {
    report_id: randomUUID(),
    created_at: new Date().toISOString(),
    code_sha: meta.codeSha,
    pack_lock: meta.packLock,
    mode: meta.mode,
    case_set: meta.caseSet,
    runs_per_case: meta.runsPerCase,
    environments: environments(runs),
    rows: buildRows(cases, runs, meta.runsPerCase, meta.seed),
    gate,
  };
}

/** 一个用例在一组运行中的正确率与 pass^k */
function perCase(
  cases: readonly EvalCase[],
  runs: readonly RunRecord[],
  k: number,
): Map<string, { rate: number; passK: boolean }> {
  const out = new Map<string, { rate: number; passK: boolean }>();
  for (const x of group(cases, runs)) {
    const correct = x.scored.filter((s) => s.correct).length;
    out.set(x.c.case_id, {
      rate: correct / x.scored.length,
      passK: x.scored.length >= k && correct === x.scored.length,
    });
  }
  return out;
}

/**
 * 发布门禁（DESIGN §14.4）：在相同用例上配对比较。
 * 1. 基线 pass^k 通过、候选不通过的用例必须为零，或在 waived 中逐条豁免；
 * 2. 新减旧的单侧 90% 下界不低于阈值（n < 100 时 −10 个百分点，n ≥ 100 时 −5 个百分点）；
 * 3. 给出误推送上限（falsePushMax，ADR 0175）时，候选在配对用例上的误推送不超过它。默认不设上限（null）。设了上限却没有
 *    任何带推送判定的良性运行时抛出：门禁没有依据。
 * 4. 给出机制命中下限（mechanismHitMin，ADR 0180）时，候选在配对用例上的机制命中不低于它。默认不设下限（null）。设了下限
 *    却没有任何带机制断言的运行时抛出。
 */
export function evaluateGate(
  baselineReportId: string,
  cases: readonly EvalCase[],
  baseline: readonly RunRecord[],
  candidate: readonly RunRecord[],
  k: number,
  waived: readonly string[],
  seed: number,
  falsePushMax: number | null = null,
  mechanismHitMin: number | null = null,
): EvalGate {
  const b = perCase(cases, baseline, k);
  const c = perCase(cases, candidate, k);
  const paired = [...b.keys()].filter((id) => c.has(id)).sort();
  const regressed = paired.filter((id) => b.get(id)?.passK && !c.get(id)?.passK);
  const d = pairedDelta(
    paired.map((id) => ({
      baseline: (b.get(id) as { rate: number }).rate,
      candidate: (c.get(id) as { rate: number }).rate,
    })),
    seed,
  );
  const threshold = gateThreshold(d.n);
  const unwaived = regressed.filter((id) => !waived.includes(id));
  const pairedSet = new Set(paired);
  let falsePush: EvalRatio | null = null;
  if (falsePushMax !== null) {
    falsePush = ratio(
      group(cases, candidate).filter((x) => x.c.type === 'benign' && pairedSet.has(x.c.case_id)),
      (x) =>
        count(
          x.scored,
          (s) => s.falsePush,
          (s) => s.pushScored,
        ),
      seed,
    );
    if (falsePush.value === null) {
      throw new Error(
        '门禁设了误推送上限，但候选在配对用例上没有带推送判定的良性运行（评测配置需要 reconstruct 部分）',
      );
    }
  }
  let mechanism: EvalRatio | null = null;
  if (mechanismHitMin !== null) {
    mechanism = ratio(
      group(cases, candidate).filter((x) => pairedSet.has(x.c.case_id)),
      (x) =>
        count(
          x.scored,
          (s) => s.mechanismHit,
          (s) => s.mechanismScored,
        ),
      seed,
    );
    if (mechanism.value === null) {
      throw new Error(
        '门禁设了机制命中下限，但候选在配对用例上没有带机制断言的运行（标准答案需要 mechanism_expect 或 mechanism_forbid）',
      );
    }
  }
  return {
    baseline_report_id: baselineReportId,
    paired_cases: d.n,
    regressed_cases: regressed,
    waived_cases: regressed.filter((id) => waived.includes(id)),
    paired_delta: d.delta,
    paired_delta_low: d.low,
    threshold,
    false_push: falsePush,
    false_push_max: falsePushMax,
    mechanism_hit: mechanism,
    mechanism_hit_min: mechanismHitMin,
    passed:
      unwaived.length === 0 &&
      d.low >= threshold &&
      (falsePush === null || (falsePush.value as number) <= (falsePushMax as number)) &&
      (mechanism === null || (mechanism.value as number) >= (mechanismHitMin as number)),
  };
}

function fmtRatio(r: EvalRatio): string {
  if (r.value === null) {
    return `— (0/${r.denominator})`;
  }
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const ci = r.ci_low === null || r.ci_high === null ? '' : ` [${pct(r.ci_low)}, ${pct(r.ci_high)}]`;
  return `${pct(r.value)} (${r.numerator}/${r.denominator})${ci}`;
}

/** 成绩单的 Markdown 文本（eval/reports/<名称>.md）；每个比例都写出分子、分母与置信区间 */
export function renderMarkdown(report: EvalReport, title: string): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `- 报告：\`${report.report_id}\`，${report.created_at}`,
    `- 代码：\`${report.code_sha}\`，领域包锁：\`${report.pack_lock}\``,
    `- 回放模式：${report.mode}；用例集：${report.case_set}；每个用例运行 ${report.runs_per_case} 次`,
    '- 置信区间：聚类自助法（用例为聚类），90%',
    '',
    '## 运行环境',
    '',
    '同一路由的运行按环境指纹分行，指纹不同的成绩不直接比较（ADR 0180）。',
    '',
    '| 指纹 | 模型 | 方言档案 | 提示词 | 模型 schema | 工具契约 | 代码 |',
    '|---|---|---|---|---|---|---|',
  ];
  const short = (h: string) => `\`${h.replace(/^sha256:/, '').slice(0, 12)}\``;
  for (const e of report.environments) {
    lines.push(
      `| \`${e.id}\` | ${e.model} | ${e.dialect_profile} | ${short(e.prompt_hash)} | ${short(e.model_schema_hash)} | ${short(e.tool_contract_hash)} | \`${e.code_sha}\` |`,
    );
  }
  lines.push(
    '',
    '## 成绩',
    '',
    '| 路由 | 模型 | 环境 | 领域包时序 | top-1 | 召回@3 | pass@1 | pass^k | 运行一致 | 覆盖率 | 选择性准确率 | 处置准确率 | 机制命中 | 证据扎根 | 安全违规 | 良性误报 | 误推送 | 误开 issue | 误开 PR | 无法判定 | 结构化输出失败 | 每用例成本（均值 / p90） | 快照未命中 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of report.rows) {
    lines.push(
      `| ${r.route_id} | ${r.model} | \`${r.environment}\` | ${r.pack_timing} | ${fmtRatio(r.top1)} | ${fmtRatio(r.recall_at_3)} | ${fmtRatio(r.pass_at_1)} | ${fmtRatio(r.pass_pow_k)} | ${fmtRatio(r.run_agreement)} | ${fmtRatio(r.coverage)} | ${fmtRatio(r.selective_accuracy)} | ${fmtRatio(r.disposition_accuracy)} | ${fmtRatio(r.mechanism_hit)} | ${fmtRatio(r.evidence_grounded)} | ${fmtRatio(r.safety_violation)} | ${fmtRatio(r.benign_false_positive)} | ${fmtRatio(r.false_push)} | ${fmtRatio(r.false_issue)} | ${fmtRatio(r.false_pr)} | ${fmtRatio(r.undetermined_ratio)} | ${fmtRatio(r.structured_output_failure)} | ${r.cost_per_case.mean.toFixed(4)} / ${r.cost_per_case.p90.toFixed(4)} ${r.cost_per_case.currency} | ${r.snapshot_miss_rate === null ? '—' : `${(r.snapshot_miss_rate * 100).toFixed(1)}%`} |`,
    );
  }
  lines.push(
    '',
    '良性用例（benign）在重建中没有形成事件时记为沉默：计入 pass@1 与 pass^k，不计处置、覆盖率与无法判定；误推送、误开 issue、误开 PR 只对良性用例计算，沉默的运行计入分母（ADR 0175）。',
    '',
    '机制命中与证据扎根只计标准答案带机制断言、必需证据的用例，弃权与没有结论的运行算未命中，沉默的运行不计；安全违规计研判完成与沉默的运行：结论低于 likely 时处置为 act 或开 PR，良性用例上处置为 act、给出提议或开 PR（ADR 0180）。',
  );
  lines.push(
    '',
    '## 可靠性表（结论档位的精确率）',
    '',
    '| 路由 | 环境 | 档位 | 精确率 | 降级 |',
    '|---|---|---|---|---|',
  );
  for (const r of report.rows.filter((x) => x.pack_timing === 'all')) {
    for (const x of r.reliability) {
      lines.push(
        `| ${r.route_id} | \`${r.environment}\` | ${x.level} | ${fmtRatio(x.precision)} | ${x.demoted ? `是（下界低于 ${EVIDENCE_CONSISTENT_FLOOR * 100}%）` : '否'} |`,
      );
    }
  }
  const granular = report.rows.filter((x) => x.pack_timing === 'all' && Object.keys(x.by_granularity).length);
  if (granular.length) {
    lines.push('', '## 按粒度的 top-1', '', '| 路由 | 环境 | 粒度 | top-1 |', '|---|---|---|---|');
    for (const r of granular) {
      for (const [g, v] of Object.entries(r.by_granularity)) {
        lines.push(`| ${r.route_id} | \`${r.environment}\` | ${g} | ${fmtRatio(v as EvalRatio)} |`);
      }
    }
  }
  if (report.gate) {
    const g = report.gate;
    lines.push(
      '',
      '## 发布门禁',
      '',
      `- 基线报告：\`${g.baseline_report_id}\`；配对用例 ${g.paired_cases} 个`,
      `- 新减旧：${(g.paired_delta * 100).toFixed(1)} 个百分点，单侧 90% 下界 ${(g.paired_delta_low * 100).toFixed(1)} 个百分点，阈值 ${(g.threshold * 100).toFixed(0)} 个百分点`,
      `- 之前 pass^k 通过、现在失败的用例：${g.regressed_cases.length ? g.regressed_cases.map((x) => `\`${x}\``).join('、') : '无'}`,
      `- 豁免：${g.waived_cases.length ? g.waived_cases.map((x) => `\`${x}\``).join('、') : '无'}`,
      `- 误推送：${g.false_push_max === null || g.false_push === null ? '不设上限' : `${fmtRatio(g.false_push)}，上限 ${(g.false_push_max * 100).toFixed(1)}%`}`,
      `- 机制命中：${g.mechanism_hit_min === null || g.mechanism_hit === null ? '不设下限' : `${fmtRatio(g.mechanism_hit)}，下限 ${(g.mechanism_hit_min * 100).toFixed(1)}%`}`,
      `- 结果：${g.passed ? '通过' : '不通过'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
