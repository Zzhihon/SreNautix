import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatorFor, type EvidenceResult, type Goal, type OptimizationOutput } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmReplay } from '../../src/llm/replay.js';
import { DEFAULT_LIMITS } from '../../src/research/controller.js';
import type { CheckTemplate } from '../../src/research/catalog.js';
import type { QueryRunContext, QueryRunner } from '../../src/research/checks.js';
import { fillTemplateArgs, runOptimization } from '../../src/optimize/controller.js';
import { optimizePromptHash } from '../../src/optimize/prompts.js';
import type { GoalRunContext } from '../../src/optimize/runner.js';
import { MemorySink, testLayer, testRoute } from '../support/research-env.js';

// 主动优化的 worker 控制器（ADR 0146 §2.3）与不变量 13：模型输出中的原始查询、未知模板与不合模板 schema 的参数
// 在 schema 与 vetCheck 处被拒绝，数据源收不到任何请求。

const T = Date.parse('2026-10-20T00:00:00Z');
const DAY = 86_400_000;
const CL = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';
const FA = `sha256:${'a'.repeat(64)}`;
const FB = `sha256:${'b'.repeat(64)}`;
const EA = 'pg_statement:cchp-postgres/cchp/101';
const EB = 'pg_statement:cchp-postgres/cchp/202';
const entity = {
  cluster_id: 'cchp',
  kind: 'Cluster.postgresql.cnpg.io',
  namespace: 'cchp-data',
  name: 'cchp-postgres',
  uid: null,
};

function card(n: number, id: string, verdict: EvidenceResult['verdict']): EvidenceResult {
  return {
    ref: `card:${n}`,
    card_id: id,
    title: { 'zh-CN': id, en: id },
    threshold: null,
    series: [],
    entity,
    window: { from: new Date(T).toISOString(), to: new Date(T + DAY).toISOString() },
    verdict,
    display_state: verdict,
    reason: { kind: 'rule', text: `${id} 判定 ${verdict}` },
    value: null,
    table: null,
    queries: [],
    egress: 'allow',
    anomaly_started_at: null,
    evaluated_at: new Date(T + DAY).toISOString(),
  };
}

const TEMPLATE: CheckTemplate = {
  id: 'optdb/statement-detail',
  description: '一条语句的执行时间与读取量',
  args: {
    type: 'object',
    additionalProperties: false,
    properties: { queryid: { type: 'string', pattern: '^-?[0-9]{1,20}$' } },
  },
};

const goal: Goal = {
  goal_id: '0b0b0b0b-0000-4000-8000-000000000001',
  revision: 1,
  cluster_id: 'cchp',
  spec: {
    origin: { kind: 'manual', channel: 'api', principal: 'test' },
    subject: { type: 'domain', domain: 'database', scope: { components: [], namespaces: [] } },
    objective: null,
    outputs: ['ops_pr', 'business_issue'],
    budget: {
      tokens: 400_000,
      duration_seconds: 1200,
      checks: 12,
      dbstats_queries: 30,
      traces_queries: 10,
      logs_queries: 10,
      code_files: 200,
      code_bytes: 8_388_608,
      github_requests: 300,
    },
  },
  state: 'analyzing',
  state_reason: null,
  expires_at: new Date(T + 3 * DAY).toISOString(),
  last_run: null,
  created_at: new Date(T).toISOString(),
  updated_at: new Date(T).toISOString(),
};

const candidate = (finding: string, key: string, queryid: string, cardRef: string, share: number) => ({
  finding,
  kind: 'pg.statement_dominant',
  entity: {
    type: 'pg_statement',
    key,
    display: `queryid ${queryid}（cchp）`,
    labels: { queryid, database: 'cchp', statement: 'SELECT * FROM orders WHERE user_id = $1' },
  },
  component: CL,
  diagnostic: 'database/statement-dominant',
  card_ref: cardRef,
  share,
  share_ref: 'card:3',
  gap: 0.4,
  score: share * 0.4,
  selected: true,
  skipped_reason: null,
});

