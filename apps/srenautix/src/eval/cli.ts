import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { EvalCase, EvalSnapshot } from '@srenautix/contract';
import { logger } from '../log.js';
import { Egress } from '../llm/egress.js';
import { buildRuntimes } from '../llm/routes.js';
import { ModelLayer } from '../llm/session.js';
import { WorkerMetrics } from '../research/metrics.js';
import type { Tool } from '../tools/box.js';
import { openMcp, type McpSession } from '../tools/mcp.js';
import { exportBundle, loadStateDbConfig, readOnlyClient, writeBundle } from './bundle.js';
import { loadEvalConfig, loadReconstructConfig, type EvalConfig } from './config.js';
import { summarizeAgreement, type AgreementSummary } from './agreement.js';
import { liveAgreement, liveStats } from './discovery.js';
import { importSeed } from './import-seed.js';
import { loadLabels, relabelLegacy } from './labels.js';
import { loadRuntime, renderAgreement, renderPhase2Markdown, runPhase2 } from './phase2.js';
import { liveRemediation } from './remediation.js';
import { deriveAbstain } from './leakage.js';
import { buildReport, evaluateGate, renderMarkdown } from './report.js';
import { runEval, type EvalOutcome } from './runner.js';
import { stableUuid } from './import-seed.js';
import { CaseStore } from './store.js';

// srenautix eval 命令：
//   eval --cases <目录> --config <配置> [--suite <名>] [--runs 3] [--mode snapshot|reconstructed]
//        [--abstain] [--max-tokens N] [--out eval/reports] [--name <报告名>] [--trace <研判记录目录>]
//     每条路由单独评测，输出成绩单（Markdown 与 JSON）和每次运行的记录。
//   eval --compare <当前配置> <候选配置> --cases <目录> [同上] [--waive <case_id>]...
//     两份配置在相同用例上各评测一次，按各自的第一条路由做配对比较，给出发布门禁结果。
//   eval import-seed --dir <种子目录> --cases <目录> --suite <名> --cluster-id <id>
//     导入旧版 Ops-Agent 回放种子。
//   eval export | label | reconstruct | live
//     第二阶段的标注、重建包与三个环节的度量（ADR 0110，见各函数前的说明）。

export interface CliResult {
  reportPath: string | null;
  gatePassed: boolean | null;
}

function codeSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function layers(cfg: EvalConfig, metrics: WorkerMetrics) {
  // 命中蜜标后出站停止，之后每次研判都以 egress_blocked 结束，成绩单中表现为结构化失败之外的 stage_a_only
  const egress = new Egress({ allowCrossBorder: cfg.allowCrossBorder, honeytokens: cfg.honeytokens }, (reason) => {
    logger.error('评测出站命中蜜标，停止全部出站', { reason });
  });
  return cfg.routes.map((r) => {
    const runtimes = buildRuntimes(
      [
        {
          // 故障域描述研判时刻路由对事件所在组件的依赖（事件涉及故障域时提前熔断）；回放的是历史事件，
          // 路由此刻的健康与它无关，评测不按故障域熔断（ADR 0110）
          route: { ...r.route, failure_domain: [] },
          apiKey: r.apiKey,
          state: { profile: null, calibration: null, fingerprint: null },
          timeouts: r.timeouts,
        },
      ],
      egress,
    );
    if (r.contextTokens !== null) {
      for (const rt of runtimes) {
        rt.profile = { ...rt.profile, context_tokens: r.contextTokens };
      }
    }
    const layer = new ModelLayer({
      routes: runtimes,
      egress,
      budget: cfg.budget,
      metrics,
      language: cfg.language,
      onCalibration: async () => undefined,
      onDrift: async () => undefined,
    });
    return { routeId: r.route.id, layer };
  });
}

