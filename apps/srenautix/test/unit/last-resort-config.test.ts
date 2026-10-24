import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadEvalConfig } from '../../src/eval/config.js';
import { workerConfigSchema } from '../../src/research/config.js';

// 兜底路由的配置（ADR 0152）：worker 配置必须给出兜底路由的每日上限；评测可以只评测指定的路由，只读取这些路由的密钥

const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `last-resort-config-${process.pid}`);

const route = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  base_url: 'http://m/v1',
  api: 'chat_completions',
  model: `${id}-model`,
  dialect_profile: 'openai-compatible',
  price: { currency: 'CNY', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
  in_domain: true,
  tier: 'large',
  retention_terms: 'x',
  ...over,
});

const worker = (routes: unknown[], budget: Record<string, unknown> = {}) => ({
  cluster_id: 'c',
  code_sha: 'a'.repeat(40),
  hub: { url: 'http://hub:8080', token_file: '/t' },
  inbound: { token_sha256_file: '/s' },
  llm: { routes },
  budget: { daily_tokens: 100000, ...budget },
});

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('worker 配置', () => {
  it('配置了兜底路由时必须给出 budget.last_resort.daily_tokens', () => {
    const routes = [
      route('primary', { api_key_file: '/k' }),
      route('direct', { api_key_file: '/d', role: 'last_resort' }),
    ];
    expect(() => workerConfigSchema.parse(worker(routes))).toThrow(
      /配置了兜底路由 direct，必须给出 budget.last_resort.daily_tokens/,
    );
    const ok = workerConfigSchema.parse(worker(routes, { last_resort: { daily_tokens: 2000000 } }));
    expect(ok.llm.routes.map((r) => r.role)).toEqual([undefined, 'last_resort']);
    expect(ok.budget.last_resort).toEqual({ daily_tokens: 2000000 });
  });

  it('没有兜底路由时配置与之前相同：role 与 budget.last_resort 都可以省略', () => {
    const ok = workerConfigSchema.parse(worker([route('primary', { api_key_file: '/k' })]));
    expect(ok.llm.routes[0]).not.toHaveProperty('role');
    expect(ok.budget).not.toHaveProperty('last_resort');
  });
});

describe('评测配置的 --route', () => {
  const file = join(ROOT, 'eval.yaml');

  beforeAll(() => {
    writeFileSync(
      file,
      stringify({
        language: 'zh',
        routes: [
          route('primary', { api_key_env: 'LR_TEST_PRIMARY_KEY' }),
          route('direct', { api_key_env: 'LR_TEST_DIRECT_KEY', role: 'last_resort' }),
        ],
      }),
    );
  });

  it('只评测列出的路由，其他路由的密钥不读取', () => {
    const cfg = loadEvalConfig(file, { LR_TEST_DIRECT_KEY: 'direct-key' }, ['direct']);
    expect(cfg.routes.map((r) => [r.route.id, r.route.role, r.apiKey])).toEqual([
      ['direct', 'last_resort', 'direct-key'],
    ]);
  });

  it('不给出 --route 时评测全部路由，每条路由的密钥都必须存在', () => {
    expect(() => loadEvalConfig(file, { LR_TEST_DIRECT_KEY: 'direct-key' })).toThrow(
      /路由 primary 的密钥环境变量 LR_TEST_PRIMARY_KEY 没有设置/,
    );
    const cfg = loadEvalConfig(file, { LR_TEST_PRIMARY_KEY: 'p', LR_TEST_DIRECT_KEY: 'd' });
    expect(cfg.routes.map((r) => r.route.id)).toEqual(['primary', 'direct']);
  });

  it('列出配置中没有的路由时报错', () => {
    expect(() => loadEvalConfig(file, {}, ['missing'])).toThrow(/中没有路由 missing，可选：primary、direct/);
  });
});
