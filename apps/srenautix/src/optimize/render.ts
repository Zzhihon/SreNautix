import type {
  EvidenceResult,
  Finding,
  FindingConclusion,
  Goal,
  OptimizationBaseline,
  OptimizationRecommendation,
} from '@srenautix/contract';
import type { CodeLocation } from './code/locate.js';

// 业务 issue 与 ops PR 的正文（ADR 0146 §4.1、§4.2），全部是纯函数。每段前有 <!-- srenautix:issue=<段> --> 或
// <!-- srenautix:pr=<段> --> 标记；最后是发现与建议的标记，用于去重与找回（ADR 0095 第 3 条）。日志原文不进入正文，
// 只给出数值与链接；模型写的文字标注【模型】。

export type Lang = 'zh' | 'en';

export const findingMarker = (fp: string) => `<!-- srenautix:finding=${fp} -->`;
export const recommendationMarker = (id: string) => `<!-- srenautix:recommendation=${id} -->`;
export const goalMarker = (goalId: string, fp: string) => `<!-- srenautix:goal=${goalId} finding=${fp} -->`;

const T = {
  zh: {
    symptom: '现象',
    evidence: '证据',
    location: '定位',
    suggestion: '建议',
    gain: '预期收益',
    verify: '验证方法',
    run: '分析运行',
    conclusion: '结论',
    changes: '改了什么',
    plan: '验证计划',
    rollback: '回滚',
    model: '【模型】',
    indicator: '指标',
    baseline: '基线',
    objective: '目标',
    violation: '违反的小时占比',
    coverage: '覆盖率',
    window: '窗口',
    level: '结论档位',
    share: '份额',
    lower: '下界',
    expected: '期望值',
    basis: '计算依据',
    noLocation: '没有在业务代码中定位到这条语句（锚点没有命中）',
    verifyAfter: '修复部署之后，SreNautix 按“星期 × 小时”与基线比较，并在本 issue 评论验证结果。',
    verifyAfterPr: '合并并同步之后，SreNautix 按“星期 × 小时”与基线比较，并在本 PR 评论验证结果。',
    console: '控制台',
    goal: '目标',
    finding: '发现',
  },
  en: {
    symptom: 'Symptom',
    evidence: 'Evidence',
    location: 'Location',
    suggestion: 'Suggestion',
    gain: 'Expected gain',
    verify: 'Verification',
    run: 'Analysis run',
    conclusion: 'Conclusion',
    changes: 'What changed',
    plan: 'Verification plan',
    rollback: 'Rollback',
    model: '[model]',
    indicator: 'Indicator',
    baseline: 'Baseline',
    objective: 'Objective',
    violation: 'Hours violating the objective',
    coverage: 'Coverage',
    window: 'Window',
    level: 'Conclusion level',
    share: 'Share',
    lower: 'Lower bound',
    expected: 'Expected',
    basis: 'Basis',
    noLocation: 'The statement was not found in the business code (no anchor matched)',
    verifyAfter:
      'After the fix is deployed, SreNautix compares weekday x hour slots with the baseline and comments the result here.',
    verifyAfterPr:
      'After the merge is synced, SreNautix compares weekday x hour slots with the baseline and comments the result here.',
    console: 'Console',
    goal: 'Goal',
    finding: 'Finding',
  },
} as const;

const fmt = (v: number | null | undefined): string => {
  if (v === null || v === undefined) {
    return '—';
  }
  return Number.isInteger(v) ? String(v) : v.toPrecision(4);
};

const section = (kind: 'issue' | 'pr', key: string, title: string, body: string) =>
  `<!-- srenautix:${kind}=${key} -->\n## ${title}\n\n${body.trim()}\n`;

