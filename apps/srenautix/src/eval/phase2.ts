import type { EvalCase, EvalSnapshot } from '@srenautix/contract';
import { logger } from '../log.js';
import type { ModelLayer } from '../llm/session.js';
import { ServerMetrics } from '../metrics.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../proposals/catalog.js';
import type { QueryRunner } from '../research/checks.js';
import type { WorkerMetrics } from '../research/metrics.js';
import type { Language } from '../prompts/index.js';
import { PackEvidence, PackRules } from '../stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../stage-a/packs.js';
import {
  agreementRate,
  summarizeAgreement,
  type AgreementOutcome,
  type AgreementSummary,
  type AlertAgreement,
} from './agreement.js';
import { readBundle } from './bundle.js';
import type { ReconstructConfig } from './config.js';
import { discoveryCase, summarizeDiscovery, type DiscoveryCase, type DiscoverySummary } from './discovery.js';
import { labelCase, reconstructedSnapshotId, type Label, type LabelFile } from './labels.js';
import { faultAlertIds, mainIncident, reconstructCase, ReconstructedQueryRunner, replay } from './reconstruct.js';
import { scoreRemediation, type RemediationSummary } from './remediation.js';
import { runEval, type EvalOutcome } from './runner.js';
import type { RunRecord } from './score.js';

// 第二阶段三个环节的重建评测（ADR 0110）：每条标注读取重建包，按步长重放得到发现指标；
// 在 as_of 为主事件重建阶段 A 与研判输入，逐条路由运行 k 次阶段 B 得到分析指标；研判输出的 gitops_pr 提议得到自愈 PR 指标。

export async function loadRuntime(r: ReconstructConfig): Promise<PackRuntime> {
  const rt = await PackRuntime.load({
    dirs: r.packs.dirs,
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
  });
  if (rt.failures.length) {
    throw new Error(`领域包加载失败：${JSON.stringify(rt.failures)}`);
  }
  return rt;
}

export interface CardCoverage {
  label: string;
  incident: string | null;
  root: string | null;
  root_type: string | null;
  cards: number;
  determinate: number;
  abnormal: number;
  root_abnormal: number;
}

export interface Phase2Result {
  discovery: DiscoveryCase[];
  discoverySummary: DiscoverySummary;
  coverage: CardCoverage[];
  agreement: AgreementSummary;
  evalCases: EvalCase[];
  analysis: EvalOutcome | null;
  remediation: RemediationSummary | null;
  packLock: string;
}

export interface Phase2Options {
  labels: LabelFile;
  only: readonly string[];
  casesDir: string;
  reconstruct: ReconstructConfig;
  suite: string;
  codeSha: string;
  /** null 时只做发现重放 */
  analysis: {
    layers: Array<{ routeId: string; layer: ModelLayer }>;
    runs: number;
    language: Language;
    metrics: WorkerMetrics;
    maxTokens: number;
    repo: string | null;
    scratch: string;
  } | null;
  now: string;
}

