import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importSeed, stableUuid } from '../../src/eval/import-seed.js';
import { deriveAbstain, replayCase } from '../../src/eval/leakage.js';
import { CaseStore } from '../../src/eval/store.js';
import { SnapshotTools } from '../../src/eval/vcr.js';
import { T, writeSeedFixture } from '../support/seed-fixture.js';

const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `seed-import-${process.pid}`);
const SEED = join(ROOT, 'seed');
const CASES = join(ROOT, 'cases');

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeSeedFixture(SEED);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('旧版种子导入', () => {
  it('每个单元一个用例与快照；有知识条目的单元带标准答案；没有根组件的单元跳过', async () => {
    const store = new CaseStore(CASES);
    const s = await importSeed({ dir: SEED, suite: 'reference', clusterId: 'ref', store });
    expect(s).toMatchObject({ units: 2, cases: 2, labeled: 1, unlabeled: 1 });
    expect(s.skipped.map((x) => x.unit)).toEqual(['case:2026-08-01-old']);
    const cases = store.cases();
    expect(cases.map((c) => [c.suite, c.truth.root_components])).toEqual([
      ['reference-unlabeled', []],
      ['reference', ['legacy.component:db']],
    ]);
  });

  it('事件、证据卡、拓扑与标准答案的映射', () => {
    const store = new CaseStore(CASES);
    const c = store.cases('reference')[0];
    expect(c).toBeDefined();
    if (!c) {
      return;
    }
    expect(c).toMatchObject({
      truth_source: { kind: 'knowledge', ref: '2026-09-10-db-disk-full' },
      started_at: new Date(T).toISOString(),
    });
    const snap = store.snapshot(c.snapshot_id as string);
    const inc = snap.context.incident;
    expect(inc.root.component).toBe('legacy.component:db');
    expect(inc.label).toBe('legacy.component:db:2026-09-10T08:00:00Z');
    expect(inc.members.map((m) => [m.role, m.component])).toEqual([
      ['cause', 'legacy.component:db'],
      ['symptom', 'legacy.component:api'],
    ]);
    expect(inc.changes[0]).toMatchObject({ kind: 'ci_deploy', targets: ['legacy.component:web'] });
    const cards = snap.context.stage_a.cards;
    expect(cards.map((x) => [x.card_id, x.entity?.name, x.verdict])).toEqual([
      ['legacy/db-disk/1', 'db', 'abnormal'],
      ['legacy/runtime/1', 'api', 'abnormal'],
      ['legacy/runtime/1', 'web', 'normal'],
      ['legacy/checks/node_disk', 'node', 'undeterminable'],
    ]);
    // 异常卡的异常起始时间取所在告警的 activeAt
    expect(cards[0]?.anomaly_started_at).toBe(new Date(T).toISOString());
    expect(cards[2]?.anomaly_started_at).toBeNull();
    expect(snap.context.subgraph.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      'legacy.component:api->legacy.component:db',
      'legacy.component:db->legacy.component:node',
      'legacy.component:web->legacy.component:api',
    ]);
    expect(c.leakage.learned_from_keys).toContain('2026-09-10-db-disk-full');
    expect(c.leakage.exclude_incident_ids).toContain(stableUuid('knowledge', '2026-09-10-db-disk-full'));
  });

  it('查询快照：调用、日志块（只取窗口内的行）、原始序列；没有对应能力的调用不导入', () => {
    const store = new CaseStore(CASES);
    const c = store.cases('reference')[0];
    const snap = store.snapshot(c?.snapshot_id as string);
    const ops = snap.queries.entries.map((e) => e.op);
    expect(ops).toEqual(['query_range', 'query', 'logs_query', 'logs_query', 'query_range']);
    expect(snap.queries.entries[1]?.error).toMatchObject({ kind: 'datasource', message: 'HTTP 503' });
    const logChunk = snap.queries.entries[3]?.result as unknown as { lines: Array<{ line: string }> };
    expect(logChunk.lines.map((l) => l.line)).toEqual([
      'PANIC: could not write to file "pg_wal/xlogtemp": No space left on device',
      'checkpoint starting: wal',
    ]);
    const raw = snap.queries.entries[4];
    expect(raw?.request).toMatchObject({ expr: 'volume_used_ratio', step_seconds: 300 });
  });

  it('防泄漏：本用例的知识条目与参考案例被排除，更早已解决的案例保留', () => {
    const store = new CaseStore(CASES);
    const c = store.cases('reference')[0];
    if (!c) {
      return;
    }
    const { rc, excluded } = replayCase(c, store.snapshot(c.snapshot_id as string));
    expect(rc.knowledge.map((k) => k.id)).toEqual(['legacy/2026-08-01-old']);
    expect(rc.cases.map((x) => x.root_component)).toEqual(['legacy.component:api']);
    expect(rc.feedback).toEqual([]);
    expect(excluded.map((x) => x.kind).sort()).toEqual(['feedback', 'feedback', 'pack_knowledge', 'retrieved_case']);
  });

  it('VCR 工具：相同查询且录制范围覆盖请求时命中并裁剪；其余为未命中', async () => {
    const store = new CaseStore(CASES);
    const c = store.cases('reference')[0];
    const snap = store.snapshot(c?.snapshot_id as string);
    const vcr = new SnapshotTools(snap);
    const [range, , logs] = vcr.tools();
    const ctx = {
      bounds: { from: Date.parse(snap.window.from), to: Date.parse(snap.window.to) },
      signal: new AbortController().signal,
    };
    expect(range?.description).toContain('volume_used_ratio{pvc="data-db-0"}');
    const hit = await range?.run(
      {
        query: 'volume_used_ratio{pvc="data-db-0"}',
        start: new Date(T - 10 * 60_000).toISOString(),
        end: new Date(T).toISOString(),
      },
      ctx,
    );
    expect(JSON.parse(hit?.text as string).result[0].points).toHaveLength(11);
    const miss = await range?.run(
      { query: 'up', start: new Date(T - 600_000).toISOString(), end: new Date(T).toISOString() },
      ctx,
    );
    expect(miss?.text).toContain('unavailable');
    const l = await logs?.run(
      {
        query: '{app="db"}',
        start: new Date(T - 3600_000).toISOString(),
        end: new Date(T + 30 * 60_000).toISOString(),
      },
      ctx,
    );
    expect(l?.text).toContain('No space left on device');
    expect(vcr.missRate()).toBeCloseTo(1 / 3);
  });

  it('abstain 用例：去掉根因组件上的异常卡', () => {
    const store = new CaseStore(CASES);
    const c = store.cases('reference')[0];
    if (!c) {
      return;
    }
    const d = deriveAbstain(
      c,
      store.snapshot(c.snapshot_id as string),
      '00000000-0000-4000-8000-0000000000ab',
      new Date().toISOString(),
    );
    expect(d?.c).toMatchObject({
      type: 'abstain',
      truth: { disposition: 'undetermined', forbid_evidence_consistent: true },
      derived_from: { removed_cards: ['legacy/db-disk/1'] },
    });
    expect(d?.s.context.stage_a.cards.map((x) => x.card_id)).toEqual([
      'legacy/runtime/1',
      'legacy/runtime/1',
      'legacy/checks/node_disk',
    ]);
    const s2 = new CaseStore(join(ROOT, 'abstain'));
    s2.writeCase(d?.c as never);
    s2.writeSnapshot(d?.s as never);
  });
});
