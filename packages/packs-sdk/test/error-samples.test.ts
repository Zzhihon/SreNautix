import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardSamples, PackTestFile } from '@srenautix/contract';
import { backendsDir, LokiAdapter, loadPromqlEngine, startLoki, toIso } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PackLintError } from '../src/cel/errors.js';
import type { LogLine, RefData } from '../src/judge/data.js';
import { compilePackSet, type PackSet } from '../src/pack/compile.js';
import { loadPackDir } from '../src/pack/load.js';
import { LiveDataSource } from '../src/runtime/datasource.js';
import { durationSeconds, runCard } from '../src/runtime/run-card.js';
import { aggregateSamples, compileSamples, NO_REDACTION, samplesTable, type Redactor } from '../src/runtime/samples.js';
import { resolveSignal } from '../src/signals/resolve.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { CATALOG, REPO } from './support.js';

// 错误样例（契约 2.42.0，ADR 0177）：声明的校验、聚合与样例的上限、先脱敏再截断、原因码，
// 以及测试包 llm-gateway 在真实 Loki 上的四类上游错误

const FIXTURE = join(REPO, 'packages/packs-sdk/test/fixtures/llm-gateway');

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** 在 .scratch 下复制测试包，按 edit 修改 chains.yaml */
function packCopy(edit: (chains: string) => string): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'error-samples-'));
  scratch.push(root);
  const dir = join(root, 'llm-gateway');
  cpSync(FIXTURE, dir, { recursive: true });
  const file = join(dir, 'chains.yaml');
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
  return dir;
}

const compile = (dir: string) => compilePackSet([loadPackDir(dir, 'test')], { catalog: CATALOG });

const REFS = [
  { name: 'errors', mode: 'logs' },
  { name: 'rate', mode: 'range' },
];

const SPEC: CardSamples = {
  ref: 'errors',
  dimensions: [
    { name: 'upstream', label: 'upstream' },
    { name: 'status', label: 'status' },
    { name: 'candidates', regex: 'candidates=(\\d+)' },
  ],
  classes: [
    { id: 'quota', title: { 'zh-CN': '配额耗尽', en: 'Quota' }, match: [{ dimension: 'status', regex: '^429$' }] },
    {
      id: 'unavailable',
      title: { 'zh-CN': '不可用', en: 'Unavailable' },
      match: [{ dimension: 'status', regex: '^503$' }, { regex: 'upstream returned' }],
    },
  ],
  per_class: 2,
  max_chars: 80,
  max_groups: 2,
};

/** 测试用的脱敏规则：token= 之后的值替换掉，计替换处数 */
const redact: Redactor = (text) => {
  let hits = 0;
  const out = text.replace(/token=[A-Za-z0-9]+/g, () => {
    hits++;
    return 'token=[REDACTED]';
  });
  return { text: out, hits };
};

const T = Date.parse('2026-03-01T00:00:00Z');
const line = (min: number, labels: Record<string, string>, text: string): LogLine => ({
  time: T + min * 60_000,
  labels,
  line: text,
});