export async function runPhase2(o: Phase2Options): Promise<Phase2Result> {
  const r = o.reconstruct;
  const rt = await loadRuntime(r);
  const params = rt.rcaParams();
  const packLock = rt.set.lockDigest;
  const labels = o.labels.labels.filter((l) => !o.only.length || o.only.includes(l.id));
  if (!labels.length) {
    throw new Error(`标注文件中没有这些标注：${o.only.join(', ')}`);
  }
  const source = o.analysis
    ? await EvidenceSource.create({
        id: 'eval-metrics',
        url: r.metrics.url,
        dialect: r.metrics.dialect,
        bearerTokenFile: r.metrics.bearer_token_file ?? null,
        timeoutMs: r.query_timeout_seconds * 1000,
      })
    : null;
  const serverMetrics = new ServerMetrics('server', false);
  const catalog = Catalog.load();
  const discovery: DiscoveryCase[] = [];
  const coverage: CardCoverage[] = [];
  const agreements: AlertAgreement[] = [];
  const cases: Array<{ c: EvalCase; s: EvalSnapshot }> = [];
  const missing: EvalCase[] = [];
  const runners = new Map<string, QueryRunner>();
  for (const l of labels) {
    const b = readBundle(o.casesDir, l.id);
    const rep = await replay(
      b,
      Date.parse(l.window.to),
      {
        rt,
        params,
        revisionLabels: r.revision_labels,
        groupWithinMs: r.group_within_seconds * 1000,
        stepMs: r.step_seconds * 1000,
      },
      Date.parse(l.as_of),
    );
    const d = discoveryCase(rep, l);
    discovery.push(d);
    logger.info('发现重放完成', {
      label: l.id,
      steps: rep.steps,
      incidents: d.incidents,
      main_root: d.main_root,
      root_hit: d.root_hit,
      latency_s: d.detection_latency_s,
    });
    if (!o.analysis || !source) {
      continue;
    }
    const sid = reconstructedSnapshotId(l, o.codeSha);
    const main = mainIncident(rep, faultAlertIds(rep, l), 'captured');
    if (!main) {
      missing.push(labelCase(o.labels, l, o.suite, sid, o.now));
      coverage.push({
        label: l.id,
        incident: null,
        root: null,
        root_type: null,
        cards: 0,
        determinate: 0,
        abnormal: 0,
        root_abnormal: 0,
      });
      continue;
    }
    const asOf = Date.parse(l.as_of);
    const evidence = new PackEvidence(
      rt,
      source,
      async (_c, key) => rep.topology.componentType(key, asOf),
      { locale: r.locale, concurrency: r.evidence_concurrency, queryTimeoutMs: r.query_timeout_seconds * 1000 },
      serverMetrics,
    );
    const rc = await reconstructCase(rep, l, main.incident, sid, o.codeSha, packLock, {
      evidence,
      rules: new PackRules(rt, serverMetrics),
      rt,
      catalog,
      locale: r.locale,
      signal: AbortSignal.timeout(600_000),
    });
    const c = labelCase(o.labels, l, o.suite, sid, o.now);
    cases.push({ c, s: rc.snapshot });
    agreements.push(...rc.agreement);
    runners.set(c.case_id, new ReconstructedQueryRunner(evidence, rc.incident, rep.topology, asOf));
    coverage.push({
      label: l.id,
      incident: rc.incident.label,
      root: rc.incident.root.component,
      root_type: rc.rootType,
      cards: rc.cards.total,
      determinate: rc.cards.determinate,
      abnormal: rc.cards.abnormal,
      root_abnormal: rc.cards.rootAbnormal,
    });
  }
  let analysis: EvalOutcome | null = null;
  let remediation: RemediationSummary | null = null;
  if (o.analysis) {
    const a = o.analysis;
    analysis = cases.length
      ? await runEval({
          mode: 'reconstructed',
          cases,
          layers: a.layers,
          runs: a.runs,
          language: a.language,
          metrics: a.metrics,
          liveTools: [],
          query: null,
          queryFor: (id) => runners.get(id) ?? null,
          maxTokens: a.maxTokens,
          signal: new AbortController().signal,
        })
      : { runs: [], excluded: new Map(), tokens: 0, skipped: 0 };
    // 重建没有得到事件的标注：每条路由每次都记为失败（未命中）
    for (const c of missing) {
      for (const { routeId, layer } of a.layers) {
        for (let i = 0; i < a.runs; i++) {
          analysis.runs.push(failedRun(c.case_id, routeId, layer.route(routeId).route.model, i));
        }
      }
    }
    const byCase = new Map<string, Label>(labels.map((l) => [`label:${l.id}`, l]));
    remediation = scoreRemediation(analysis.runs, (id) => byCase.get(id) ?? null, a.repo, a.scratch);
  }
  return {
    discovery,
    discoverySummary: summarizeDiscovery(discovery),
    coverage,
    agreement: summarizeAgreement(agreements),
    evalCases: [...cases.map((x) => x.c), ...missing],
    analysis,
    remediation,
    packLock,
  };
}

