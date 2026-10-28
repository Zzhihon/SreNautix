// 录制查询邻域：在真实数据源上执行一组卡片，把每个请求与结果写进快照，供 pack test --replay 与评测回放使用。

import type { TimeWindow } from '@srenautix/contract';
import { loadPromqlEngine, toIso, toMillis } from '@srenautix/integration-sdk';
import type { PackSet } from '../pack/compile.js';
import type { EvidenceDataSource } from '../runtime/datasource.js';
import { durationSeconds, DEFAULT_WINDOW, runCard } from '../runtime/run-card.js';
import { NO_REDACTION } from '../runtime/samples.js';
import { RecordingDataSource, type QuerySnapshot, type SnapshotCase } from '../runtime/snapshot.js';
import { resolveSignal, type SignalResolution } from '../signals/resolve.js';

/** 时钟窗口覆盖全部卡片的窗口，再向前留出 1 天给区间与回看 */
function clockFor(set: PackSet, cases: SnapshotCase[]): TimeWindow {
  let from = Infinity;
  let to = -Infinity;
  for (const c of cases) {
    const e = set.cards.get(c.card);
    if (!e) {
      throw new Error(`没有卡片 ${c.card}`);
    }
    const w = e.def.window ?? DEFAULT_WINDOW;
    const anchor = toMillis(c.anchor);
    from = Math.min(from, anchor - durationSeconds(w.before) * 1000);
    to = Math.max(to, anchor + durationSeconds(w.after) * 1000);
  }
  return { from: toIso(from - 86_400_000), to: toIso(to) };
}

export async function recordSnapshot(
  set: PackSet,
  live: EvidenceDataSource,
  cases: SnapshotCase[],
): Promise<QuerySnapshot> {
  const engine = await loadPromqlEngine();
  const rec = new RecordingDataSource(live);
  const clock = clockFor(set, cases);
  const out: SnapshotCase[] = [];
  for (const c of cases) {
    const e = set.cards.get(c.card)!;
    const resolutions = new Map<string, SignalResolution>();
    for (const sk of new Set(Object.values(e.signals))) {
      resolutions.set(sk, await resolveSignal(sk, set.signals.get(sk)!.signal, rec, engine, clock.to, clock));
    }
    const r = await runCard({
      set,
      card: c.card,
      entity: c.entity,
      anchor: toMillis(c.anchor),
      now: toMillis(clock.to),
      ds: rec,
      engine,
      resolutions,
      clock,
      redact: NO_REDACTION,
      controlSeed: 'record',
    });
    // 没有给期望时，以录制时的结论作为期望，回放必须得出同样的结论
    out.push({ ...c, expect: c.expect ?? { verdict: r.verdict, display_state: r.display_state } });
  }
  return rec.snapshot(clock, out);
}
