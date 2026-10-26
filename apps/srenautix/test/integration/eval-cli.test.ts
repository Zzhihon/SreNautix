import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvalCli } from '../../src/eval/cli.js';
import { CaseStore } from '../../src/eval/store.js';
import { scenarioEvalCase, startVictoria } from '../support/eval-scenario.js';
import { fixture, ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { writeSeedFixture } from '../support/seed-fixture.js';
import type { Victoria } from '../support/victoria.js';

// srenautix eval 命令：导入种子、评测并生成报告、两份配置的比较与门禁。模型响应来自本地 llama.cpp 的录制。

const recorded = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/llm/eval/scenario-pvc.json'), 'utf8'),
) as { responses: LlmFixture[] };
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `eval-cli-${process.pid}`);

// 开跑前探测（ADR 0110）对每条路由依次发出 json_schema、工具调用、推理通道、中文四次调用与 GET /models；
// 这里用同一个本地模型的录制响应回答，排在评测本身的录制之前
const P = 'llamacpp-qwen3-1.7b';
const probeResponses = (): LlmFixture[] => [
  fixture(P, 'chat-json-schema'),
  fixture(P, 'chat-tool-call'),
  fixture(P, 'chat-chinese'),
  fixture(P, 'chat-chinese'),
  { provenance: { mode: 'synthetic', path: '/models' }, status: 200, body: { object: 'list', data: [] } },
];

function serve(server: ReplayServer): void {
  server.enqueue(...probeResponses(), ...recorded.responses);
}

let vm: Victoria;

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  vm = await startVictoria();
  const { c, s } = await scenarioEvalCase(vm);
  const store = new CaseStore(join(ROOT, 'cases'));
  store.writeCase(c);
  store.writeSnapshot(s);
});