function failedRun(caseId: string, routeId: string, model: string, run: number): RunRecord {
  return {
    caseId,
    run,
    routeId,
    model,
    state: 'failed',
    structuredFailure: false,
    level: null,
    disposition: null,
    top: [],
    cost: 0,
    currency: 'USD',
    inputTokens: 0,
    outputTokens: 0,
    missRate: null,
    fingerprints: [],
    durationMs: 0,
    error: 'reconstruct: 重建没有得到包含故障告警的事件',
    proposals: [],
  };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%（${n}/${d}）` : '—（0/0）');
const num = (x: number | null, digits = 1) => (x === null ? '—' : x.toFixed(digits));

const OUTCOMES: Array<[AgreementOutcome, string]> = [
  ['abnormal', '异常（一致）'],
  ['normal', '正常'],
  ['undeterminable', '无法判定'],
  ['no_card', '没有卡'],
  ['undeclared', '未声明主卡'],
  ['uncatalogued', '不在目录'],
  ['no_entity', '没有实体'],
];

export function renderAgreement(a: AgreementSummary, title: string): string {
  const p = agreementRate(a.primary);
  const c = agreementRate(a.chain);
  const lines = [`## ${title}`, '', `主卡一致率 ${pct(p.n, p.d)}；链级一致率 ${pct(c.n, c.d)}。`, ''];
  lines.push('| 卡的结果 | 主卡 | 链级 |', '|---|---|---|');
  for (const [k, name] of OUTCOMES) {
    lines.push(`| ${name} | ${a.primary[k]} | ${a.chain[k]} |`);
  }
  if (a.primary_disagreements.length) {
    lines.push('', '| 告警 | 主卡 | 主卡结果 | 次数 |', '|---|---|---|---|');
    for (const d of a.primary_disagreements) {
      lines.push(`| ${d.alertname} | ${d.primary_card} | ${OUTCOMES.find(([k]) => k === d.outcome)![1]} | ${d.n} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderPhase2Markdown(r: Phase2Result): string {
  const s = r.discoverySummary;
  const lines: string[] = [];
  lines.push('## 发现（重建重放）', '');
  lines.push('| 指标 | 值 |', '|---|---|');
  lines.push(`| 故障数 | ${s.faults} |`);
  lines.push(
    `| 每次故障的事件数（平均 / 最多） | ${num(s.incidents_per_fault_mean, 2)} / ${s.incidents_per_fault_max ?? '—'} |`,
  );
  lines.push(`| 根因命中率 | ${pct(s.root_hit.n, s.root_hit.d)} |`);
  lines.push(`| unlabelled 占比（窗口内新建的事件） | ${pct(s.unlabelled.n, s.unlabelled.d)} |`);
  lines.push(`| 检测延迟 p50 / p95（秒） | ${num(s.latency_p50_s)} / ${num(s.latency_p95_s)} |`);
  lines.push(`| 通过（事件数 ≤ 2、根因、成员、变更） | ${pct(s.passed.n, s.passed.d)} |`, '');
  lines.push(
    '| 标注 | 故障告警 | 事件数 | 主事件根因 | 根因命中 | 缺少的成员 | 变更 | 检测延迟（秒） | 窗口事件 / unlabelled |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const d of r.discovery) {
    lines.push(
      `| ${d.label} | ${d.fault_alerts} | ${d.incidents} | ${d.main_root ?? '—'} | ${d.root_hit === null ? '—' : d.root_hit ? '是' : '否'} | ${
        d.missing_members.map((x) => x.join(' 或 ')).join('；') || '—'
      } | ${d.change_found === null ? '—' : d.change_found ? '有' : '无'} | ${num(d.detection_latency_s, 0)} | ${d.window_incidents} / ${d.window_unlabelled} |`,
    );
  }
  if (r.coverage.length) {
    const withCards = r.coverage.filter((c) => c.cards > 0).length;
    lines.push('', '## 分析：证据卡覆盖（重建的阶段 A）', '');
    lines.push(`有证据卡的事件：${pct(withCards, r.coverage.length)}。`, '');
    lines.push('| 标注 | 主事件 | 根因 | 卡 | 得出结论 | 异常 | 根因上的异常 |', '|---|---|---|---|---|---|---|');
    for (const c of r.coverage) {
      lines.push(
        `| ${c.label} | ${c.incident ?? '没有事件'} | ${c.root ?? '—'} | ${c.cards} | ${c.determinate} | ${c.abnormal} | ${c.root_abnormal} |`,
      );
    }
  }
  if (r.coverage.length) {
    lines.push('', renderAgreement(r.agreement, '证据卡与告警结论一致率（as_of 时触发中的成员告警）'));
  }
  if (r.remediation) {
    const m = r.remediation;
    lines.push('', '## 自愈 PR', '');
    lines.push('| 指标 | 值 |', '|---|---|');
    lines.push(`| PR 触发率（标注有仓库修复且结论 likely 及以上的运行） | ${pct(m.triggered_runs, m.eligible_runs)} |`);
    lines.push(`| 误触发（标注没有仓库修复却提议 gitops_pr） | ${m.false_triggers} |`);
    lines.push(`| 补丁可应用率（git apply --check） | ${pct(m.applicable, m.patches)} |`);
    lines.push(`| 补丁正确率（与标准修复的期望对比） | ${pct(m.correct, m.patches)} |`);
    if (m.checks.length) {
      lines.push('', '| 用例 | 路由 | 次序 | base | 可应用 | 正确 | 说明 |', '|---|---|---|---|---|---|---|');
      for (const c of m.checks) {
        lines.push(
          `| ${c.case} | ${c.route} | ${c.run} | ${c.base?.slice(0, 12) ?? '—'} | ${c.applies ? '是' : '否'} | ${c.correct ? '是' : '否'} | ${c.detail} |`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
