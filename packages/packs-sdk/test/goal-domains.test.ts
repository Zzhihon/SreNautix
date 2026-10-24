// 主动优化的包内容（契约 2.28.0，ADR 0146）：domains.yaml 与 issues.yaml 的加载与校验、dbstats 信号与夹具、
// 诊断卡与份额卡按行得到的实体、applies: goal 的修复模板（estimate、guard、目标上下文）与业务 issue 模板。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbstatsRequest, DbstatsSample, RepositoryLayout } from '@srenautix/contract';
import { backendsDir, postgresBins, startPostgres } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { compilePackSet } from '../src/pack/compile.js';
import { loadLayerFile } from '../src/pack/layers.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { applicableIssues, planIssue, type GoalTemplateContext } from '../src/remediation/issues.js';
import { applicableRemediations, planRemediation, type RemediationContext } from '../src/remediation/plan.js';
import type { RepoReader } from '../src/remediation/repo.js';
import {
  applyDbstatsRequest,
  DbstatsNotReady,
  DbstatsSampler,
  dbstatsSeries,
  type DbstatsReader,
} from '../src/runtime/dbstats.js';
import { RecordingDataSource, ReplayDataSource } from '../src/runtime/snapshot.js';
import { DbstatsOverlay, LiveDataSource } from '../src/runtime/datasource.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { CATALOG, PACKS } from './support.js';

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

const PACK = `api_version: srenautix.io/pack/v1
name: dbx
version: 0.1.0
description: dbstats 与领域的测试包
maturity: beta
min_srenautix_version: 0.1.0
requires: [metrics.query]
`;

const SIGNALS = `signals:
  - id: stmt_time_rate
    kind: dbstats
    unit: per_second
    alternatives:
      - expr: statements.top
        dialect: dbstats
        args: { order_by: total_exec_time, limit: 20, database: $params.database }
        column: total_exec_time_ms
        rate: true
  - id: xact_rate
    kind: metrics
    alternatives:
      - expr: sum(rate(pg_stat_database_xact_commit{$selector}[$rate_window]))
  - id: db_time
    kind: metrics
    alternatives:
      - expr: sum(rate(pg_stat_statements_seconds_total{$selector, datname="$params.database"}[$rate_window]))
`;

const CHECKS = `checks:
  - id: statement-share
    title: { zh-CN: 语句占执行时间的份额 }
    applies_to: { kinds: [Cluster] }
    window: { before: 30m, after: 0m }
    params: { database: app, min_share: 0.2 }
    refs:
      - { name: stmt, signal: stmt_time_rate, mode: dbstats }
    judge:
      let:
        - { name: total, cel: 'sum(stmt)' }
        - { name: top, cel: 'top_share(stmt, 1)' }
      abnormal_if:
        - { cel: 'top > params.min_share', say: { zh-CN: '最大的一条语句占 {top, number, percent}' } }
    egress: allow
`;

const DOMAINS = `indicators:
  - id: db-time
    title: { zh-CN: 数据库执行时间 }
    signal: db_time
    entity: Cluster
    params:
      type: object
      additionalProperties: false
      properties:
        database: { type: string, pattern: '^[a-z_]+$', description: 库名 }
    unit: ratio
    better: lower
    statistic: p95
    load_indicator: dbx/xact
  - id: xact
    title: { zh-CN: 事务速率 }
    signal: xact_rate
    entity: Cluster
    unit: per_second
    better: higher
    statistic: p95
domains:
  - id: database
    title: { zh-CN: 数据库性能 }
    applies_to: [Cluster]
    indicators: [dbx/db-time]
    diagnostics:
      - id: statement-dominant
        card: checks/statement-share
        finding: pg.statement_dominant
        indicator: dbx/db-time
        symptoms: [seq_scan, index]
        entities:
          type: pg_statement
          rows_from: stmt
          key: 'label(row, "database") + "/" + label(row, "queryid")'
          labels: { queryid: 'label(row, "queryid")', database: 'label(row, "database")' }
          when: 'last(row) / total > params.min_share'
    contribution:
      - id: statement-share
        card: checks/statement-share
        indicator: dbx/db-time
        entities:
          type: pg_statement
          rows_from: stmt
          key: 'label(row, "database") + "/" + label(row, "queryid")'
          share: 'last(row) / total'
    optimizations: [dbx/work-mem]
    issues: [dbx/slow-statement]
    gates: { min_share: 0.25 }
    trends:
      - { id: db-time-drift, indicator: dbx/db-time, method: drift, ratio: 1.25, sustain: 6h }
    schedule: { cron: '0 20 * * 6' }
`;