export async function runEvalCli(argv: string[]): Promise<CliResult> {
  switch (argv[0]) {
    case 'export':
      return exportCli(argv.slice(1));
    case 'label':
      return labelCli(argv.slice(1));
    case 'reconstruct':
      return reconstructCli(argv.slice(1));
    case 'live':
      return liveCli(argv.slice(1));
  }
  if (argv[0] === 'import-seed') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        dir: { type: 'string' },
        cases: { type: 'string' },
        suite: { type: 'string' },
        'cluster-id': { type: 'string' },
      },
    });
    if (!values.dir || !values.cases || !values.suite || !values['cluster-id']) {
      throw new Error('用法：eval import-seed --dir <种子目录> --cases <用例目录> --suite <名> --cluster-id <id>');
    }
    const s = await importSeed({
      dir: values.dir,
      suite: values.suite,
      clusterId: values['cluster-id'],
      store: new CaseStore(values.cases),
    });
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return { reportPath: null, gatePassed: null };
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cases: { type: 'string' },
      config: { type: 'string' },
      compare: { type: 'boolean', default: false },
      suite: { type: 'string' },
      runs: { type: 'string', default: '3' },
      mode: { type: 'string', default: 'snapshot' },
      abstain: { type: 'boolean', default: false },
      'max-tokens': { type: 'string', default: '2000000' },
      out: { type: 'string', default: 'eval/reports' },
      name: { type: 'string' },
      waive: { type: 'string', multiple: true, default: [] },
      seed: { type: 'string', default: '20261020' },
      'pack-lock': { type: 'string', default: `sha256:${'0'.repeat(64)}` },
      trace: { type: 'string' },
    },
  });
  const casesDir = values.cases;
  if (!casesDir) {
    throw new Error('需要 --cases <用例目录>');
  }
  const mode = values.mode;
  if (mode !== 'snapshot' && mode !== 'reconstructed') {
    throw new Error('--mode 只能是 snapshot 或 reconstructed');
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error('--runs 必须是 1–10 的整数');
  }
  const configs = values.compare ? positionals : values.config ? [values.config] : [];
  if (values.compare ? configs.length !== 2 : configs.length !== 1) {
    throw new Error(
      values.compare ? '用法：eval --compare <当前配置> <候选配置> --cases <目录>' : '需要 --config <配置>',
    );
  }
  const seed = Number(values.seed);
  const store = new CaseStore(casesDir);
  const now = new Date().toISOString();
  const cases: Array<{ c: EvalCase; s: EvalSnapshot }> = [];
  for (const c of store.cases(values.suite)) {
    if (c.snapshot_id === null) {
      if (mode === 'snapshot') {
        continue;
      }
      throw new Error(`用例 ${c.case_id} 没有快照，reconstructed 模式也需要快照中的研判上下文`);
    }
    const s = store.snapshot(c.snapshot_id);
    cases.push({ c, s });
    if (values.abstain && c.truth.root_components.length) {
      const d = deriveAbstain(c, s, stableUuid('abstain', c.case_id), now);
      if (d) {
        cases.push(d);
      }
    }
  }
  if (!cases.length) {
    throw new Error(`用例目录 ${casesDir} 中没有可回放的用例`);
  }
  const metrics = new WorkerMetrics('worker', false);
  const outcomes: EvalOutcome[] = [];
  for (const path of configs) {
    const cfg = loadEvalConfig(path);
    const sessions: McpSession[] = [];
    let liveTools: Tool[] = [];
    if (mode === 'reconstructed') {
      for (const m of cfg.mcp) {
        const s = await openMcp(m, new AbortController().signal);
        sessions.push(s);
        liveTools = [...liveTools, ...s.tools.filter((t) => !t.live)];
      }
    }
    outcomes.push(
      await runEval({
        mode,
        cases,
        layers: layers(cfg, metrics),
        runs,
        language: cfg.language,
        metrics,
        liveTools,
        query: null,
        maxTokens: Number(values['max-tokens']),
        signal: new AbortController().signal,
        // 比较两份配置时研判记录分开写
        traceDir: values.trace
          ? values.compare
            ? join(values.trace, `config-${outcomes.length}`)
            : values.trace
          : null,
      }),
    );
    for (const s of sessions) {
      await s.close();
    }
  }
  const evalCases = cases.map((x) => x.c);
  const meta = {
    codeSha: codeSha(),
    packLock: values['pack-lock'],
    mode: mode as 'snapshot' | 'reconstructed',
    caseSet: values.suite ?? 'all',
    runsPerCase: runs,
    seed,
  };
  const current = outcomes[0] as EvalOutcome;
  let report = buildReport(meta, evalCases, current.runs, null);
  if (values.compare) {
    const candidate = outcomes[1] as EvalOutcome;
    const base = report;
    const primary = (o: EvalOutcome) => o.runs.filter((r) => r.routeId === o.runs[0]?.routeId);
    const gate = evaluateGate(
      base.report_id,
      evalCases,
      primary(current),
      primary(candidate),
      runs,
      values.waive,
      seed,
    );
    report = { ...buildReport(meta, evalCases, candidate.runs, gate) };
    const name = values.name ?? `compare-${now.slice(0, 10)}`;
    writeReport(values.out, `${name}.baseline`, base, current, '评测：当前配置');
    const path = writeReport(values.out, name, report, candidate, '评测：候选配置与发布门禁');
    logger.info('评测完成', { report: path, gate_passed: gate.passed, tokens: current.tokens + candidate.tokens });
    return { reportPath: path, gatePassed: gate.passed };
  }
  const path = writeReport(values.out, values.name ?? `eval-${now.slice(0, 10)}`, report, current, '评测成绩单');
  logger.info('评测完成', { report: path, tokens: current.tokens, skipped: current.skipped });
  return { reportPath: path, gatePassed: null };
}