afterAll(async () => {
  await vm.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

function config(name: string, baseUrl: string, failureDomain: string[] = []): string {
  const path = join(ROOT, `${name}.yaml`);
  writeFileSync(
    path,
    [
      'language: zh',
      'routes:',
      '  - id: local',
      `    base_url: ${baseUrl}`,
      '    api: chat_completions',
      '    model: qwen3-1.7b',
      '    dialect_profile: llamacpp',
      '    price: { currency: CNY, input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null }',
      `    failure_domain: ${JSON.stringify(failureDomain)}`,
      '    in_domain: true',
      '    tier: large',
      '    retention_terms: local',
      '    api_key_env: SRENAUTIX_TEST_LLM_KEY',
      '    context_tokens: 16384',
    ].join('\n'),
  );
  return path;
}

describe('srenautix eval', () => {
  it('import-seed 写出用例与快照', async () => {
    writeSeedFixture(join(ROOT, 'seed'));
    await runEvalCli([
      'import-seed',
      '--dir',
      join(ROOT, 'seed'),
      '--cases',
      join(ROOT, 'imported'),
      '--suite',
      'reference',
      '--cluster-id',
      'ref',
    ]);
    expect(new CaseStore(join(ROOT, 'imported')).cases().map((c) => c.case_id)).toHaveLength(2);
  });

  it('评测一份配置，报告写到输出目录', async () => {
    process.env.SRENAUTIX_TEST_LLM_KEY = 'local';
    const server = new ReplayServer();
    await server.start();
    serve(server);
    const r = await runEvalCli([
      '--cases',
      join(ROOT, 'cases'),
      '--config',
      config('one', server.baseUrl),
      '--runs',
      '3',
      '--out',
      join(ROOT, 'reports'),
      '--name',
      'one',
    ]);
    await server.stop();
    expect(r.reportPath).toBe(join(ROOT, 'reports', 'one.md'));
    const md = readFileSync(r.reportPath as string, 'utf8');
    expect(md).toMatch(/\| local \| qwen3-1\.7b \| all \| 100\.0% \(3\/3\)/);
    const runs = readFileSync(join(ROOT, 'reports', 'one.runs.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(runs).toHaveLength(3);
  });

  it('路由的故障域不参与评测：事件在故障域内时照常研判，不只出阶段 A', async () => {
    process.env.SRENAUTIX_TEST_LLM_KEY = 'local';
    const server = new ReplayServer();
    await server.start();
    serve(server);
    await runEvalCli([
      '--cases',
      join(ROOT, 'cases'),
      '--config',
      config('domain', server.baseUrl, ['Namespace:shop']),
      '--runs',
      '3',
      '--out',
      join(ROOT, 'reports'),
      '--name',
      'domain',
    ]);
    await server.stop();
    const runs = readFileSync(join(ROOT, 'reports', 'domain.runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { state: string });
    expect(runs.map((r) => r.state)).toEqual(['completed', 'completed', 'completed']);
  });

  it('--trace 为每次运行写研判记录：标准答案、输出、模型调用的请求与响应', async () => {
    process.env.SRENAUTIX_TEST_LLM_KEY = 'local';
    const server = new ReplayServer();
    await server.start();
    serve(server);
    await runEvalCli([
      '--cases',
      join(ROOT, 'cases'),
      '--config',
      config('trace', server.baseUrl),
      '--runs',
      '3',
      '--out',
      join(ROOT, 'reports'),
      '--name',
      'trace',
      '--trace',
      join(ROOT, 'trace'),
    ]);
    await server.stop();
    const dir = join(ROOT, 'trace', encodeURIComponent('scenario:pvc-full'));
    expect(readdirSync(dir).sort()).toEqual(['local-0.json', 'local-1.json', 'local-2.json']);
    const t = JSON.parse(readFileSync(join(dir, 'local-0.json'), 'utf8')) as {
      state: string;
      truth: { root_components: string[] };
      output: { conclusion: { level: string } } | null;
      llm_calls: Array<{ request: string; response: string | null }>;
      steps: unknown[];
    };
    expect(t.state).toBe('completed');
    expect(t.truth.root_components).toContain('StatefulSet:shop/postgres');
    expect(t.output?.conclusion.level).toBe('likely');
    expect(t.llm_calls.length).toBeGreaterThan(0);
    expect(t.llm_calls[0]!.request.length).toBeGreaterThan(0);
    expect(t.llm_calls.some((c) => c.response !== null)).toBe(true);
    expect(t.steps.length).toBeGreaterThan(0);
  });

  it('开跑前探测不到模型路由时不开跑，写出无效标记，不写成绩单', async () => {
    process.env.SRENAUTIX_TEST_LLM_KEY = 'local';
    // 没有任何服务监听的端口：连接失败
    await expect(
      runEvalCli([
        '--cases',
        join(ROOT, 'cases'),
        '--config',
        config('down', 'http://127.0.0.1:9/v1'),
        '--runs',
        '1',
        '--out',
        join(ROOT, 'reports'),
        '--name',
        'down',
      ]),
    ).rejects.toThrow(/开跑前探测：模型路由 local 不可用/);
    expect(existsSync(join(ROOT, 'reports', 'down.md'))).toBe(false);
    expect(readFileSync(join(ROOT, 'reports', 'down.invalid.md'), 'utf8')).toContain('开跑前探测');
  });

  it('运行中模型服务不可达的运行超过 10% 时中止，这一轮无效', async () => {
    process.env.SRENAUTIX_TEST_LLM_KEY = 'local';
    const server = new ReplayServer();
    await server.start();
    // 探测通过之后不再有响应：之后的每次调用都得到服务端错误
    server.enqueue(...probeResponses());
    await expect(
      runEvalCli([
        '--cases',
        join(ROOT, 'cases'),
        '--config',
        config('flaky', server.baseUrl),
        '--runs',
        '3',
        '--out',
        join(ROOT, 'reports'),
        '--name',
        'flaky',
      ]),
    ).rejects.toThrow(/超过本轮计划 3 次的 10%/);
    await server.stop();
    expect(existsSync(join(ROOT, 'reports', 'flaky.md'))).toBe(false);
    expect(readFileSync(join(ROOT, 'reports', 'flaky.invalid.md'), 'utf8')).toContain('这一轮无效');
    const partial = readFileSync(join(ROOT, 'reports', 'flaky.invalid.runs.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(partial).toHaveLength(1);
  });

  it('--compare：两份配置各评测一次，输出门禁', async () => {
    const a = new ReplayServer();
    const b = new ReplayServer();
    await a.start();
    await b.start();
    serve(a);
    serve(b);
    const r = await runEvalCli([
      '--compare',
      config('current', a.baseUrl),
      config('candidate', b.baseUrl),
      '--cases',
      join(ROOT, 'cases'),
      '--runs',
      '3',
      '--out',
      join(ROOT, 'reports'),
      '--name',
      'cmp',
    ]);
    await a.stop();
    await b.stop();
    expect(r.gatePassed).toBe(true);
    const report = JSON.parse(readFileSync(join(ROOT, 'reports', 'cmp.json'), 'utf8')) as {
      gate: { paired_cases: number; threshold: number };
      rows: Array<{ false_push: { denominator: number }; false_issue: { denominator: number } }>;
    };
    // 误推送默认不设上限（ADR 0175）；用例集里没有良性用例，三个度量没有样本
    expect(report.gate).toMatchObject({ paired_cases: 1, threshold: -0.1, false_push: null, false_push_max: null });
    expect(report.rows[0]).toMatchObject({ false_push: { denominator: 0 }, false_issue: { denominator: 0 } });
    expect(readFileSync(join(ROOT, 'reports', 'cmp.baseline.md'), 'utf8')).toContain('评测：当前配置');
  });

  it('参数错误时直接报错', async () => {
    await expect(runEvalCli(['--cases', join(ROOT, 'cases')])).rejects.toThrow(/--config/);
    await expect(runEvalCli(['--compare', 'x.yaml', '--cases', join(ROOT, 'cases')])).rejects.toThrow(/--compare/);
    await expect(
      runEvalCli(['--cases', join(ROOT, 'cases'), '--config', 'x.yaml', '--max-false-push', '0.1']),
    ).rejects.toThrow(/--max-false-push 只用于 --compare/);
    await expect(
      runEvalCli(['--compare', 'a.yaml', 'b.yaml', '--cases', join(ROOT, 'cases'), '--max-false-push', '1.5']),
    ).rejects.toThrow(/0–1/);
    await expect(runEvalCli(['candidates', 'list'])).rejects.toThrow(/eval candidates export/);
    await expect(runEvalCli(['label', 'merge', '--labels', 'x.yaml'])).rejects.toThrow(/--candidates/);
  });
});