const ISSUES = `issues:
  - id: slow-statement
    title: { zh-CN: 慢语句, en: Slow statement }
    domain: database
    when: 'finding.kind == "pg.statement_dominant"'
    params: { min_reduction: 0.5 }
    let:
      - { name: share, cel: 'double(finding.share)' }
    locate:
      - { kind: sql, from: 'finding.entity.labels.queryid' }
      - { kind: table, from: '""' }
    suggestion: { zh-CN: '这条语句占执行时间的 {share}，为过滤列补索引或改写查询' }
    estimate:
      indicator: dbx/db-time
      unit: ratio
      lower: 'share * params.min_reduction'
      expected: 'share * 0.8'
      basis: { zh-CN: '份额 {share} × 最小降幅 {min_reduction} = {lower}' }
    verify: { say: { zh-CN: 部署后语句份额下降 }, within: 72h, guards: [dbx/xact] }
    labels: [perf]
`;

const REMEDIATIONS = `remediations:
  - id: work-mem
    title: { zh-CN: 调大 work_mem }
    category: component_param
    applies: goal
    repository: gitops
    when: 'finding.kind == "pg.statement_dominant" && root != null'
    params: { factor: 2, max_mb: 64 }
    let:
      - { name: cluster_name, cel: 'root.name' }
      - { name: docs, cel: 'files.clusters.filter(d, d != null && d.kind == "Cluster" && d.metadata.name == cluster_name)' }
      - { name: current_mb, cel: 'size(docs) == 1 ? double(string(docs[0].spec.postgresql.parameters.work_mem).split("MB")[0]) : 0.0' }
      - { name: new_mb, cel: 'current_mb * double(params.factor)' }
    skip_if:
      - { cel: 'size(docs) != 1', say: { zh-CN: 仓库中没有唯一的 Cluster } }
    guard:
      - { id: within-range, cel: 'new_mb <= double(params.max_mb)', say: { zh-CN: '新值 {new_mb}MB 超过上限 {max_mb}MB' } }
    edits:
      - file: clusters
        document: { kind: Cluster, name: '{cluster_name}' }
        set:
          - { path: spec.postgresql.parameters.work_mem, value: 'string(int(new_mb)) + "MB"' }
    change: { zh-CN: 'work_mem 由 {current_mb}MB 调到 {new_mb}MB' }
    estimate:
      indicator: dbx/db-time
      unit: ratio
      lower: 'double(finding.share) * 0.1'
      expected: 'double(finding.share) * 0.3'
      basis: { zh-CN: '份额的 10% 到 30%，下界 {lower}' }
    verify: { say: { zh-CN: temp 写入下降 }, within: 24h, guards: [dbx/xact] }
    rollback: { say: { zh-CN: revert 这个 PR } }
`;

// 两次采样相隔 10 分钟：语句 1 的执行时间增加 60000 ms（100 ms/s），语句 2 增加 6000 ms（10 ms/s），语句 3 在别的库
const stmt = (queryid: string, database: string, total: number) =>
  `{ queryid: '${queryid}', database: ${database}, role: app, toplevel: true, calls: ${total / 10}, total_exec_time_ms: ${total}, mean_exec_time_ms: 10, rows: 1, shared_blks_hit: 0, shared_blks_read: 0, temp_blks_written: 0, blk_read_time_ms: 0, wal_bytes: 0 }`;