// eval export --labels <标注> --cases <用例目录> --config <配置> [--state <状态库连接文件>] [--only <标注 id>]...
//   按标注从指标后端（与状态库，只读）导出重建包到 <用例目录>/bundles/
async function exportCli(argv: string[]): Promise<CliResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      labels: { type: 'string' },
      cases: { type: 'string' },
      config: { type: 'string' },
      state: { type: 'string' },
      only: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.labels || !values.cases || !values.config) {
    throw new Error('用法：eval export --labels <标注> --cases <用例目录> --config <配置> [--state <状态库连接文件>]');
  }
  const f = loadLabels(values.labels);
  const r = loadReconstructConfig(values.config);
  const state = values.state ? await readOnlyClient(loadStateDbConfig(values.state)) : null;
  try {
    for (const l of f.labels.filter((x) => !values.only.length || values.only.includes(x.id))) {
      const b = await exportBundle(l, {
        clusterId: r.cluster_id,
        metrics: { url: r.metrics.url, bearerTokenFile: r.metrics.bearer_token_file ?? null },
        state,
        stateId: state ? 'state' : null,
      });
      process.stdout.write(`${writeBundle(values.cases, b)}\n`);
    }
  } finally {
    await state?.end();
  }
  return { reportPath: null, gatePassed: null };
}

// eval label --labels <标注> --cases <用例目录>
//   快照模式：把标注写进对应的种子用例（legacy_case），生成新版本的用例
function labelCli(argv: string[]): CliResult {
  const { values } = parseArgs({ args: argv, options: { labels: { type: 'string' }, cases: { type: 'string' } } });
  if (!values.labels || !values.cases) {
    throw new Error('用法：eval label --labels <标注> --cases <用例目录>');
  }
  const f = loadLabels(values.labels);
  const store = new CaseStore(values.cases);
  const all = new Map(store.cases().map((c) => [c.case_id, c]));
  const now = new Date().toISOString();
  let n = 0;
  for (const l of f.labels) {
    if (!l.legacy_case) {
      continue;
    }
    const c = all.get(l.legacy_case);
    if (!c) {
      throw new Error(`标注 ${l.id} 的种子用例 ${l.legacy_case} 不在用例目录中`);
    }
    store.writeCase(relabelLegacy(c, l, now));
    n++;
  }
  process.stdout.write(`${n} 个种子用例写入了标注\n`);
  return { reportPath: null, gatePassed: null };
}