describe('错误样例的声明', () => {
  const bad =
    (spec: Partial<CardSamples>, egress: 'allow' | 'redact' = 'redact') =>
    () =>
      compileSamples({ ...SPEC, ...spec }, REFS, egress);

  it('引用必须是卡片中的日志引用，卡片不能原样出境', () => {
    expect(bad({ ref: 'nope' })).toThrow(/不是卡片中的引用/);
    expect(bad({ ref: 'rate' })).toThrow(/必须是 logs/);
    expect(bad({}, 'allow')).toThrow(/egress 必须是 redact 或 never/);
  });

  it('维度 label 与 regex 二选一、正则要有捕获组、名字不重复；类别 id 不重复且不是 other，条件只引用声明过的维度', () => {
    expect(bad({ dimensions: [{ name: 'a', label: 'x', regex: '(x)' }] })).toThrow(/二选一/);
    expect(bad({ dimensions: [{ name: 'a' }] })).toThrow(/二选一/);
    expect(bad({ dimensions: [{ name: 'a', regex: 'x' }] })).toThrow(/没有捕获组/);
    expect(bad({ dimensions: [{ name: 'a', regex: '(' }] })).toThrow(/正则不合法/);
    expect(
      bad({
        dimensions: [
          { name: 'a', label: 'x' },
          { name: 'a', label: 'y' },
        ],
      }),
    ).toThrow(/维度 a 重复/);
    expect(bad({ classes: [{ id: 'other', title: { en: 'x' }, match: [{ regex: 'x' }] }] })).toThrow(/保留/);
    expect(
      bad({
        classes: [
          { id: 'q', title: { en: 'x' }, match: [{ regex: 'x' }] },
          { id: 'q', title: { en: 'y' }, match: [{ regex: 'y' }] },
        ],
      }),
    ).toThrow(/类别 q 重复/);
    expect(bad({ classes: [{ id: 'q', title: { en: 'x' }, match: [{ dimension: 'zone', regex: 'x' }] }] })).toThrow(
      /没有声明的维度 zone/,
    );
  });

  it('加载领域包时同样校验：原样出境的卡与非日志引用加载失败', async () => {
    await expect(compile(packCopy((c) => c.replace('egress: redact', 'egress: allow')))).rejects.toThrow(PackLintError);
    await expect(compile(packCopy((c) => c.replace('ref: errors', 'ref: any_missing')))).rejects.toThrow(
      /samples：ref any_missing 不是卡片中的引用/,
    );
  });
});

describe('聚合', () => {
  const c = compileSamples(SPEC, REFS, 'redact');
  const a = { upstream: 'provider-a', status: '429' };
  const b = { upstream: 'provider-b', status: '429' };
  const u = { upstream: 'provider-c', status: '503' };
  const lines: LogLine[] = [
    ...Array.from({ length: 5 }, (_, i) => line(i, a, `upstream returned 429 attempt ${i}`)),
    ...Array.from({ length: 3 }, (_, i) => line(10 + i, b, `upstream returned 429 from b ${i}`)),
    line(20, u, 'upstream returned 503 candidates=1'),
    line(21, u, 'gateway gave up candidates=1'),
    line(22, { upstream: 'provider-c', status: '500' }, 'upstream returned 500'),
  ];
  const data: RefData = { kind: 'logs', lines, truncated: true };

  it('按维度组合与类别计数，首末时间取组合内最早与最晚的行；组合按行数取前 max_groups 个，其余计数', () => {
    const s = aggregateSamples(c, data, NO_REDACTION);
    expect(s).toMatchObject({ ref: 'errors', code: null, lines: 11, truncated: true, redactions: 0 });
    expect(s.dimensions).toEqual(['upstream', 'status', 'candidates']);
    expect(s.groups).toEqual([
      {
        dimensions: { upstream: 'provider-a', status: '429', candidates: null },
        class: 'quota',
        count: 5,
        first_at: toIso(T),
        last_at: toIso(T + 4 * 60_000),
      },
      {
        dimensions: { upstream: 'provider-b', status: '429', candidates: null },
        class: 'quota',
        count: 3,
        first_at: toIso(T + 10 * 60_000),
        last_at: toIso(T + 12 * 60_000),
      },
    ]);
    expect(s.groups_omitted).toBe(3);
    // 类别按行数排列；条件全部成立才命中，503 但不是上游返回的那一行归入 other
    expect(s.classes.map((k) => [k.class, k.count])).toEqual([
      ['quota', 8],
      ['other', 2],
      ['unavailable', 1],
    ]);
    expect(s.classes.find((k) => k.class === 'other')!.title).toBeNull();
  });

  it('每个类别最多 per_class 条样例：先轮流取不同的维度组合，每个组合从新到旧', () => {
    const s = aggregateSamples(c, data, NO_REDACTION);
    const quota = s.classes.find((k) => k.class === 'quota')!;
    expect(quota.samples.map((m) => m.text)).toEqual([
      'upstream returned 429 attempt 4',
      'upstream returned 429 from b 2',
    ]);
    expect(quota.samples[0]!.dimensions).toEqual({ upstream: 'provider-a', status: '429', candidates: null });
    const unavailable = s.classes.find((k) => k.class === 'unavailable')!;
    expect(unavailable.samples[0]).toMatchObject({ dimensions: { candidates: '1' }, cut: false });
  });

  it('先脱敏再截断：跨过截断位置的凭证同样被替换，替换处数计入 redactions', () => {
    const secret = 'token=Abcdefghijklmnop0123456789';
    const long = `${'x'.repeat(70)} ${secret} tail`;
    const s = aggregateSamples(
      c,
      { kind: 'logs', lines: [line(0, { upstream: `u ${secret}`, status: '429' }, long)], truncated: false },
      redact,
    );
    const sample = s.classes[0]!.samples[0]!;
    expect(sample.cut).toBe(true);
    expect(Array.from(sample.text)).toHaveLength(81);
    expect(sample.text.endsWith('…')).toBe(true);
    expect(sample.text).not.toContain('Abc');
    expect(s.groups[0]!.dimensions.upstream).toBe('u token=[REDACTED]');
    // 维度值一处，样例一处
    expect(s.redactions).toBe(2);
  });

  it('能力缺失、数据源报错与超时给出原因码，聚合为空；零行时没有原因码', () => {
    expect(aggregateSamples(c, { kind: 'capability_missing', capability: 'logs.query' }, NO_REDACTION).code).toBe(
      'samples_capability_missing',
    );
    expect(aggregateSamples(c, { kind: 'error', message: 'HTTP 500' }, NO_REDACTION).code).toBe('samples_source_error');
    const timeout = aggregateSamples(c, { kind: 'error', message: 'timeout', timeout: true }, NO_REDACTION);
    expect(timeout).toMatchObject({ code: 'samples_timeout', lines: 0, groups: [], classes: [] });
    expect(aggregateSamples(c, { kind: 'logs', lines: [], truncated: false }, NO_REDACTION)).toMatchObject({
      code: null,
      lines: 0,
      classes: [],
    });
  });

  it('维度组合写成表格：维度标题或名字、类别标题、行数（limit 截断时加 ≥）与首末时间', () => {
    const s = aggregateSamples(c, data, NO_REDACTION);
    const t = samplesTable(c, s, 'zh-CN');
    expect(t.head).toEqual(['upstream', 'status', 'candidates', '错误类别', '行数', '首次', '末次']);
    expect(t.rows[0]).toEqual([
      'provider-a',
      '429',
      '-',
      '配额耗尽',
      '≥5',
      '2026-03-01 00:00:00',
      '2026-03-01 00:04:00',
    ]);
  });
});