/** 现象段：指标、基线与目标（或领域门槛）、违反的小时比例、覆盖率、窗口 */
export function symptomLines(lang: Lang, goal: Goal, baseline: OptimizationBaseline): string {
  const t = T[lang];
  const o = goal.spec.objective;
  return baseline.indicators
    .map((b) => {
      const parts = [
        `**${t.indicator}** \`${b.indicator}\`（${b.entity}）`,
        `${t.baseline} ${b.statistic} = ${fmt(b.value)} ${b.unit}`,
        o ? `${t.objective} ${o.comparator} ${o.target}` : null,
        b.violation_ratio !== null ? `${t.violation} ${fmt(b.violation_ratio)}` : null,
        `${t.coverage} ${b.covered_hours}/${b.hours}`,
      ].filter(Boolean);
      return `- ${parts.join('，')}`;
    })
    .concat(`- ${t.window}：${baseline.window.from} — ${baseline.window.to}`)
    .join('\n');
}

/** 证据段：份额卡、支持卡与相反的卡，最多 6 张，只有数值与判定 */
export function evidenceLines(
  lang: Lang,
  conclusion: FindingConclusion,
  cards: readonly EvidenceResult[],
  consoleCard: (ref: string) => string,
): string {
  const t = T[lang];
  const pick = [...conclusion.share_refs, ...conclusion.support_refs, ...conclusion.contrary_refs];
  const seen = new Set<string>();
  const lines: string[] = [`- ${t.level}：\`${conclusion.level}\``];
  for (const ref of pick) {
    if (seen.has(ref) || seen.size >= 6) {
      continue;
    }
    seen.add(ref);
    const c = cards.find((x) => x.ref === ref);
    if (!c) {
      continue;
    }
    const title = (lang === 'zh' ? c.title['zh-CN'] : c.title.en) ?? c.title['zh-CN'] ?? c.card_id;
    lines.push(
      `- **${title}**（\`${c.card_id}\`）：${c.verdict}${c.value ? `，值 \`${c.value}\`` : ''}，${c.reason.text.slice(0, 200)}（[${t.console}](${consoleCard(ref)})）`,
    );
  }
  return lines.join('\n');
}

export function locationLines(lang: Lang, locations: readonly CodeLocation[]): string {
  if (!locations.length) {
    return T[lang].noLocation;
  }
  return locations
    .slice(0, 5)
    .map((l) => {
      const sym = l.symbol ? `\`${l.receiver ? `(${l.receiver}).` : ''}${l.symbol}\`` : '';
      return `- \`${l.path}:${l.start_line}-${l.end_line}\` ${sym}（${l.repository}@${l.commit.slice(0, 12)}，${l.anchor}/${l.match_kind}，${l.confidence}）`;
    })
    .join('\n');
}

export function gainLines(lang: Lang, rec: Pick<OptimizationRecommendation, 'estimate'>): string {
  const t = T[lang];
  const e = rec.estimate;
  return [
    `- ${t.lower}：${fmt(e.lower)} ${e.unit}（\`${e.indicator}\`）`,
    `- ${t.expected}：${fmt(e.expected)} ${e.unit}`,
    `- ${t.basis}：${e.basis}`,
  ].join('\n');
}

export interface IssueBodyInput {
  lang: Lang;
  goal: Goal;
  runId: string;
  finding: Finding;
  conclusion: FindingConclusion;
  baseline: OptimizationBaseline;
  cards: readonly EvidenceResult[];
  locations: readonly CodeLocation[];
  rec: OptimizationRecommendation;
  suggestion: string;
  verifySay: string;
  consoleUrl: string;
}