// eval reconstruct --labels <标注> --cases <用例目录> --config <配置> [--runs 3] [--max-tokens N]
//                  [--repo <GitOps 仓库的本地克隆>] [--discovery-only] [--only <标注 id>]... [--out] [--name]
//                  [--trace <研判记录目录>]
//   第二阶段三个环节的重建评测：发现重放、重建阶段 A 与研判（每条路由 k 次）、自愈 PR 的补丁检查
async function reconstructCli(argv: string[]): Promise<CliResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      labels: { type: 'string' },
      cases: { type: 'string' },
      config: { type: 'string' },
      runs: { type: 'string', default: '3' },
      'max-tokens': { type: 'string', default: '2000000' },
      repo: { type: 'string' },
      'discovery-only': { type: 'boolean', default: false },
      only: { type: 'string', multiple: true, default: [] },
      suite: { type: 'string', default: 'reconstructed' },
      out: { type: 'string', default: 'eval/reports' },
      name: { type: 'string' },
      seed: { type: 'string', default: '20261020' },
      trace: { type: 'string' },
    },
  });
  if (!values.labels || !values.cases || !values.config) {
    throw new Error('用法：eval reconstruct --labels <标注> --cases <用例目录> --config <配置>');
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error('--runs 必须是 1–10 的整数');
  }
  const f = loadLabels(values.labels);
  const now = new Date().toISOString();
  const sha = codeSha();
  const metrics = new WorkerMetrics('worker', false);
  const cfg = values['discovery-only'] ? null : loadEvalConfig(values.config);
  const r = cfg?.reconstruct ?? loadReconstructConfig(values.config);
  mkdirSync(values.out, { recursive: true });
  const result = await runPhase2({
    labels: f,
    only: values.only,
    casesDir: values.cases,
    reconstruct: r,
    suite: values.suite,
    codeSha: sha,
    analysis: cfg
      ? {
          layers: layers(cfg, metrics),
          runs,
          language: cfg.language,
          metrics,
          maxTokens: Number(values['max-tokens']),
          repo: values.repo ?? null,
          scratch: values.out,
          traceDir: values.trace ?? null,
        }
      : null,
    now,
  });
  const name = values.name ?? `reconstruct-${now.slice(0, 10)}`;
  const extra = renderPhase2Markdown(result);
  writeFileSync(
    join(values.out, `${name}.phase2.json`),
    `${JSON.stringify(
      {
        code_sha: sha,
        pack_lock: result.packLock,
        discovery: { summary: result.discoverySummary, cases: result.discovery },
        coverage: result.coverage,
        agreement: result.agreement,
        remediation: result.remediation,
        tokens: result.analysis?.tokens ?? 0,
      },
      null,
      1,
    )}\n`,
  );
  if (!result.analysis) {
    const md = join(values.out, `${name}.md`);
    writeFileSync(md, `# 评测：发现重放\n\n代码 ${sha}，领域包 ${result.packLock}。\n\n${extra}`);
    logger.info('发现重放完成', { report: md });
    return { reportPath: md, gatePassed: null };
  }
  const report = buildReport(
    {
      codeSha: sha,
      packLock: result.packLock,
      mode: 'reconstructed',
      caseSet: values.suite,
      runsPerCase: runs,
      seed: Number(values.seed),
    },
    result.evalCases,
    result.analysis.runs,
    null,
  );
  const path = writeReport(
    values.out,
    name,
    report,
    result.analysis,
    '评测：第二阶段重建（发现、分析、自愈 PR）',
    extra,
  );
  logger.info('重建评测完成', { report: path, tokens: result.analysis.tokens, skipped: result.analysis.skipped });
  return { reportPath: path, gatePassed: null };
}