describe('测试包 llm-gateway', () => {
  let set: PackSet;
  let loki: Awaited<ReturnType<typeof startLoki>>;
  const BASE = Math.floor(Date.now() / 60_000) * 60_000 - 8 * 3600_000;
  const file = parse(readFileSync(join(FIXTURE, 'tests/upstream-errors.yaml'), 'utf8')) as PackTestFile;

  beforeAll(async () => {
    set = await compile(FIXTURE);
    loki = await startLoki(
      (file.input_logs ?? []).map((s) => ({
        labels: s.labels as Record<string, string>,
        lines: s.lines.map((l) => ({ t: BASE + durationSeconds(l.offset) * 1000, line: l.line })),
      })),
    );
  }, 300_000);

  afterAll(async () => {
    await loki?.stop();
  });

  it('pack test 在真实 Loki 上通过：四类上游错误的类别行数与 expect.samples 一致', async () => {
    const report = await runPackTests({ set, packs: ['llm-gateway'] });
    const fixtures = report.cases.filter((x) => x.kind === 'fixture');
    expect(fixtures.map((x) => [x.name, x.failure])).toEqual(file.tests.map((t) => [t.name, null]));
    expect(report.cases.filter((x) => !x.passed)).toEqual([]);
  }, 600_000);

  it('expect.samples 不符时测试失败并写明类别与行数', async () => {
    const dir = packCopy((c) => c);
    const tests = join(dir, 'tests/upstream-errors.yaml');
    writeFileSync(tests, readFileSync(tests, 'utf8').replace('quota_exhausted: 12', 'quota_exhausted: 11'));
    const report = await runPackTests({ set: await compile(dir), packs: ['llm-gateway'] });
    const failed = report.cases.find((x) => x.name === '配额耗尽持续返回 429')!;
    expect(failed.passed).toBe(false);
    expect(failed.failure).toContain('错误类别 quota_exhausted 期望 11 行，实际 12 行');
  }, 600_000);

  it('runCard：维度取自 logfmt 标签与正则，类别按声明顺序，样例截断到 max_chars，表格列出维度组合', async () => {
    const ds = new LiveDataSource({
      logs: {
        adapter: new LokiAdapter({
          id: 'loki',
          url: loki.url,
          labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
        }),
        profile: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
      },
    });
    const engine = await loadPromqlEngine();
    const card = set.cards.get('llm-gateway/gateway-errors/samples')!;
    const clock = { from: toIso(BASE - 24 * 3600_000), to: toIso(BASE + 24 * 3600_000) };
    const resolutions = new Map(
      await Promise.all(
        Object.values(card.signals).map(
          async (k) =>
            [
              k,
              await resolveSignal(k, set.signals.get(k)!.signal, ds, engine, toIso(BASE + 400 * 60_000), clock),
            ] as const,
        ),
      ),
    );
    const run = (min: number) =>
      runCard({
        set,
        card: card.key,
        entity: { cluster_id: 't', kind: 'Deployment', namespace: 'llm', name: 'api-gateway', node: null },
        anchor: BASE + min * 60_000,
        now: BASE + 24 * 3600_000,
        ds,
        engine,
        resolutions,
        clock,
        redact: NO_REDACTION,
        locale: 'zh-CN',
      });

    const timeout = await run(308);
    expect(timeout.verdict).toBe('abnormal');
    const s = timeout.samples!;
    expect(s.groups).toEqual([
      {
        dimensions: {
          upstream: 'provider-d',
          model: 'model-w',
          status: '503',
          code: 'first_content_timeout',
          candidates: '1',
        },
        class: 'first_content_timeout',
        count: 6,
        first_at: toIso(BASE + 301 * 60_000),
        last_at: toIso(BASE + 306 * 60_000),
      },
    ]);
    const k = s.classes[0]!;
    expect(k).toMatchObject({ class: 'first_content_timeout', count: 6, title: { 'zh-CN': '首内容超时' } });
    expect(k.samples).toHaveLength(2);
    expect(k.samples[0]!.at).toBe(toIso(BASE + 306 * 60_000));
    expect(k.samples[0]!.cut).toBe(true);
    expect(Array.from(k.samples[0]!.text)).toHaveLength(161);
    // 没有声明 display.table：维度组合写成卡片的表格
    expect(timeout.table!.head).toEqual([
      '上游',
      '模型',
      '状态码',
      '错误码',
      '候选数',
      '错误类别',
      '行数',
      '首次',
      '末次',
    ]);
    expect(timeout.table!.rows[0]!.slice(0, 7)).toEqual([
      'provider-d',
      'model-w',
      '503',
      'first_content_timeout',
      '1',
      '首内容超时',
      '6',
    ]);

    const mismatch = (await run(112)).samples!;
    expect(mismatch.classes.map((x) => [x.class, x.count])).toEqual([
      ['capability_mismatch', 6],
      ['origin_timeout', 4],
    ]);
  }, 300_000);

  it('声明了错误样例的卡执行时必须提供脱敏函数', async () => {
    const ds = new LiveDataSource({});
    await expect(
      runCard({
        set,
        card: 'llm-gateway/gateway-errors/samples',
        entity: { cluster_id: 't', kind: 'Deployment', namespace: 'llm', name: 'api-gateway', node: null },
        anchor: BASE,
        now: BASE + 3600_000,
        ds,
        engine: await loadPromqlEngine(),
        resolutions: new Map(),
        clock: { from: toIso(BASE - 3600_000), to: toIso(BASE + 3600_000) },
      }),
    ).rejects.toThrow(/必须提供脱敏函数/);
  });
});
