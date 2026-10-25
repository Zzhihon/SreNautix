import type { ChangeEvent, MetricSeries } from '@srenautix/contract';
import { TopologyGraph } from '@srenautix/core';
import { DatasourceError } from '@srenautix/integration-sdk';
import type { EvidenceDataSource } from '@srenautix/packs-sdk';
import type pg from 'pg';
import { logger } from '../log.js';
import type { TopologyStore } from '../topology/store.js';
import { managersOf } from './ksm-rollouts.js';
import { ARGOCD_SYNC_QUERY, outOfSyncApplications, PENDING_SYNC_STEP_MS, pendingSyncChanges } from './pending-sync.js';
import { deriveRetirements, PLAN_LOOKBACK_MS, RETIRE_QUERIES, RETIRE_STEP_MS, type RetireSeries } from './retire.js';
import { changesInWindow } from './service.js';

/**
 * server 从指标推导的两类变更信息（ADR 0161）：退役（kube-state-metrics 的副本数与 up 序列）与已合并、尚未同步的提交
 * （argocd_app_info）。事件引擎每次重算都会调用：退役按分钟对齐查询区间并缓存 60 秒；未同步要读 72 小时的序列，
 * 漂移告警本身要持续很久才触发，按 5 分钟对齐并缓存 5 分钟。数据源报错时记日志并跳过这一类，引擎照常用其余变更计算。
 */
export interface MetricsChangesOptions {
  pool: pg.Pool;
  topology: TopologyStore;
  clusterId: string;
  dataSource(at: number): Promise<EvidenceDataSource>;
  retirements: boolean;
  pendingSync: { enabled: boolean; lookbackMs: number };
  groupWithinMs: number;
}

const CACHE_MS = 60_000;
const PENDING_REFRESH_MS = 5 * 60_000;
const QUERY_TIMEOUT_MS = 30_000;
const MAX_SERIES = 20_000;

const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;

export class MetricsChanges {
  private retireCache: { key: string; at: number; out: ChangeEvent[] } | null = null;
  private pendingCache: { key: string; at: number; out: ChangeEvent[] } | null = null;

  constructor(private readonly o: MetricsChangesOptions) {}

  private async range(ds: EvidenceDataSource, expr: string, from: number, to: number, stepMs: number) {
    const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    const r = await ds.queryRange({
      expr,
      dialect: 'promql',
      window,
      step_seconds: stepMs / 1000,
      // 瞬时选择器带默认回看（5 分钟），时钟窗口从区间起点再往前留出这段
      clock_window: { from: new Date(from - 10 * 60_000).toISOString(), to: window.to },
      timeout_ms: QUERY_TIMEOUT_MS,
      max_series: MAX_SERIES,
    });
    if (r.truncated) {
      throw new DatasourceError('metrics', `查询结果超过 ${MAX_SERIES} 条序列：${expr}`);
    }
    return r.series;
  }

  /** [from, to] 内的退役变更；区间按步长对齐，change_id 与退役时刻在重算之间保持不变 */
  async retirements(from: Date, to: Date): Promise<ChangeEvent[]> {
    if (!this.o.retirements) {
      return [];
    }
    const a = floorTo(from.getTime(), RETIRE_STEP_MS);
    const b = floorTo(to.getTime(), RETIRE_STEP_MS);
    const key = `${a}:${b}`;
    if (this.retireCache && this.retireCache.key === key && Date.now() - this.retireCache.at < CACHE_MS) {
      return this.retireCache.out;
    }
    try {
      const ds = await this.o.dataSource(b);
      const entries: Array<[string, MetricSeries[]]> = [];
      for (const [k, q] of Object.entries(RETIRE_QUERIES)) {
        entries.push([k, await this.range(ds, q, a, b, RETIRE_STEP_MS)]);
      }
      const series = Object.fromEntries(entries) as RetireSeries;
      const plans = await changesInWindow(this.o.pool, this.o.clusterId, new Date(a - PLAN_LOOKBACK_MS), new Date(b));
      const out = await deriveRetirements(series, {
        clusterId: this.o.clusterId,
        from: a,
        to: b,
        stepMs: RETIRE_STEP_MS,
        groupWithinMs: this.o.groupWithinMs,
        podOwners: async (at) => {
          const snap = await this.o.topology.at(this.o.clusterId, new Date(at));
          const g = new TopologyGraph(snap.nodes, snap.edges, snap.version);
          return (k) => (g.has(k) ? g.componentOf(k) : null);
        },
        managers: (keys, f, t) => managersOf(this.o.pool, this.o.clusterId, [...keys], new Date(f), new Date(t)),
        plans,
      });
      this.retireCache = { key, at: Date.now(), out };
      return out;
    } catch (e) {
      if (!(e instanceof DatasourceError)) {
        throw e;
      }
      logger.warn('从 kube-state-metrics 推导退役失败，本次不用退役变更', { error: e.message });
      return [];
    }
  }

  /** 到 to 为止已合并、尚未同步的提交（标了 pending_sync），时间不早于 to − 回看 */
  async pendingSync(to: Date): Promise<ChangeEvent[]> {
    if (!this.o.pendingSync.enabled) {
      return [];
    }
    const b = floorTo(to.getTime(), PENDING_REFRESH_MS);
    const a = b - this.o.pendingSync.lookbackMs;
    const key = `${b}`;
    if (this.pendingCache && this.pendingCache.key === key && Date.now() - this.pendingCache.at < PENDING_REFRESH_MS) {
      return this.pendingCache.out;
    }
    try {
      const ds = await this.o.dataSource(b);
      const apps = outOfSyncApplications(
        await this.range(ds, ARGOCD_SYNC_QUERY, a, b, PENDING_SYNC_STEP_MS),
        b,
        PENDING_SYNC_STEP_MS,
      );
      const out = apps.length
        ? pendingSyncChanges(await changesInWindow(this.o.pool, this.o.clusterId, new Date(a), new Date(b)), apps, a, b)
        : [];
      this.pendingCache = { key, at: Date.now(), out };
      return out;
    } catch (e) {
      if (!(e instanceof DatasourceError)) {
        throw e;
      }
      logger.warn('读取 Argo CD 应用的同步状态失败，本次不标出尚未同步的提交', { error: e.message });
      return [];
    }
  }
}
