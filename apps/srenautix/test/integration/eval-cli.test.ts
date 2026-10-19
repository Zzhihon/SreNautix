import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvalCli } from '../../src/eval/cli.js';
import { CaseStore } from '../../src/eval/store.js';
import { scenarioEvalCase, startVictoria } from '../support/eval-scenario.js';
import { ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { writeSeedFixture } from '../support/seed-fixture.js';
import type { Victoria } from '../support/victoria.js';

// srenautix eval 命令：导入种子、评测并生成报告、两份配置的比较与门禁。模型响应来自本地 llama.cpp 的录制。

const recorded = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/llm/eval/scenario-pvc.json'), 'utf8'),
) as { responses: LlmFixture[] };
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `eval-cli-${process.pid}`);

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

function config(name: string, baseUrl: string): string {
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
    server.enqueue(...recorded.responses);
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

  it('--compare：两份配置各评测一次，输出门禁', async () => {
    const a = new ReplayServer();
    const b = new ReplayServer();
    await a.start();
    await b.start();
    a.enqueue(...recorded.responses);
    b.enqueue(...recorded.responses);
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
    };
    expect(report.gate).toMatchObject({ paired_cases: 1, threshold: -0.1 });
    expect(readFileSync(join(ROOT, 'reports', 'cmp.baseline.md'), 'utf8')).toContain('评测：当前配置');
  });

  it('参数错误时直接报错', async () => {
    await expect(runEvalCli(['--cases', join(ROOT, 'cases')])).rejects.toThrow(/--config/);
    await expect(runEvalCli(['--compare', 'x.yaml', '--cases', join(ROOT, 'cases')])).rejects.toThrow(/--compare/);
  });
});