const TESTS = `api_version: srenautix.io/pack-test/v1
interval: 1m
input_dbstats:
  - op: statements.top
    samples:
      - { offset: 0m, rows: [${stmt('1', 'app', 1000)}, ${stmt('2', 'app', 0)}, ${stmt('3', 'other', 0)}] }
      - { offset: 10m, rows: [${stmt('1', 'app', 61000)}, ${stmt('2', 'app', 6000)}, ${stmt('3', 'other', 900000)}] }
tests:
  - name: 第二次采样之前速率不可用
    eval_time: 5m
    card: checks/statement-share
    entity: { kind: Cluster, namespace: shop, name: shop-pg }
    expect: { verdict: undeterminable }
  - name: 一条语句占执行时间的 91%
    eval_time: 10m
    card: checks/statement-share
    entity: { kind: Cluster, namespace: shop, name: shop-pg }
    rows: database/statement-dominant
    expect:
      verdict: abnormal
      entities: [{ key: app/1, hit: true }, { key: app/2, hit: false }]
  - name: 份额卡按行给出份额
    eval_time: 10m
    card: checks/statement-share
    entity: { kind: Cluster, namespace: shop, name: shop-pg }
    rows: database/statement-share
    expect:
      verdict: abnormal
      entities: [{ key: app/1, share: 0.90909 }, { key: app/2, share: 0.09091 }]
  - name: 份额上限调高之后为正常
    eval_time: 10m
    card: checks/statement-share
    entity: { kind: Cluster, namespace: shop, name: shop-pg }
    params: { min_share: 0.95 }
    expect: { verdict: normal }
`;

interface Files {
  signals?: string;
  checks?: string;
  domains?: string;
  issues?: string;
  remediations?: string;
  tests?: string | null;
}

function packDir(f: Files = {}): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'goal-domains-'));
  scratch.push(root);
  const dir = join(root, 'dbx');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), PACK);
  writeFileSync(join(dir, 'signals.yaml'), f.signals ?? SIGNALS);
  writeFileSync(join(dir, 'checks.yaml'), f.checks ?? CHECKS);
  writeFileSync(join(dir, 'domains.yaml'), f.domains ?? DOMAINS);
  writeFileSync(join(dir, 'issues.yaml'), f.issues ?? ISSUES);
  writeFileSync(join(dir, 'remediations.yaml'), f.remediations ?? REMEDIATIONS);
  const tests = f.tests === undefined ? TESTS : f.tests;
  if (tests) {
    writeFileSync(join(dir, 'tests', 'dbstats.yaml'), tests);
  }
  return dir;
}

const compile = (f: Files = {}, layers: string[] = []) =>
  compilePackSet([loadPackDir(packDir(f), 'test')], {
    catalog: CATALOG,
    layers: layers.map((l) => {
      const p = join(scratch[scratch.length - 1]!, `layer-${Math.random().toString(36).slice(2)}.yaml`);
      writeFileSync(p, l);
      return loadLayerFile(p);
    }),
  });

const lintError = async (f: Files, pattern: RegExp) => {
  const err = await compile(f).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PackLintError);
  expect((err as Error).message).toMatch(pattern);
};

