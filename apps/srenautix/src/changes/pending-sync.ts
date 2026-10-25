import type { ChangeEvent, MetricSeries } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';

// 已合并、尚未同步的提交（ADR 0161）：Argo CD 应用处于 OutOfSync 时，从它最后一次 Synced 起合并的、触及它的 Git 提交
// 就是 Git 与集群之间的差异。应用漂移类告警（ArgoCDManualAppDrift 之类）要持续很久才触发，这些提交早已离开变更窗口，
// 按时间关联不到；这里给提交标出 pending_sync，事件引擎把它们列进应用上的告警所在的事件。
// 状态取自 Argo CD 的 argocd_app_info（sync_status 标签）。server 与 eval 的重建用同一个查询与同一组函数。

/** 区间查询（步长 PENDING_SYNC_STEP_MS），覆盖 [at − 回看, at] */
export const ARGOCD_SYNC_QUERY = 'max by (namespace, name, sync_status) (argocd_app_info)';

export const PENDING_SYNC_STEP_MS = 60_000;
export const DEFAULT_PENDING_SYNC_LOOKBACK_MS = 72 * 3600_000;
/**
 * 提交合并到 Argo CD 发现差异之间的时间：应用默认每 3 分钟比较一次 Git。最后一个 Synced 样本之前这么久之内合并的提交，
 * 当时可能还没有被发现，仍算没有同步
 */
export const ARGOCD_REFRESH_TOLERANCE_MS = 3 * 60_000;

export interface AppSyncState {
  /** Application.argoproj.io:<namespace>/<name> */
  application: string;
  /** 最后一个 Synced 样本的时刻；回看范围内一直没有 Synced 时为 null */
  lastSynced: number | null;
  /** 之后第一个 OutOfSync 样本的时刻；lastSynced 为 null 时也为 null */
  outOfSyncSince: number | null;
}

/** 在 at（最近两个步长内有样本）处于 OutOfSync 的应用 */
export function outOfSyncApplications(series: readonly MetricSeries[], at: number, stepMs: number): AppSyncState[] {
  const byApp = new Map<string, Map<string, MetricSeries>>();
  for (const s of series) {
    const { namespace, name, sync_status: status } = s.labels;
    const key = namespace && name ? tryNodeKey('Application.argoproj.io', namespace, name) : null;
    if (!key || !status) {
      continue;
    }
    const m = byApp.get(key) ?? new Map<string, MetricSeries>();
    m.set(status, s);
    byApp.set(key, m);
  }
  const ones = (s: MetricSeries | undefined) =>
    s ? s.times.filter((t, i) => t <= at && s.values[i] !== null && s.values[i]! >= 1) : [];
  const out: AppSyncState[] = [];
  for (const [application, m] of [...byApp].sort(([a], [b]) => a.localeCompare(b))) {
    const out1 = ones(m.get('OutOfSync'));
    const synced = ones(m.get('Synced'));
    const lastOut = out1.length ? out1[out1.length - 1]! : null;
    const lastSynced = synced.length ? synced[synced.length - 1]! : null;
    if (lastOut === null || lastOut < at - 2 * stepMs || (lastSynced !== null && lastSynced >= lastOut)) {
      continue;
    }
    out.push({
      application,
      lastSynced,
      outOfSyncSince: lastSynced === null ? null : (out1.find((t) => t > lastSynced) ?? null),
    });
  }
  return out;
}

/**
 * 变更源的变更（Git 提交）中，触及未同步应用、并且在应用最后一次 Synced 之前 ARGOCD_REFRESH_TOLERANCE_MS 之后合并的
 * （没有 Synced 时为回看范围内的），标上 pending_sync；只返回标上的变更。提交时间晚于 at 的不算
 */
export function pendingSyncChanges(
  changes: readonly ChangeEvent[],
  apps: readonly AppSyncState[],
  lookbackStart: number,
  at: number,
): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (const c of changes) {
    const t = Date.parse(c.time);
    if (c.source === 'kubernetes' || c.kind === 'runtime_config' || t > at) {
      continue;
    }
    const pending = apps.filter(
      (a) => c.targets.includes(a.application) && t >= (a.lastSynced ?? lookbackStart) - ARGOCD_REFRESH_TOLERANCE_MS,
    );
    if (pending.length) {
      out.push({
        ...c,
        pending_sync: pending.map((a) => ({
          application: a.application,
          out_of_sync_since: a.outOfSyncSince === null ? null : new Date(a.outOfSyncSince).toISOString(),
        })),
      });
    }
  }
  return out;
}

/** 变更列表合并：同一个 change_id 以 extra 中的（标了 pending_sync 的）为准，结果按时间排序 */
export function mergeChanges(base: readonly ChangeEvent[], extra: readonly ChangeEvent[]): ChangeEvent[] {
  const byId = new Map(base.map((c) => [c.change_id, c]));
  for (const c of extra) {
    byId.set(c.change_id, c);
  }
  return [...byId.values()].sort((a, b) => a.time.localeCompare(b.time) || a.change_id.localeCompare(b.change_id));
}
