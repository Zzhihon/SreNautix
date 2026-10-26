import type { Alert, EvalCase, EvalSnapshot, EvidenceResult, Incident } from '@srenautix/contract';
import { logger } from '../log.js';
import type { ModelLayer } from '../llm/session.js';
import { ServerMetrics } from '../metrics.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../proposals/catalog.js';
import type { QueryRunner } from '../research/checks.js';
import type { WorkerMetrics } from '../research/metrics.js';
import type { Language } from '../prompts/index.js';
import { noveltyOptions } from '../config/novelty.js';
import { isRoutine } from '../stage-a/novelty.js';
import { PackEvidence, PackRules } from '../stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../stage-a/packs.js';
import {
  agreementRate,
  summarizeAgreement,
  type AgreementOutcome,
  type AgreementSummary,
  type AlertAgreement,
} from './agreement.js';
import { rootsAgree } from '../incident/research-root.js';
import { readBundle } from './bundle.js';
import type { ReconstructConfig } from './config.js';
import { discoveryCase, summarizeDiscovery, type DiscoveryCase, type DiscoverySummary } from './discovery.js';
import { labelCase, reconstructedSnapshotId, type Label, type LabelFile } from './labels.js';
import {
  bundleRootLookup,
  EVAL_REMEDIATION_CATEGORIES,
  faultAlertIds,
  mainIncident,
  reconstructCase,
  ReconstructedQueryRunner,
  replay,
} from './reconstruct.js';
import {
  alertFacts,
  matchTemplates,
  NO_EXTERNAL_ALERTS,
  remediationContext,
  remediationRoot,
  RootCardScope,
  type RootLookup,
} from '../remediation/facts.js';
import { templateRoot } from '../research/disposition.js';
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
  /** 证据基线判为常态的异常卡（ADR 0153） */
  routine: number;
}

/**
 * 标注的噪声信号（ADR 0153）：重建的阶段 A 中这张卡在每个实体上的结果（常态、明显异常、无法比较，或判为正常、
 * 无法判定、没有执行），以及研判运行中它出现在支持证据里的次数。验收：每个实体上都是常态，并且从不作为支持证据
 */
export interface NoiseCheck {
  label: string;
  card: string;
  /** 每个执行了这张卡的实体："<kind>:<namespace>/<name> <结果>"；没有执行时为空 */
  results: string[];
  routine: boolean;
  runs: number;
  supported_runs: number;
}

/** 一次研判的根因与发现（事件）根因按属主粒度不一致（ADR 0104 §14，incident/research-root.ts） */
export interface RootMismatch {
  case: string;
  route: string;
  run: number;
  incident_root: string;
  research_root: string;
  /** 研判根因是否在标注的分析根因集合内（研判纠正了发现，或偏离了正确的发现） */
  research_hit: boolean;
  incident_hit: boolean;
}

export interface RootComparison {
  /** 每条路由：比较过的运行（研判完成、给出根因且不弃权、事件有根因）与其中不一致的 */
  by_route: Record<string, { compared: number; mismatched: number }>;
  mismatches: RootMismatch[];
}

