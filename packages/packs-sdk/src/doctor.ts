// srenautix doctor（DESIGN §4.4）：覆盖情况报告，控制台拓扑页的默认视图就是这张表。
// - 已解析的信号：每个信号选中了哪个备选，没有可用备选时给出每个备选被拒绝的原因；
// - 14 天内未映射的告警名：ALERTS 中出现过、告警目录里没有的告警名；
// - 没有证据链的组件：组件类型与告警目录条目没有关联任何证据链；
// - 覆盖建议：按上面三项给出下一步。

import type { TimeWindow } from '@srenautix/contract';
import { loadPromqlEngine, toIso, toMillis } from '@srenautix/integration-sdk';
import type { PackSet } from './pack/compile.js';
import type { EvidenceDataSource } from './runtime/datasource.js';
import { resolveSignal, type SignalResolution } from './signals/resolve.js';

export interface DoctorReport {
  at: string;
  signals: Array<{ signal: string; pack: string; selected: number | null; rejected: SignalResolution['rejected'] }>;
  unmapped_alerts: Array<{ alertname: string; firing_series: number }>;
  components_without_chains: string[];
  catalog_entries_without_chains: string[];
  suggestions: string[];
}

const DAY = 86_400_000;

export async function runDoctor(
  set: PackSet,
  ds: EvidenceDataSource,
  at: string,
  lookbackDays = 14,
): Promise<DoctorReport> {
  const engine = await loadPromqlEngine();
  const clock: TimeWindow = { from: toIso(toMillis(at) - lookbackDays * DAY - DAY), to: at };

  const signals: DoctorReport['signals'] = [];
  for (const [key, { pack, signal }] of [...set.signals].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = await resolveSignal(key, signal, ds, engine, at, clock);
    signals.push({ signal: key, pack, selected: r.index, rejected: r.rejected });
  }

  const catalog = new Set(set.packs.flatMap((p) => p.content.alerts.entries.map((e) => e.alertname)));
  const fired = await ds.query({
    expr: `count by (alertname) (count_over_time(ALERTS{alertstate="firing"}[${lookbackDays}d]))`,
    dialect: 'promql',
    time: at,
    clock_window: clock,
    timeout_ms: 30_000,
  });
  const unmapped = fired.series
    .map((s) => ({ alertname: s.labels['alertname'] ?? '', firing_series: s.values[0] ?? 0 }))
    .filter((a) => a.alertname && !catalog.has(a.alertname))
    .sort((a, b) => b.firing_series - a.firing_series || (a.alertname < b.alertname ? -1 : 1));

  const componentsWithoutChains = set.packs
    .flatMap((p) =>
      p.content.components.component_types.filter((c) => !(c.chains ?? []).length).map((c) => `${p.name}/${c.id}`),
    )
    .sort();
  const entriesWithoutChains = set.packs
    .flatMap((p) =>
      p.content.alerts.entries
        .filter((e) => !(e.chains ?? []).length && e.role !== 'meta')
        .map((e) => `${p.name}/${e.id}（${e.alertname}）`),
    )
    .sort();

  const suggestions: string[] = [];
  const unresolved = signals.filter((s) => s.selected === null);
  if (unresolved.length) {
    suggestions.push(
      `${unresolved.length} 个信号没有可用备选；对应的卡片会显示"无法判定"。在用户层用 extend 增加适配本环境指标的备选，或安装缺少的 exporter。`,
    );
  }
  if (unmapped.length) {
    suggestions.push(
      `${unmapped.length} 个告警名不在目录中，按表达式分类且没有证据链。用用户层的 extend.alerts 补充条目：${unmapped
        .slice(0, 10)
        .map((a) => a.alertname)
        .join('、')}`,
    );
  }
  if (componentsWithoutChains.length) {
    suggestions.push(`${componentsWithoutChains.length} 个组件类型没有证据链，这些组件成为根因时阶段 A 只有告警本身。`);
  }
  return {
    at,
    signals,
    unmapped_alerts: unmapped,
    components_without_chains: componentsWithoutChains,
    catalog_entries_without_chains: entriesWithoutChains,
    suggestions,
  };
}
