import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseIdOf, importSeed, MAX_LOG_LINES_PER_GROUP, NewestTimes } from '../../src/eval/import-seed.js';
import { CaseStore } from '../../src/eval/store.js';

/**
 * 旧版种子导入的规模与 case_id 映射：合成的种子（数据全部虚构）。
 * - 日志：几个单元共用一个日志组、窗口互相重叠，40 万行日志里有大量相同的时间戳；导入只保留每个单元窗口内最新的
 *   MAX_LOG_LINES_PER_GROUP 行，结果与"读完全部行、按时间倒序稳定排序后截取"的参照完全相同。
 * - 内存：导入命令在 96 MiB 的堆上跑完；把窗口内的日志行全部留在内存中的实现，同样的数据在 96 MiB 上内存不足。
 * - case_id：同一根组件、同一个 10 分钟内的不同事件带 ~<序号>，映射为合法的 case_id，原始键留在 label 中；
 *   映射后冲突时报错，不覆盖。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `seed-import-large-${process.pid}`);
const APP = resolve(import.meta.dirname, '../..');
const MIN = 60_000;
const T0 = Date.parse('2026-09-20T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const bucket = (ms: number) => iso(Math.floor(ms / (10 * MIN)) * 10 * MIN).replace('.000Z', 'Z');

const LINES_PER_CALL = 8_000;
const CALLS = 50;

/** 写一个 zstd JSON Lines 文件：逐批压缩成多个帧（zstd 允许帧拼接），生成时不在内存中拼出整个文件 */
function writeJsonl(file: string, records: Iterable<unknown>): void {
  const fd = openSync(file, 'w');
  let batch: string[] = [JSON.stringify({ type: 'header', format: 'cchp-srenautix-seed', version: 1 })];
  const flush = () => {
    writeSync(fd, zstdCompressSync(Buffer.from(`${batch.join('\n')}\n`)));
    batch = [];
  };
  for (const r of records) {
    batch.push(JSON.stringify(r));
    if (batch.length >= 500) {
      flush();
    }
  }
  flush();
  closeSync(fd);
}

interface UnitSpec {
  key: string;
  root: string;
  first: number;
  logFrom: number;
  logTo: number;
}

function unit(u: UnitSpec) {
  const end = u.first + 30 * MIN;
  const alert = {
    id: `alertname="Down",component="${u.root}"@${u.first}`,
    alertname: 'Down',
    component: u.root,
    role: 'cause',
    severity: 'critical',
    status: 'resolved',
    activeAt: u.first,
    firedAt: u.first,
    endedAt: end,
    summary: 'down',
  };
  return {
    type: 'unit',
    unit: u.key,
    origin: 'research',
    incident_key: u.key,
    case_ids: [],
    snapshot_ids: [],
    first_firing_at: iso(u.first),
    end_at: iso(end),
    windows: { W: { from: iso(u.first - 60 * MIN), to: iso(end) }, R: { from: iso(u.first - 30 * MIN), to: iso(end) } },
    incident: {
      key: u.key,
      root: u.root,
      severity: 'critical',
      state: 'resolved',
      firstFiring: u.first,
      endedAt: end,
      alerts: [alert],
      components: [u.root],
      changes: [],
      chain: 'x',
    },
    neighborhood: { seeds: [u.root], components: [{ id: u.root, hops: 0 }] },
    cards: [],
    log_groups: ['big'],
    log_window: { from: iso(u.logFrom), to: iso(u.logTo) },
  };
}

/**
 * 日志调用 i 的第 j 行：时间在 [T0, T0 + 4h) 内来回跳，每个时间戳出现很多次（截断线上的并列行按出现顺序保留）。
 * 每行文本唯一，便于比对。
 */
const lineAt = (i: number, j: number) => ({
  t: T0 + ((i * 7919 + j * 104_729) % (4 * 60 * 4)) * 15_000,
  s: (i + j) % 3,
});