export interface Phase2Result {
  discovery: DiscoveryCase[];
  discoverySummary: DiscoverySummary;
  coverage: CardCoverage[];
  agreement: AgreementSummary;
  evalCases: EvalCase[];
  analysis: EvalOutcome | null;
  remediation: RemediationSummary | null;
  roots: RootComparison | null;
  noise: NoiseCheck[];
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
    /** 研判记录目录（每次运行一份，见 runner.ts） */
    traceDir: string | null;
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
  // 每个用例：分析时刻的事件根因与属主查找（研判根因与发现根因的比较用）
  const incidentRoots = new Map<string, { root: string | null; ownerOf: (key: string) => string | null }>();
  // 每个用例：修复模板匹配的输入（ADR 0138，只匹配、不推送）
  const matchInputs = new Map<string, MatchInput>();
  // 标注的噪声信号（ADR 0153）：用例 → 阶段 A 中的结果
  const noise = new Map<string, NoiseCheck[]>();
  for (const l of labels) {
    const b = readBundle(o.casesDir, l.id);
    const rep = await replay(
      b,
      Date.parse(l.window.to),
      {
        rt,
        params,
        revisionLabels: r.revision_labels,
        preStepLabels: r.pre_step_labels ?? [],
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
        routine: 0,
      });
      noise.set(`label:${l.id}`, noiseChecks(l, []));
      continue;
    }
    const asOf = Date.parse(l.as_of);
    const evidence = new PackEvidence(
      rt,
      source,
      async (_c, key) => rep.topology.componentType(key, asOf),
      {
        locale: r.locale,
        concurrency: r.evidence_concurrency,
        queryTimeoutMs: r.query_timeout_seconds * 1000,
        novelty: noveltyOptions(r.novelty),
      },
      serverMetrics,
    );
    const rc = await reconstructCase(rep, l, main.incident, sid, o.codeSha, packLock, {
      evidence,
      rules: new PackRules(rt, serverMetrics),
      rt,
      catalog,
      locale: r.locale,
      signal: AbortSignal.timeout(600_000),
      impactAlerts: r.business_impact_alerts,
    });
    const c = labelCase(o.labels, l, o.suite, sid, o.now);
    cases.push({ c, s: rc.snapshot });
    agreements.push(...rc.agreement);
    runners.set(
      c.case_id,
      new ReconstructedQueryRunner(evidence, rc.incident, rep.topology, asOf, rc.snapshot.context.alerts),
    );
    const topology = rep.topology;
    incidentRoots.set(c.case_id, {
      root: rc.incident.root.component,
      ownerOf: (key) => topology.ownerAt(key, asOf),
    });
    matchInputs.set(c.case_id, {
      incident: rc.incident,
      alerts: rc.snapshot.context.alerts as unknown as Alert[],
      cards: rc.snapshot.context.stage_a.cards,
      lookup: bundleRootLookup(topology, asOf, rt),
      at: asOf,
    });
    coverage.push({
      label: l.id,
      incident: rc.incident.label,
      root: rc.incident.root.component,
      root_type: rc.rootType,
      cards: rc.cards.total,
      determinate: rc.cards.determinate,
      abnormal: rc.cards.abnormal,
      root_abnormal: rc.cards.rootAbnormal,
      routine: rc.snapshot.context.stage_a.cards.filter((x) => isRoutine(x)).length,
    });
    noise.set(c.case_id, noiseChecks(l, rc.snapshot.context.stage_a.cards));
  }
  let analysis: EvalOutcome | null = null;
  let remediation: RemediationSummary | null = null;
  let roots: RootComparison | null = null;
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
          traceDir: a.traceDir,
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
    const templates = await runTemplates(analysis.runs, matchInputs, rt);
    remediation = scoreRemediation(
      analysis.runs,
      (id) => byCase.get(id) ?? null,
      a.repo,
      a.scratch,
      (r) => templates.get(r) ?? [],
    );
    roots = compareRoots(analysis.runs, incidentRoots, byCase);
    for (const [caseId, checks] of noise) {
      const runs = analysis.runs.filter((x) => x.caseId === caseId);
      for (const n of checks) {
        n.runs = runs.length;
        n.supported_runs = runs.filter((x) => (x.supportedCards ?? []).includes(n.card)).length;
      }
    }
  }
  return {
    discovery,
    discoverySummary: summarizeDiscovery(discovery),
    coverage,
    agreement: summarizeAgreement(agreements),
    evalCases: [...cases.map((x) => x.c), ...missing],
    analysis,
    remediation,
    roots,
    noise: [...noise.values()].flat(),
    packLock,
  };
}

interface MatchInput {
  incident: Incident;
  alerts: Alert[];
  cards: EvidenceResult[];
  lookup: RootLookup;
  at: number;
}