describe('domains.yaml 与 issues.yaml', () => {
  it('加载、编译并合并领域：指标、诊断卡、份额卡、模板、门槛缺省值与趋势', async () => {
    const set = await compile();
    expect([...set.indicators.keys()].sort()).toEqual(['dbx/db-time', 'dbx/xact']);
    const d = set.domains.get('database')!;
    expect(d.packs).toEqual(['dbx']);
    expect(d.diagnostics.map((x) => [x.id, x.card, x.finding])).toEqual([
      ['statement-dominant', 'dbx/checks/statement-share', 'pg.statement_dominant'],
    ]);
    expect(d.contribution[0]!.entities!.type).toBe('pg_statement');
    expect(d.gates).toMatchObject({ min_share: 0.25, violation_ratio: 0.1, min_gain_ratio: 0.1, cooldown: '30d' });
    expect(d.trends.map((t) => t.id)).toEqual(['db-time-drift']);
    expect(d.optimizations).toEqual(['dbx/work-mem']);
    expect(set.issues.map((i) => i.key)).toEqual(['dbx/slow-statement']);
    expect(set.lock.packs[0]!.digest).toMatch(/^sha256:/);
  });

  it('用户层追加同一领域的诊断卡并禁用另一张', async () => {
    const layer = `api_version: srenautix.io/pack-layer/v1
target: dbx
extend:
  domains:
    - id: database
      applies_to: [StatefulSet]
      diagnostics:
        - { id: statement-any, card: checks/statement-share, finding: pg.statement_any }
      gates: { min_share: 0.3 }
disable: [domains/database/statement-share]
`;
    const set = await compile({}, [layer]);
    const d = set.domains.get('database')!;
    expect(d.applies_to).toEqual(['Cluster', 'StatefulSet']);
    expect(d.diagnostics.map((x) => x.id)).toEqual(['statement-dominant', 'statement-any']);
    expect(d.contribution).toEqual([]);
    expect(d.gates.min_share).toBe(0.3);
  });

  it('两个包给同一个领域补充内容时按加载顺序合并', async () => {
    const workload = loadBuiltinPacks(PACKS, ['workload']);
    const set = await compilePackSet([...workload, loadPackDir(packDir(), 'test')], { catalog: CATALOG });
    expect(set.domains.get('database')!.packs).toEqual(['dbx']);
  });

  it.each([
    [
      'dbstats 的 column 必须是操作的数值列',
      { signals: SIGNALS.replace('column: total_exec_time_ms', 'column: queryid') },
      /没有数值列 queryid/,
    ],
    [
      'dbstats 信号不能用 statements.text',
      { signals: SIGNALS.replace('expr: statements.top', 'expr: statements.text') },
      /必须是操作名/,
    ],
    [
      'dbstats 参数按操作的 schema 校验',
      { signals: SIGNALS.replace('limit: 20', 'limit: 500') },
      /dbstats 请求不符合契约/,
    ],
    [
      '指标参数必须有 description',
      { domains: DOMAINS.replace(', description: 库名', '') },
      /参数 database：缺少 description/,
    ],
    [
      '指标只能引用 metrics 信号',
      { domains: DOMAINS.replace('signal: db_time', 'signal: stmt_time_rate') },
      /只能引用 metrics/,
    ],
    [
      'applies: goal 的模板必须写 estimate',
      { remediations: REMEDIATIONS.replace(/\n {4}estimate:[\s\S]*?basis: [^\n]*\n/, '\n') },
      /必须写 estimate/,
    ],
    [
      '业务 issue 模板的领域必须一致',
      { issues: ISSUES.replace('domain: database', 'domain: compute') },
      /属于领域 compute/,
    ],
    [
      '诊断卡的 rows_from 必须是卡片的引用',
      { domains: DOMAINS.replace('rows_from: stmt\n          key', 'rows_from: nope\n          key') },
      /rows_from nope 不是卡片/,
    ],
    [
      '按行表达式在卡片的变量上编译',
      { domains: DOMAINS.replace("when: 'last(row) / total > params.min_share'", "when: 'last(row) > unknown_var'") },
      /CEL 不合法/,
    ],
    [
      '领域引用的指标必须存在',
      { domains: DOMAINS.replace('indicators: [dbx/db-time]', 'indicators: [dbx/nope]') },
      /指标 dbx\/nope 不存在/,
    ],
    [
      '趋势按方法检查参数',
      { domains: DOMAINS.replace('method: drift, ratio: 1.25', 'method: slope') },
      /slope 趋势缺少/,
    ],
  ] as Array<[string, Files, RegExp]>)('%s', async (_name, files, pattern) => {
    await lintError(files, pattern);
  });

  it('领域引用的 ops 模板必须是 applies: goal', async () => {
    const err = await compilePackSet(
      [
        ...loadBuiltinPacks(PACKS, ['workload', 'gitops']),
        loadPackDir(
          packDir({
            domains: DOMAINS.replace('optimizations: [dbx/work-mem]', 'optimizations: [gitops/hpa-max-replicas-raise]'),
          }),
          'test',
        ),
      ],
      { catalog: CATALOG },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/不是 applies: goal 的模板/);
  });

  it('事件模板不能写 estimate 与 guard', async () => {
    await lintError({ remediations: REMEDIATIONS.replace('    applies: goal\n', '') }, /只用于 applies 为 goal 的模板/);
  });

  it('metrics 信号写了 dbstats 的字段时拒绝', async () => {
    await lintError(
      {
        signals: SIGNALS.replace(
          'sum(rate(pg_stat_database_xact_commit{$selector}[$rate_window]))',
          'sum(rate(pg_stat_database_xact_commit{$selector}[$rate_window]))\n        column: calls',
        ),
      },
      /只用于 dbstats 信号/,
    );
  });
});