/** 业务 issue 的正文（§4.1） */
export function issueBody(i: IssueBodyInput, limit = 60_000): string {
  const t = T[i.lang];
  const goalUrl = `${i.consoleUrl}/optimization/goals/${i.goal.goal_id}`;
  const runUrl = `${goalUrl}/runs/${i.runId}`;
  const note = i.conclusion.note ? `\n\n${t.model} ${i.conclusion.note}` : '';
  const runLines = `- [${t.goal} ${i.goal.goal_id.slice(0, 8)}](${goalUrl})\n- [${i.runId}](${runUrl})`;
  const body = [
    section('issue', 'symptom', t.symptom, `${symptomLines(i.lang, i.goal, i.baseline)}\n- [${t.console}](${goalUrl})`),
    section(
      'issue',
      'evidence',
      t.evidence,
      evidenceLines(i.lang, i.conclusion, i.cards, (ref) => `${runUrl}?card=${encodeURIComponent(ref)}`),
    ),
    section('issue', 'location', t.location, locationLines(i.lang, i.locations)),
    section('issue', 'suggestion', t.suggestion, `${i.suggestion}${note}`),
    section('issue', 'gain', t.gain, gainLines(i.lang, i.rec)),
    section(
      'issue',
      'verify',
      t.verify,
      `- ${t.indicator}：\`${i.rec.verify.indicator}\`，${t.window} ${i.rec.verify.within}\n- ${i.verifySay}\n- ${t.verifyAfter}`,
    ),
    section('issue', 'run', t.run, runLines),
  ].join('\n');
  const tail = `\n${recommendationMarker(i.rec.recommendation_id)}\n${findingMarker(i.finding.fingerprint)}\n`;
  return body.length + tail.length > limit ? `${body.slice(0, limit - tail.length - 2)}…${tail}` : body + tail;
}

export interface PrBodyInput {
  lang: Lang;
  goal: Goal;
  runId: string;
  finding: Finding;
  conclusion: FindingConclusion;
  cards: readonly EvidenceResult[];
  rec: OptimizationRecommendation;
  change: string;
  files: readonly string[];
  verifySay: string;
  rollback: string;
  consoleUrl: string;
  /** 同一发现的业务 issue（owner/name#n）；没有时为 null */
  issueRef: string | null;
}

/** ops PR 的描述（§4.2），结构与 ADR 0108 相同，增加预期收益 */
export function goalPrBody(i: PrBodyInput, limit = 7600): string {
  const t = T[i.lang];
  const goalUrl = `${i.consoleUrl}/optimization/goals/${i.goal.goal_id}`;
  const runUrl = `${goalUrl}/runs/${i.runId}`;
  const body = [
    section(
      'pr',
      'conclusion',
      t.conclusion,
      [
        `- ${t.goal}：[${i.goal.goal_id.slice(0, 8)}](${goalUrl})`,
        `- ${t.finding}：\`${i.finding.kind}\` · ${i.finding.entity.display}（${i.finding.component}）`,
        `- ${t.level}：\`${i.conclusion.level}\`${i.finding.share !== null ? `，${t.share} ${fmt(i.finding.share)}` : ''}`,
        i.conclusion.note ? `- ${t.model} ${i.conclusion.note}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    section(
      'pr',
      'evidence',
      t.evidence,
      evidenceLines(i.lang, i.conclusion, i.cards, (ref) => `${runUrl}?card=${encodeURIComponent(ref)}`),
    ),
    section('pr', 'changes', t.changes, `${i.change}\n\n${i.files.map((f) => `- \`${f}\``).join('\n')}`),
    section('pr', 'gain', t.gain, gainLines(i.lang, i.rec)),
    section(
      'pr',
      'verify',
      t.plan,
      `- ${t.indicator}：\`${i.rec.verify.indicator}\`，${t.window} ${i.rec.verify.within}\n- ${i.verifySay}\n- ${t.verifyAfterPr}`,
    ),
    section('pr', 'rollback', t.rollback, i.rollback),
    section('pr', 'run', t.run, `- [${i.runId}](${runUrl})`),
  ].join('\n');
  const refs = i.issueRef ? `\nRefs ${i.issueRef}\n` : '';
  const tail = `${refs}\n${goalMarker(i.goal.goal_id, i.finding.fingerprint)}\n`;
  return body.length + tail.length > limit ? `${body.slice(0, limit - tail.length - 2)}…${tail}` : body + tail;
}

/** ops PR 的分支：srenautix/goal-<目标 id 前 8 位>-<模板>-<补丁摘要前 6 位> */
export function goalBranch(goalId: string, template: string, digest: string): string {
  const name = template.replace(/^.*\//, '').replace(/[^a-z0-9-]/g, '-');
  return `srenautix/goal-${goalId.slice(0, 8)}-${name}-${digest.slice(0, 6)}`;
}