/**
 * 每次运行适用的修复模板（ADR 0138）：按运行的研判结论取模板使用的根因（likely 及以上取研判根因，否则取事件根因），
 * 以运行的处置与档位求值，与 server 的自愈 PR 相同；只匹配，不读仓库、不计划、不推送
 */
async function runTemplates(
  runs: readonly RunRecord[],
  inputs: ReadonlyMap<string, MatchInput>,
  rt: PackRuntime,
): Promise<Map<RunRecord, Array<{ key: string; category: string }>>> {
  const out = new Map<RunRecord, Array<{ key: string; category: string }>>();
  for (const r of runs) {
    const m = inputs.get(r.caseId);
    if (!m || r.level === null) {
      continue;
    }
    const key = templateRoot(r.level, r.root ?? null, m.incident.root.component);
    const root = key ? await remediationRoot(m.lookup, m.incident, m.alerts, key, new Date(m.at)) : null;
    const ctx = remediationContext(
      m.incident,
      m.alerts,
      m.cards,
      root,
      { disposition: r.disposition ?? 'undetermined', level: r.level },
      await new RootCardScope(m.lookup, m.incident, new Date(m.at)).cards(root, m.cards),
      // 评测没有部署的汇总配置：外部上游只按领域包声明的组件类型判断
      await alertFacts(m.lookup, m.incident, m.alerts, new Date(m.at), NO_EXTERNAL_ALERTS),
    );
    out.set(
      r,
      matchTemplates(rt.set, ctx).filter((t) => EVAL_REMEDIATION_CATEGORIES.includes(t.category)),
    );
  }
  return out;
}

const ABSTAIN_LEVELS = new Set(['inconclusive', 'undetermined']);

/**
 * 研判根因与发现根因（分析时刻主事件的根因）按属主粒度比较，与 server 的标记相同（incident/research-root.ts）：
 * 只比较研判完成、给出根因且不弃权、事件有根因的运行
 */