describe('dbstats 夹具的包测试', () => {
  it('在 Prometheus 与 VictoriaMetrics 上通过夹具与自动测试，诊断卡与份额卡按行给出实体', async () => {
    const set = await compile();
    const report = await runPackTests({ set, packs: ['dbx'] });
    const failed = report.cases.filter((c) => !c.passed);
    expect(failed).toEqual([]);
    expect(report.cases.filter((c) => c.kind === 'fixture')).toHaveLength(4);
    expect(report.cases.some((c) => c.kind === 'nodata')).toBe(true);
  });

  it('期望的实体不一致时失败', async () => {
    const set = await compile({ tests: TESTS.replace('{ key: app/2, hit: false }', '{ key: app/2, hit: true }') });
    const report = await runPackTests({ set, packs: ['dbx'] });
    const failed = report.cases.filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toEqual(['一条语句占执行时间的 91%']);
    expect(failed[0]!.failure).toMatch(/app\/2：期望 when 为 true/);
  });
});

// 真实 PostgreSQL 上的夹具：一条重查询与一条轻查询，重查询占执行时间的绝大部分
const SQL_TESTS = `api_version: srenautix.io/pack-test/v1
interval: 1m
input_sql:
  setup:
    - CREATE TABLE events (id bigint, v int)
    - INSERT INTO events SELECT g, g % 7 FROM generate_series(1, 200000) g
  workload:
    - { sql: 'SELECT count(*) FROM events WHERE v = 3', repeat: 15 }
    - { sql: 'SELECT 1', repeat: 15 }
tests:
  - name: 重查询占执行时间的绝大部分
    eval_time: 10m
    card: checks/statement-share
    entity: { kind: Cluster, namespace: shop, name: shop-pg }
    rows: database/statement-share
    expect: { verdict: abnormal, entities: [] }
  - name: 份额上限调到 1 之后为正常
    eval_time: 10m
    card: checks/statement-share
    entity: { kind: Cluster, namespace: shop, name: shop-pg }
    params: { min_share: 1.0 }
    expect: { verdict: normal }
`;

describe('input_sql：夹具在真实 PostgreSQL 上执行', () => {
  const bins = postgresBins();

  it('没有 PostgreSQL 时只有 input_sql 的文件跳过并在报告中列出', async () => {
    const set = await compile({ tests: SQL_TESTS });
    const report = await runPackTests({ set, packs: ['dbx'] });
    expect(report.packs[0]!.skipped).toEqual(['dbstats.yaml']);
    expect(report.cases.filter((c) => c.kind === 'fixture')).toEqual([]);
  });

  it.each(bins)('PostgreSQL（%s）', async (bin) => {
    const pg = await startPostgres(bin);
    try {
      const set = await compile({ tests: SQL_TESTS });
      const report = await runPackTests({ set, packs: ['dbx'], postgres: pg });
      expect(report.cases.filter((c) => !c.passed)).toEqual([]);
      expect(report.cases.filter((c) => c.kind === 'fixture')).toHaveLength(2);
      expect(report.packs[0]!.skipped).toBeUndefined();
    } finally {
      await pg.stop();
    }
  });
});