function* logRecords() {
  yield { type: 'log_chunk', unit: 'logs:big', group: 'big', query: '{app="big"}' };
  for (let i = 0; i < CALLS; i++) {
    const lines: Array<[number, number, string]> = [];
    for (let j = 0; j < LINES_PER_CALL; j++) {
      const l = lineAt(i, j);
      lines.push([l.s, l.t, `call ${i} line ${j} ${'x'.repeat(40)}`]);
    }
    yield {
      type: 'call',
      unit: 'logs:big',
      id: `logs:big#${i}`,
      status: 'ok',
      result: { streams: [{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }], lines },
    };
  }
}

const UNITS: UnitSpec[] = [
  // 三个单元共用日志组 big，窗口互相重叠；第一个单元的窗口覆盖全部日志
  {
    key: `big:${bucket(T0 + 3 * 3600_000)}`,
    root: 'big',
    first: T0 + 3 * 3600_000,
    logFrom: T0,
    logTo: T0 + 4 * 3600_000,
  },
  // 同一根组件、同一个 10 分钟内的第二、第三个事件
  {
    key: `big:${bucket(T0 + 3 * 3600_000)}~2`,
    root: 'big',
    first: T0 + 3 * 3600_000 + 2 * MIN,
    logFrom: T0 + 3600_000,
    logTo: T0 + 2 * 3600_000,
  },
  {
    key: `big:${bucket(T0 + 3 * 3600_000)}~3`,
    root: 'big',
    first: T0 + 3 * 3600_000 + 4 * MIN,
    logFrom: T0 + 90 * MIN,
    logTo: T0 + 91 * MIN,
  },
];

function writeSeed(dir: string, units: UnitSpec[], withLogs: boolean): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({ format: 'cchp-srenautix-seed', version: 1, topology: { edges: [] }, knowledge_cases: [] }),
  );
  writeJsonl(join(dir, 'units.jsonl.zst'), units.map(unit));
  writeJsonl(join(dir, 'calls.jsonl.zst'), []);
  if (withLogs) {
    writeJsonl(join(dir, 'logs.jsonl.zst'), logRecords());
  }
}

/** 参照：读完全部行，按时间倒序稳定排序后取最新的 MAX_LOG_LINES_PER_GROUP 行 */
function reference(u: UnitSpec): { lines: string[]; total: number } {
  const all: Array<{ t: number; line: string }> = [];
  for (let i = 0; i < CALLS; i++) {
    for (let j = 0; j < LINES_PER_CALL; j++) {
      const l = lineAt(i, j);
      if (l.t >= u.logFrom && l.t <= u.logTo) {
        all.push({ t: l.t, line: `call ${i} line ${j} ${'x'.repeat(40)}` });
      }
    }
  }
  const sorted = all.sort((a, b) => b.t - a.t);
  return { lines: sorted.slice(0, MAX_LOG_LINES_PER_GROUP).map((x) => x.line), total: all.length };
}

