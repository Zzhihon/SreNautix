import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvalCli } from '../../src/eval/cli.js';
import { deriveAbstain } from '../../src/eval/leakage.js';
import { CaseStore } from '../../src/eval/store.js';
import { scenarioEvalCase, startVictoria } from '../support/eval-scenario.js';
import type { Victoria } from '../support/victoria.js';

// 用 srenautix eval 命令对本地模型服务跑场景用例集，成绩单写到仓库的 eval/reports/。只在本地运行：
//   SRENAUTIX_LIVE_LLM_BASE_URL=http://127.0.0.1:18431/v1 SRENAUTIX_LIVE_MODEL=qwen3-1.7b pnpm test:live -- eval-report

const BASE = process.env.SRENAUTIX_LIVE_LLM_BASE_URL;
const MODEL = process.env.SRENAUTIX_LIVE_MODEL;
if (!BASE || !MODEL) {
  throw new Error('需要 SRENAUTIX_LIVE_LLM_BASE_URL 与 SRENAUTIX_LIVE_MODEL（只指向本地自己启动的模型服务）');
}
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `eval-report-${process.pid}`);
const REPORTS = resolve(import.meta.dirname, '../../../../eval/reports');

let vm: Victoria;

beforeAll(async () => {
  vm = await startVictoria();
  mkdirSync(ROOT, { recursive: true });
});

afterAll(async () => {
  await vm.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('本地模型的场景成绩单', () => {
  it('srenautix eval 写出成绩单', async () => {
    const base = await scenarioEvalCase(vm);
    const store = new CaseStore(join(ROOT, 'cases'));
    store.writeCase(base.c);
    store.writeSnapshot(base.s);
    const abstain = deriveAbstain(base.c, base.s, '7a1b2c3d-0000-4000-8000-0000000000e2', base.c.created_at);
    if (abstain) {
      store.writeCase(abstain.c);
      store.writeSnapshot(abstain.s);
    }
    const config = join(ROOT, 'local.yaml');
    writeFileSync(
      config,
      [
        'language: zh',
        'routes:',
        '  - id: local',
        `    base_url: ${BASE}`,
        '    api: chat_completions',
        `    model: ${MODEL}`,
        '    dialect_profile: llamacpp',
        '    price: { currency: CNY, input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null }',
        '    in_domain: true',
        '    tier: large',
        '    retention_terms: local process',
        '    api_key_env: SRENAUTIX_LIVE_KEY',
        '    context_tokens: 16384',
        'budget: { call_timeout_seconds: 300 }',
      ].join('\n'),
    );
    process.env.SRENAUTIX_LIVE_KEY = 'local';
    const r = await runEvalCli([
      '--cases',
      join(ROOT, 'cases'),
      '--config',
      config,
      '--suite',
      'scenario',
      '--runs',
      '3',
      '--out',
      REPORTS,
      '--name',
      `${new Date().toISOString().slice(0, 10)}-scenario-${MODEL}`,
    ]);
    expect(r.reportPath).not.toBeNull();
  });
});
