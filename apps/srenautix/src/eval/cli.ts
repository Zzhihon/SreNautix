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
import { loadEvalConfig, type EvalConfig } from './config.js';
import { importSeed } from './import-seed.js';
import { deriveAbstain } from './leakage.js';
import { buildReport, evaluateGate, renderMarkdown } from './report.js';
import { runEval, type EvalOutcome } from './runner.js';
import { stableUuid } from './import-seed.js';
import { CaseStore } from './store.js';

// srenautix eval 命令：
//   eval --cases <目录> --config <配置> [--suite <名>] [--runs 3] [--mode snapshot|reconstructed]
//        [--abstain] [--max-tokens N] [--out eval/reports] [--name <报告名>]
//     每条路由单独评测，输出成绩单（Markdown 与 JSON）和每次运行的记录。
//   eval --compare <当前配置> <候选配置> --cases <目录> [同上] [--waive <case_id>]...
//     两份配置在相同用例上各评测一次，按各自的第一条路由做配对比较，给出发布门禁结果。
//   eval import-seed --dir <种子目录> --cases <目录> --suite <名> --cluster-id <id>
//     导入旧版 Ops-Agent 回放种子。

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
      [{ route: r.route, apiKey: r.apiKey, state: { profile: null, calibration: null, fingerprint: null } }],
      egress,
      cfg.callTimeoutMs,
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
      callTimeoutMs: cfg.callTimeoutMs,
      onCalibration: async () => undefined,
      onDrift: async () => undefined,
    });
    return { routeId: r.route.id, layer };
  });
}

export async function runEvalCli(argv: string[]): Promise<CliResult> {
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

function writeReport(
  dir: string,
  name: string,
  report: ReturnType<typeof buildReport>,
  o: EvalOutcome,
  title: string,
): string {
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `${name}.md`);
  const notes = o.skipped ? `\n因 token 上限没有运行：${o.skipped} 次。\n` : '';
  writeFileSync(md, renderMarkdown(report, title) + notes);
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(join(dir, `${name}.runs.jsonl`), o.runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return md;
}