beforeAll(() => {
  writeSeed(join(ROOT, 'seed'), UNITS, true);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('旧版种子导入：规模与 case_id', () => {
  it('case_id：~<序号> 按固定规则改为 .，原始事件键保留在 label；映射后仍不合法时报错', () => {
    expect(caseIdOf('node:2026-10-16T23:20:00Z~2')).toBe('legacy:node:2026-10-16T23:20:00Z.2');
    expect(caseIdOf('node:2026-10-16T23:20:00Z')).toBe('legacy:node:2026-10-16T23:20:00Z');
    expect(() => caseIdOf('bad key with spaces')).toThrow(/无法映射为合法的 case_id/);
  });

  it('截断时间：与参照排序得到的第 limit 个时间戳一致，并列行的保留数正确', () => {
    const n = new NewestTimes(5);
    for (const t of [3, 9, 1, 9, 7, 9, 2, 8, 9]) {
      n.offer(t);
    }
    // 倒序：9 9 9 9 8 | 7 ...，截断线 8，其上有 4 行
    expect(n.cutoff()).toEqual({ at: 8, keepAtCutoff: 1 });
    expect(n.total).toBe(9);
    const few = new NewestTimes(5);
    few.offer(1);
    expect(few.cutoff()).toEqual({ at: -Infinity, keepAtCutoff: Infinity });
    const ties = new NewestTimes(3);
    for (const t of [5, 5, 5, 5, 5]) {
      ties.offer(t);
    }
    expect(ties.cutoff()).toEqual({ at: 5, keepAtCutoff: 3 });
  });

  it('40 万行日志在 96 MiB 的堆上导入；每个单元的日志与参照完全相同', () => {
    const cases = join(ROOT, 'cases');
    const r = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=96',
        '--conditions=@srenautix/source',
        '--import',
        'tsx',
        'src/main.ts',
        'eval',
        'import-seed',
        '--dir',
        join(ROOT, 'seed'),
        '--cases',
        cases,
        '--suite',
        'large',
        '--cluster-id',
        'c1',
      ],
      { cwd: APP, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(r.error, r.error?.message).toBeUndefined();
    expect(r.signal, r.stderr.slice(-2000)).toBeNull();
    expect(r.status, r.stderr.slice(-2000)).toBe(0);

    const store = new CaseStore(cases);
    const all = store.cases();
    expect(all.map((c) => [c.case_id, c.label])).toEqual(
      UNITS.map((u) => [caseIdOf(u.key), u.key]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    );
    for (const u of UNITS) {
      const c = all.find((x) => x.label === u.key)!;
      expect(c.leakage.learned_from_keys).toContain(u.key);
      const snap = store.snapshot(c.snapshot_id as string);
      expect(snap.source.ref).toBe(`cchp-srenautix-seed@1:${u.key}`);
      const logs = snap.queries.entries.filter((e) => e.op === 'logs_query');
      expect(logs).toHaveLength(1);
      const result = logs[0]!.result as {
        lines: Array<{ line: string; labels: Record<string, string> }>;
        truncated: boolean;
      };
      const ref = reference(u);
      expect(result.lines.map((l) => l.line)).toEqual(ref.lines);
      expect(result.truncated).toBe(ref.total > MAX_LOG_LINES_PER_GROUP);
      expect(result.lines[0]!.labels).toMatchObject({ pod: expect.stringMatching(/^[abc]$/) });
    }
    // 第一个单元的窗口覆盖全部日志，被截断；第三个单元的窗口只有 1 分钟，不截断
    expect(reference(UNITS[0]!).total).toBe(CALLS * LINES_PER_CALL);
    expect(reference(UNITS[2]!).total).toBeLessThan(MAX_LOG_LINES_PER_GROUP);
  }, 360_000);

  it('映射后冲突时报错，不覆盖：同一次导入中两个单元，或用例目录中已有另一个单元的用例', async () => {
    const k = `dup:${bucket(T0)}`;
    const both = join(ROOT, 'conflict-seed');
    writeSeed(
      both,
      [
        { key: `${k}~2`, root: 'dup', first: T0, logFrom: T0, logTo: T0 },
        { key: `${k}.2`, root: 'dup', first: T0 + MIN, logFrom: T0, logTo: T0 },
      ],
      false,
    );
    const store = new CaseStore(join(ROOT, 'conflict-cases'));
    await expect(importSeed({ dir: both, suite: 's', clusterId: 'c1', store })).rejects.toThrow(
      /映射到同一个 case_id legacy:dup:.*\.2/,
    );
    expect(store.cases()).toEqual([]);

    // 先导入 ~2，再导入另一份只含 .2 的种子：已有的用例来自另一个单元，不覆盖
    const first = join(ROOT, 'first-seed');
    writeSeed(first, [{ key: `${k}~2`, root: 'dup', first: T0, logFrom: T0, logTo: T0 }], false);
    await importSeed({ dir: first, suite: 's', clusterId: 'c1', store });
    // 同一单元重复导入：覆盖为新内容
    await importSeed({ dir: first, suite: 's', clusterId: 'c1', store });
    const second = join(ROOT, 'second-seed');
    writeSeed(second, [{ key: `${k}.2`, root: 'dup', first: T0 + MIN, logFrom: T0, logTo: T0 }], false);
    await expect(importSeed({ dir: second, suite: 's', clusterId: 'c1', store })).rejects.toThrow(/不覆盖它/);
    expect(store.cases().map((c) => c.label)).toEqual([`${k}~2`]);
  });
});