describe('dbstats 的两次采样与序列', () => {
  const entity = { cluster_id: 'c1', kind: 'Cluster', namespace: 'shop', name: 'shop-pg' };
  const req: DbstatsRequest = { op: 'statements.top', args: { order_by: 'total_exec_time', limit: 5 } };
  const sample = (at: number, total: number): DbstatsSample => ({
    op: 'statements.top',
    sampled_at: new Date(at).toISOString(),
    server_version: '170002',
    rows: [{ queryid: '1', database: 'app', role: 'app', toplevel: true, total_exec_time_ms: total }],
    truncated: false,
  });

  it('第二次采样到最小间隔之后才有速率，之后一直用这两次采样', async () => {
    let now = 1_000_000;
    let reads = 0;
    const reader: DbstatsReader = {
      read: async () => sample(now, 1000 + 1000 * reads++),
    };
    const s = new DbstatsSampler('pg', reader, { minIntervalMs: 300_000, now: () => now });
    await s.prime(entity, req);
    now += 100_000;
    const early = await s.sample(entity, req, true);
    expect(early.previous).toBeNull();
    expect(() => dbstatsSeries('pg', early, 'total_exec_time_ms', true)).toThrow(DbstatsNotReady);
    now += 200_000;
    const ready = await s.sample(entity, req, true);
    expect(dbstatsSeries('pg', ready, 'total_exec_time_ms', true)[0]!.values).toEqual([1000 / 300]);
    now += 1_000_000;
    await s.sample(entity, req, true);
    expect(s.reads).toBe(2);
    // 不需要速率时 60 秒内复用最近一次
    await s.sample(entity, req, false);
    expect(s.reads).toBe(3);
    await s.sample(entity, req, false);
    expect(s.reads).toBe(3);
  });

  it('计数器回绕的行与只在一次采样中出现的行不产生速率', () => {
    const prev = sample(0, 5000);
    const cur = {
      ...sample(600_000, 1000),
      rows: [...sample(600_000, 1000).rows, { ...sample(0, 1).rows[0]!, queryid: '2' }],
    };
    expect(dbstatsSeries('pg', { current: cur, previous: prev }, 'total_exec_time_ms', true)).toEqual([]);
  });

  it('夹具与录制按适配器的语义过滤、排序与截断', () => {
    const rows = [
      { queryid: '1', database: 'app', total_exec_time_ms: 5 },
      { queryid: '2', database: 'app', total_exec_time_ms: 50 },
      { queryid: '3', database: 'other', total_exec_time_ms: 500 },
    ];
    expect(
      applyDbstatsRequest(
        { op: 'statements.top', args: { order_by: 'total_exec_time', limit: 1, database: 'app' } },
        rows,
      ),
    ).toEqual({ rows: [rows[1]], truncated: true });
    expect(
      applyDbstatsRequest(
        { op: 'statements.top', args: { order_by: 'total_exec_time', limit: 5, queryids: ['1', '3'] } },
        rows,
      ).rows.map((r) => r.queryid),
    ).toEqual(['3', '1']);
  });

  it('dbstats 读取可以录制并回放', async () => {
    const inner = new DbstatsOverlay(new LiveDataSource({}), 'pg', async () => ({
      current: sample(600_000, 7000),
      previous: sample(0, 1000),
    }));
    const rec = new RecordingDataSource(inner);
    const live = await rec.dbstats!(entity, req, { at: 600_000, rate: true });
    const snap = rec.snapshot({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, []);
    const replay = new ReplayDataSource(snap);
    expect(await replay.dbstats(entity, req, { at: 999_999, rate: true })).toEqual(live);
    await expect(replay.dbstats(entity, req, { at: 0, rate: false })).rejects.toThrow(/快照未命中/);
  });
});

/** 内存中的仓库：路径 → 内容 */
function memoryRepo(files: Record<string, string>): RepoReader {
  return {
    head: async () => '0'.repeat(40),
    read: async (p) => files[p] ?? null,
    list: async () => Object.keys(files).sort(),
    history: async () => [],
  };
}

const CLUSTER = (workMem: string) => `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: shop-pg
spec:
  postgresql:
    parameters:
      work_mem: ${workMem}
`;

const LAYOUT: RepositoryLayout = { clusters: { path: 'platform/pg/cluster.yaml', format: 'yaml' } };

describe('目标上下文中的修复模板与业务 issue 模板', () => {
  const finding = {
    fingerprint: 'sha256:' + 'a'.repeat(64),
    kind: 'pg.statement_dominant',
    domain: 'database',
    entity: { type: 'pg_statement', key: 'pg_statement:shop-pg/app/abc', display: 'q', labels: { queryid: '12' } },
    component: 'Cluster.postgresql.cnpg.io:shop/shop-pg',
    share: 0.6,
  };
  const goal: GoalTemplateContext = {
    goal: { goal_id: 'g1', revision: 1 },
    finding,
    finding_cards: {},
    gates: { min_share: 0.2 },
  };
  const ctx = (g?: GoalTemplateContext): RemediationContext => ({
    incident: {},
    root: { cluster_id: 'c1', kind: 'Cluster', namespace: 'shop', name: 'shop-pg' },
    cards: {},
    alerts: [],
    ...(g ? { goal: g } : {}),
  });

  it('applies: goal 的模板只在目标上下文中适用，事件模板不在目标上下文中适用', async () => {
    const gitops = loadBuiltinPacks(PACKS, ['workload', 'gitops']);
    const set = await compilePackSet([...gitops, loadPackDir(packDir(), 'test')], { catalog: CATALOG });
    expect(applicableRemediations(set, ctx(goal)).applicable.map((a) => a.key)).toEqual(['dbx/work-mem']);
    expect(applicableRemediations(set, ctx()).applicable.map((a) => a.key)).not.toContain('dbx/work-mem');
    const plan = await planRemediation(set, 'dbx/work-mem', ctx(), { repo: memoryRepo({}), layout: LAYOUT }, null, 0);
    expect(plan).toMatchObject({ kind: 'skipped', code: 'not_applicable' });
  });

  it('生成补丁并给出预期收益；安全约束不成立时以 guard 跳过', async () => {
    const fixed = await compile();
    const target = { repo: memoryRepo({ 'platform/pg/cluster.yaml': CLUSTER('16MB') }), layout: LAYOUT };
    const plan = await planRemediation(fixed, 'dbx/work-mem', ctx(goal), target, null, 0);
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    expect(plan.patch).toContain('+      work_mem: 32MB');
    expect(plan.estimate).toEqual({
      indicator: 'dbx/db-time',
      unit: 'ratio',
      lower: 0.06,
      expected: expect.closeTo(0.18, 10),
      basis: { 'zh-CN': '份额的 10% 到 30%，下界 0.06' },
    });
    expect(plan.verify.guards).toEqual(['dbx/xact']);
    const big = memoryRepo({ 'platform/pg/cluster.yaml': CLUSTER('48MB') });
    const guarded = await planRemediation(fixed, 'dbx/work-mem', ctx(goal), { repo: big, layout: LAYOUT }, null, 0);
    expect(guarded).toMatchObject({ kind: 'skipped', code: 'guard', guard: 'within-range' });
    expect(guarded.kind === 'skipped' && guarded.reason['zh-CN']).toBe('新值 96MB 超过上限 64MB');
  });

  it('业务 issue 模板给出锚点、建议、预期收益与验证计划', async () => {
    const set = await compile();
    expect(applicableIssues(set.issues, goal, 'database').applicable).toEqual(['dbx/slow-statement']);
    expect(applicableIssues(set.issues, goal, 'compute').applicable).toEqual([]);
    const plan = planIssue(set.issues, 'dbx/slow-statement', goal);
    expect(plan).toMatchObject({
      kind: 'issue',
      domain: 'database',
      anchors: [{ kind: 'sql', value: '12' }],
      suggestion: { 'zh-CN': '这条语句占执行时间的 0.6，为过滤列补索引或改写查询' },
      estimate: { indicator: 'dbx/db-time', lower: 0.3, basis: { 'zh-CN': '份额 0.6 × 最小降幅 0.5 = 0.3' } },
      verify: { within: '72h', guards: ['dbx/xact'], cards: [] },
      labels: ['perf'],
    });
    const other = planIssue(set.issues, 'dbx/slow-statement', {
      ...goal,
      finding: { ...finding, kind: 'pg.temp_spill' },
    });
    expect(other).toMatchObject({ kind: 'skipped', code: 'not_applicable' });
  });
});
