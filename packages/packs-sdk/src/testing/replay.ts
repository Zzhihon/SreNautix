// srenautix pack test --replay：在录制的查询邻域快照上执行卡片（DESIGN §6.3、§14.2）。
// 快照里没有的请求按"快照未命中"处理（对应引用判为数据源报错），并统计未命中率。

import { loadPromqlEngine, toMillis } from '@srenautix/integration-sdk';
import type { PackSet } from '../pack/compile.js';
import { runCard } from '../runtime/run-card.js';
import { NO_REDACTION } from '../runtime/samples.js';
import { ReplayDataSource, type QuerySnapshot } from '../runtime/snapshot.js';
import { resolveSignal, type SignalResolution } from '../signals/resolve.js';

export interface ReplayCaseResult {
  card: string;
  entity: string;
  expected: string | null;
  verdict: string;
  display_state: string;
  reason: string;
  passed: boolean;
}

export interface ReplayReport {
  snapshot_id: string;
  cases: ReplayCaseResult[];
  miss_rate: number;
  passed: boolean;
}

export async function replaySnapshot(set: PackSet, snap: QuerySnapshot): Promise<ReplayReport> {
  const engine = await loadPromqlEngine();
  const ds = new ReplayDataSource(snap);
  const results: ReplayCaseResult[] = [];
  for (const c of snap.cases) {
    const e = set.cards.get(c.card);
    if (!e) {
      throw new Error(`快照 ${snap.snapshot_id} 引用的卡片 ${c.card} 不在加载的包中`);
    }
    const anchor = toMillis(c.anchor);
    const resolutions = new Map<string, SignalResolution>();
    for (const sk of new Set(Object.values(e.signals))) {
      resolutions.set(
        sk,
        await resolveSignal(sk, set.signals.get(sk)!.signal, ds, engine, snap.clock_window.to, snap.clock_window),
      );
    }
    const r = await runCard({
      set,
      card: c.card,
      entity: c.entity,
      anchor,
      now: toMillis(snap.clock_window.to),
      ds,
      engine,
      resolutions,
      clock: snap.clock_window,
      redact: NO_REDACTION,
    });
    const expected = c.expect?.verdict ?? null;
    const passed =
      (expected === null || r.verdict === expected) &&
      (c.expect?.display_state === undefined || r.display_state === c.expect.display_state);
    results.push({
      card: c.card,
      entity: `${c.entity.kind}/${c.entity.namespace ?? ''}/${c.entity.name}`,
      expected,
      verdict: r.verdict,
      display_state: r.display_state,
      reason: r.reason.text,
      passed,
    });
  }
  return {
    snapshot_id: snap.snapshot_id,
    cases: results,
    miss_rate: ds.missRate(),
    passed: results.every((r) => r.passed),
  };
}