function context(): GoalRunContext {
  return {
    goal,
    run_id: '0c0c0c0c-0000-4000-8000-000000000001',
    domain: 'database',
    baseline: {
      window: { from: new Date(T - 7 * DAY).toISOString(), to: new Date(T).toISOString() },
      sufficient: true,
      missing: [],
      indicators: [
        {
          indicator: 'optdb/db-time',
          params: {},
          entity: CL,
          unit: 'per_second',
          better: 'lower',
          statistic: 'p95',
          value: 0.8,
          hours: 168,
          covered_hours: 168,
          peak_hours: 34,
          violation_ratio: 0.5,
          hourly: [],
        },
      ],
    },
    gap: { exists: true, basis: 'gate', detail: 'p95 0.8 高于门槛 0.5' },
    candidates: [candidate(FA, EA, '101', 'card:1', 0.6), candidate(FB, EB, '202', 'card:2', 0.25)],
    cards: [
      card(1, 'optdb/checks/statement-share', 'abnormal'),
      card(2, 'optdb/checks/statement-share', 'abnormal'),
      card(3, 'optdb/checks/statement-share', 'abnormal'),
    ],
    shares: { [FA]: [{ ref: 'card:3', share: 0.6 }], [FB]: [{ ref: 'card:3', share: 0.25 }] },
    templates: [TEMPLATE],
    topology: {
      version: 1,
      nodes: [
        {
          key: CL,
          kind: entity.kind,
          namespace: entity.namespace,
          name: entity.name,
          uid: null,
          labels: {},
          component_type: 'postgres',
          hub: false,
        },
      ],
      edges: [],
    },
    symptoms: { [FA]: ['seq_scan', 'index'], [FB]: ['seq_scan', 'index'] },
    gates: { min_share: 0.2 },
    trend_onset: null,
    pack_lock: 'sha256:' + '0'.repeat(64),
  };
}

class FakeRunner implements QueryRunner {
  readonly calls: Array<{ template: string; args: Record<string, unknown>; root: string }> = [];
  async run(t: CheckTemplate, args: Record<string, unknown>, ctx: QueryRunContext): Promise<EvidenceResult> {
    this.calls.push({ template: t.id, args, root: ctx.rootComponent });
    return card(1, 'optdb/templates/statement-detail', 'normal');
  }
}

const hypothesize = {
  output: {
    hypotheses: [
      {
        id: 'h1',
        parent_id: null,
        finding: '{{match:^sha256:a}}',
        mechanism: '缺少索引导致顺序扫描，每次调用读取大量块',
        symptoms: ['seq_scan', 'index'],
        supporting: ['{{enum:card:1}}'],
        refuting: [],
      },
      {
        id: 'h2',
        parent_id: null,
        finding: '{{match:^sha256:a}}',
        mechanism: '高频轮询导致调用次数暴涨',
        symptoms: ['polling'],
        supporting: [],
        refuting: [],
      },
      {
        id: 'h3',
        parent_id: null,
        finding: '{{match:^sha256:b}}',
        mechanism: '缺少索引导致顺序扫描',
        symptoms: ['seq_scan'],
        supporting: [],
        refuting: [],
      },
    ],
    next_checks: [
      {
        hypothesis_id: 'h2',
        type: 'query',
        template: '{{match:^optdb/statement-detail$}}',
        args_json: '{}',
        refutes_if: '调用速率与基线相同',
        purpose: '区分轮询与缺索引',
      },
    ],
  },
};

const conclude = {
  output: {
    findings: [
      { finding: '{{match:^sha256:a}}', hypothesis_id: 'h1', note: '为 user_id 补索引。', undetermined_reason: null },
      { finding: '{{match:^sha256:b}}', hypothesis_id: null, note: null, undetermined_reason: '没有执行检查' },
    ],
    summary: '语句 101 缺少索引，先补索引。',
  },
};

/** 模型输出里注入的原始查询与不合 schema 的参数（不变量 13） */
const injected = {
  output: {
    ...hypothesize.output,
    next_checks: [
      {
        hypothesis_id: 'h2',
        type: 'query',
        template: 'SELECT * FROM users',
        args_json: '{}',
        refutes_if: 'x',
        purpose: '原始查询',
      },
      {
        hypothesis_id: 'h1',
        type: 'query',
        template: 'optdb/unknown-template',
        args_json: '{}',
        refutes_if: 'x',
        purpose: '未知模板',
      },
      {
        hypothesis_id: 'h3',
        type: 'query',
        template: '{{match:^optdb/statement-detail$}}',
        args_json: '{"queryid":"202","query":"SELECT * FROM users"}',
        refutes_if: 'x',
        purpose: '参数里带查询',
      },
    ],
  },
};

let dir: string;
let normal: LlmReplay;
let attack: LlmReplay;
let normalUrl: string;
let attackUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'srx-optimize-'));
  for (const [name, h] of [
    ['normal', hypothesize],
    ['attack', injected],
  ] as const) {
    const d = join(dir, name);
    mkdirSync(d);
    writeFileSync(join(d, 'optimize_hypothesize_output.json'), JSON.stringify(h));
    writeFileSync(join(d, 'optimize_conclude_output.json'), JSON.stringify(conclude));
  }
  normal = new LlmReplay({ dir: join(dir, 'normal') });
  normalUrl = `http://127.0.0.1:${await normal.listen('127.0.0.1', 0)}/v1`;
  attack = new LlmReplay({ dir: join(dir, 'attack') });
  attackUrl = `http://127.0.0.1:${await attack.listen('127.0.0.1', 0)}/v1`;
});