export function compareRoots(
  runs: readonly RunRecord[],
  incidents: ReadonlyMap<string, { root: string | null; ownerOf: (key: string) => string | null }>,
  labels: ReadonlyMap<string, Label>,
): RootComparison {
  const out: RootComparison = { by_route: {}, mismatches: [] };
  for (const r of runs) {
    const inc = incidents.get(r.caseId);
    const research = r.top[0];
    if (!inc?.root || !research || r.state !== 'completed' || r.level === null || ABSTAIN_LEVELS.has(r.level)) {
      continue;
    }
    const slot = (out.by_route[r.routeId] ??= { compared: 0, mismatched: 0 });
    slot.compared++;
    if (rootsAgree(research, inc.root, inc.ownerOf)) {
      continue;
    }
    slot.mismatched++;
    const truth = new Set(labels.get(r.caseId)?.roots ?? []);
    out.mismatches.push({
      case: r.caseId,
      route: r.routeId,
      run: r.run,
      incident_root: inc.root,
      research_root: research,
      research_hit: truth.has(research),
      incident_hit: truth.has(inc.root),
    });
  }
  return out;
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

const NOVELTY_TEXT: Record<string, string> = { routine: '常态', novel: '明显异常', unknown: '无法与基线比较' };

/** 标注的噪声信号在重建的阶段 A 中的结果（ADR 0153）；运行次数在研判之后填入 */
export function noiseChecks(l: Label, cards: readonly EvidenceResult[]): NoiseCheck[] {
  return l.noise.map(({ card }) => {
    const on = cards.filter((c) => c.card_id === card);
    const results = on.map((c) => {
      const what =
        c.verdict === 'abnormal'
          ? `异常，${c.novelty ? NOVELTY_TEXT[c.novelty.status] : '没有证据基线'}`
          : c.verdict === 'normal'
            ? '正常'
            : '无法判定';
      const e = c.entity;
      return `${e ? `${e.kind}:${e.namespace ? `${e.namespace}/` : ''}${e.name}` : '—'} ${what}`;
    });
    return {
      label: l.id,
      card,
      results,
      routine: on.length > 0 && on.every((c) => isRoutine(c)),
      runs: 0,
      supported_runs: 0,
    };
  });
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
    lines.push(
      '| 标注 | 主事件 | 根因 | 卡 | 得出结论 | 异常 | 其中常态 | 根因上的异常 |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const c of r.coverage) {
      lines.push(
        `| ${c.label} | ${c.incident ?? '没有事件'} | ${c.root ?? '—'} | ${c.cards} | ${c.determinate} | ${c.abnormal} | ${c.routine} | ${c.root_abnormal} |`,
      );
    }
  }
  if (r.noise.length) {
    lines.push('', '## 噪声信号（标注，ADR 0153）', '');
    lines.push('验收：每个实体上都判为常态，并且没有出现在任何假设的支持证据中。', '');
    lines.push('| 标注 | 卡 | 阶段 A 的结果 | 常态 | 作为支持证据的运行 |', '|---|---|---|---|---|');
    for (const n of r.noise) {
      lines.push(
        `| ${n.label} | ${n.card} | ${n.results.join('；') || '没有执行'} | ${n.routine ? '是' : '否'} | ${n.supported_runs}/${n.runs} |`,
      );
    }
  }
  if (r.coverage.length) {
    lines.push('', renderAgreement(r.agreement, '证据卡与告警结论一致率（as_of 时触发中的成员告警）'));
  }
  if (r.roots) {
    lines.push('', '## 研判根因与发现根因（按属主粒度）', '');
    lines.push('| 路由 | 比较的运行 | 不一致 |', '|---|---|---|');
    for (const [route, v] of Object.entries(r.roots.by_route)) {
      lines.push(`| ${route} | ${v.compared} | ${v.mismatched} |`);
    }
    if (r.roots.mismatches.length) {
      lines.push(
        '',
        '| 用例 | 路由 | 次序 | 事件根因 | 研判根因 | 事件根因命中 | 研判根因命中 |',
        '|---|---|---|---|---|---|---|',
      );
      for (const m of r.roots.mismatches) {
        lines.push(
          `| ${m.case} | ${m.route} | ${m.run} | ${m.incident_root} | ${m.research_root} | ${m.incident_hit ? '是' : '否'} | ${m.research_hit ? '是' : '否'} |`,
        );
      }
    }
  }
  if (r.remediation) {
    const m = r.remediation;
    lines.push('', '## 自愈 PR', '');
    lines.push('| 指标 | 值 |', '|---|---|');
    lines.push(`| PR 触发率（标注有仓库修复且结论 likely 及以上的运行） | ${pct(m.triggered_runs, m.eligible_runs)} |`);
    lines.push(`| 误触发（标注没有仓库修复却提议 gitops_pr） | ${m.false_triggers} |`);
    lines.push(`| 补丁可应用率（git apply --check） | ${pct(m.applicable, m.patches)} |`);
    lines.push(`| 补丁正确率（与标准修复的期望对比） | ${pct(m.correct, m.patches)} |`);
    if (m.template_triggered_runs !== undefined) {
      lines.push(
        `| PR 触发率（模板匹配：标注类别的修复模板适用，只匹配不推送） | ${pct(m.template_triggered_runs, m.eligible_runs)} |`,
      );
      lines.push(`| 任一修复模板适用（同一批运行） | ${pct(m.template_any_runs ?? 0, m.eligible_runs)} |`);
      const ft = Object.entries(m.template_false_triggers ?? {});
      lines.push(
        `| 误触发（模板匹配：标注没有仓库修复，按类别） | ${ft.length ? ft.map(([k, v]) => `${k} ${v}`).join('，') : '0'} |`,
      );
    }
    if (m.template_matches?.length) {
      lines.push('', '| 用例 | 路由 | 次序 | 档位 | 处置 | 适用的修复模板 |', '|---|---|---|---|---|---|');
      for (const t of m.template_matches) {
        lines.push(
          `| ${t.case} | ${t.route} | ${t.run} | ${t.level ?? '—'} | ${t.disposition ?? '—'} | ${t.templates.join('、') || '—'} |`,
        );
      }
    }
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