// eval live --state <状态库连接文件> --config <配置> --since <时刻> [--until <时刻>] [--out] [--name]
//   影子环境的统计（只读）：新建事件数、unlabelled 占比、检测延迟、有证据卡的比例、证据卡与告警结论一致率、
//   自愈 PR 与 issue。集群 id 与领域包取自配置的 reconstruct 部分
async function liveCli(argv: string[]): Promise<CliResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      state: { type: 'string' },
      config: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      out: { type: 'string', default: 'eval/reports' },
      name: { type: 'string' },
    },
  });
  if (!values.state || !values.config || !values.since) {
    throw new Error('用法：eval live --state <状态库连接文件> --config <配置> --since <时刻> [--until <时刻>]');
  }
  const rc = loadReconstructConfig(values.config);
  const rt = await loadRuntime(rc);
  const clusterId = rc.cluster_id;
  const since = new Date(values.since);
  const until = values.until ? new Date(values.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
    throw new Error('--since 与 --until 必须是合法的时刻，且 since 早于 until');
  }
  const c = await readOnlyClient(loadStateDbConfig(values.state));
  let stats: Awaited<ReturnType<typeof liveStats>>;
  let rem: Awaited<ReturnType<typeof liveRemediation>>;
  let agreement: AgreementSummary;
  try {
    stats = await liveStats(c, clusterId, since, until);
    rem = await liveRemediation(c, clusterId, since, until);
    agreement = summarizeAgreement(await liveAgreement(c, rt, clusterId, since, until));
  } finally {
    await c.end();
  }
  mkdirSync(values.out, { recursive: true });
  const name = values.name ?? `live-${until.toISOString().slice(0, 13)}`;
  writeFileSync(
    join(values.out, `${name}.json`),
    `${JSON.stringify({ stats, agreement, remediation: rem, pack_lock: rt.set.lockDigest }, null, 1)}\n`,
  );
  const p = (x: { n: number; d: number }) => (x.d ? `${((100 * x.n) / x.d).toFixed(1)}%（${x.n}/${x.d}）` : '—（0/0）');
  const md = join(values.out, `${name}.md`);
  writeFileSync(
    md,
    [
      `# 影子环境统计：${stats.since} – ${stats.until}`,
      '',
      '| 指标 | 值 |',
      '|---|---|',
      `| 新建事件 | ${stats.incidents} |`,
      `| unlabelled 占比 | ${p({ n: stats.unlabelled, d: stats.incidents })} |`,
      `| 检测延迟 p50 / p95（秒，${stats.latency_n} 个） | ${stats.latency_p50_s?.toFixed(1) ?? '—'} / ${stats.latency_p95_s?.toFixed(1) ?? '—'} |`,
      `| 有证据卡的事件 | ${p(stats.with_cards)} |`,
      `| 有卡的事件中至少一张卡得出结论 | ${p(stats.with_determinate_card)} |`,
      `| 每个有卡事件的卡数中位数 | ${stats.cards_median ?? '—'} |`,
      `| 研判完成的事件 / 结论 likely 及以上 | ${stats.research.finished} / ${stats.research.likely_or_better} |`,
      `| gitops_pr 提议 / 关联的 PR / 打开的 issue | ${rem.gitops_pr_proposals} / ${rem.linked_pulls} / ${rem.issues_open} |`,
      '',
      renderAgreement(agreement, '证据卡与告警结论一致率（报告渲染时触发中的成员告警）'),
    ].join('\n'),
  );
  return { reportPath: md, gatePassed: null };
}

function writeReport(
  dir: string,
  name: string,
  report: ReturnType<typeof buildReport>,
  o: EvalOutcome,
  title: string,
  extra = '',
): string {
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `${name}.md`);
  const notes = o.skipped ? `\n因 token 上限没有运行：${o.skipped} 次。\n` : '';
  const used = `\n本次评测用了 ${o.tokens} token。\n`;
  writeFileSync(md, renderMarkdown(report, title) + notes + used + (extra ? `\n${extra}` : ''));
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(join(dir, `${name}.runs.jsonl`), o.runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return md;
}