afterAll(async () => {
  await normal?.close();
  await attack?.close();
  rmSync(dir, { recursive: true, force: true });
});

function env(url: string, query: QueryRunner) {
  const layer = testLayer([
    testRoute(url, { id: 'primary', api: 'responses', model: 'gpt-5', dialect_profile: 'openai-responses' }),
  ]);
  return {
    layer,
    metrics: layer.opts.metrics,
    language: 'zh' as const,
    limits: { ...DEFAULT_LIMITS, deadlineMs: 20 * 60_000, concludeReserveMs: 60_000 },
    query,
    now: () => Date.now(),
  };
}

const validOutput = validatorFor<OptimizationOutput>('schemas/optimization-output.schema.json');

describe('优化控制器', () => {
  it('按发现分组提出假设，检查参数取发现实体的标签，结论按优化结论阶梯给出档位', async () => {
    const runner = new FakeRunner();
    const sink = new MemorySink();
    const res = await runOptimization(
      { runId: context().run_id, ctx: context(), signal: new AbortController().signal },
      env(normalUrl, runner),
      sink,
    );
    expect(res.error).toBeNull();
    expect(res.state).toBe('completed');
    const out = res.output!;
    expect(validOutput(out), JSON.stringify(validOutput.errors)).toBe(true);
    // 检查在 h2（发现 A 上的竞争假设）上执行，queryid 取发现实体的标签
    expect(runner.calls).toEqual([{ template: TEMPLATE.id, args: { queryid: '101' }, root: EA }]);
    expect(out.validation_notes.join('\n')).toMatch(/参数 queryid 取发现实体的标签/);
    // 账本：h2 被推翻；契约中的根因是发现挂到的组件，发现由 finding 给出
    const h2 = out.hypotheses.find((h) => h.hypothesis.id === 'h2')!;
    expect(h2).toMatchObject({ finding: FA, hypothesis: { status: 'refuted', root_component: CL } });
    const a = out.conclusions.find((c) => c.finding === FA)!;
    expect(a).toMatchObject({
      level: 'evidence_consistent',
      hypothesis_id: 'h1',
      chosen_by: 'model',
      consistency: { gap_holds: true, share_holds: true, competitor_tested: true, no_contrary_normal: true },
      share_refs: ['card:3'],
    });
    // 发现 B：h3 有诊断卡支持、没有检验竞争假设；模型弃权时按账本代选，档位最高 likely
    const b = out.conclusions.find((c) => c.finding === FB)!;
    expect(b).toMatchObject({ hypothesis_id: 'h3', chosen_by: 'ledger', level: 'likely' });
    expect(out.stop_reason).toBe('leader_supported');
    expect(res.promptHashes).toEqual({
      hypothesize: optimizePromptHash('zh', 'hypothesize'),
      conclude: optimizePromptHash('zh', 'conclude'),
    });
    // 规范化语句只在带 sql 类别的片段里；默认出境类别不含 sql，这一段在出站前删除
    const sent = sink.llm.map((r) => r.request).join('\n');
    expect(sent).not.toContain('SELECT * FROM orders');
    expect(sink.llm.every((r) => !r.categories.includes('sql'))).toBe(true);
  });

  it('不变量 13：原始查询、未知模板与不合模板 schema 的参数被拒绝，数据源收不到请求', async () => {
    const runner = new FakeRunner();
    const res = await runOptimization(
      { runId: context().run_id, ctx: context(), signal: new AbortController().signal },
      env(attackUrl, runner),
      new MemorySink(),
    );
    expect(res.state).toBe('completed');
    expect(runner.calls).toEqual([]);
    const notes = res.output!.validation_notes.join('\n');
    // 不在动态枚举里的模板（原始查询、未知模板）在 schema 处删除；参数里多出的 query 字段被模板 schema 拒绝
    expect(notes).toMatch(/next_checks\[0\].*删除/);
    expect(notes).toMatch(/next_checks\[1\].*删除/);
    expect(notes).toMatch(/optdb\/statement-detail（假设 h3）：参数不符合模板 schema/);
    expect(res.checks.filter((c) => c.outcome !== 'failed')).toEqual([]);
  });

  it('模板参数的补全只取模板 schema 声明了、模型没有给出的参数，不补 statement', () => {
    const labels = { queryid: '101', database: 'cchp', statement: 'SELECT 1' };
    expect(fillTemplateArgs(TEMPLATE, '{}', labels)).toEqual({ argsJson: '{"queryid":"101"}', filled: ['queryid'] });
    expect(fillTemplateArgs(TEMPLATE, '{"queryid":"7"}', labels)).toEqual({ argsJson: '{"queryid":"7"}', filled: [] });
    expect(fillTemplateArgs(TEMPLATE, 'not json', labels)).toEqual({ argsJson: 'not json', filled: [] });
  });
});
