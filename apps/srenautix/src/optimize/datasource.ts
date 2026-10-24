import type { DbstatsRequest, DbstatsSample } from '@srenautix/contract';
import { DatasourceError, type PromqlEngine } from '@srenautix/integration-sdk';
import {
  DbstatsOverlay,
  DbstatsSampler,
  resolveSignal,
  type DbstatsReader,
  type EvidenceDataSource,
  type PackSet,
  type RenderEntity,
  type SignalResolution,
} from '@srenautix/packs-sdk';
import { tryNodeKey } from '@srenautix/core';

// 目标运行的数据源（ADR 0146 §3.1、§3.3）：指标数据源（与阶段 A 共用 VictoriaMetrics 的连接与标签档案）加上 dbstats。
// - dbstats 只连接配置的一个 CNPG Cluster 主库；其他组件上的 dbstats 读取报数据源错误，卡无法判定；
// - 两次采样：每次目标运行一个采样器（DbstatsSampler），同一运行中相隔不少于 300 秒的两次读取得到速率。
//   runner 在运行开始时先执行一遍 dbstats 卡（第一次采样），推迟 300 秒之后再算候选；
// - 信号备选的选择在这里单独缓存（事件研判的数据源没有 dbstats，缓存不能共用）。

const RESOLUTION_TTL_MS = 10 * 60_000;
/** 采样器保留的时长：超过它的运行（已经结束或被放弃）的采样丢弃 */
const SAMPLER_TTL_MS = 2 * 3600_000;

export interface MetricsBase {
  readonly engine: PromqlEngine;
  dataSource(at: number): Promise<EvidenceDataSource>;
}

/** 配置的 dbstats 连接：组件键与读取函数（PostgresDbstatsAdapter.read） */
export interface DbstatsTarget {
  id: string;
  /** 数据库对应的拓扑组件键 */
  cluster: string;
  read(req: DbstatsRequest): Promise<DbstatsSample>;
}

export class GoalSources {
  private readonly resolutions = new Map<string, { at: number; r: SignalResolution }>();
  private readonly samplers = new Map<string, { at: number; sampler: DbstatsSampler }>();

  constructor(
    private readonly base: MetricsBase,
    private readonly db: DbstatsTarget | null,
    private readonly now: () => number = Date.now,
  ) {}

  get engine(): PromqlEngine {
    return this.base.engine;
  }

  /** 是否配置了 dbstats */
  get hasDbstats(): boolean {
    return this.db !== null;
  }

  /** 运行是否已经有第一次采样 */
  primed(run: string): boolean {
    return this.samplers.has(run);
  }

  /** 运行结束：丢弃它的采样 */
  release(run: string): void {
    this.samplers.delete(run);
  }

  private reader(): DbstatsReader {
    const db = this.db as DbstatsTarget;
    return {
      read: async (entity: RenderEntity, req: DbstatsRequest) => {
        const key = tryNodeKey(entity.kind, entity.namespace, entity.name);
        if (key !== db.cluster) {
          throw new DatasourceError(db.id, `dbstats 只连接 ${db.cluster}，不能读取 ${key ?? entity.name}`);
        }
        return db.read(req);
      },
    };
  }

  private sampler(run: string | null): DbstatsSampler {
    const now = this.now();
    for (const [k, v] of this.samplers) {
      if (now - v.at > SAMPLER_TTL_MS) {
        this.samplers.delete(k);
      }
    }
    if (run === null) {
      // 不属于运行的读取（语句文本）：一次性的采样器，没有速率
      return new DbstatsSampler((this.db as DbstatsTarget).id, this.reader(), { now: this.now });
    }
    let s = this.samplers.get(run);
    if (!s) {
      s = { at: now, sampler: new DbstatsSampler((this.db as DbstatsTarget).id, this.reader(), { now: this.now }) };
      this.samplers.set(run, s);
    }
    return s.sampler;
  }

  /** at 时刻的数据源；run 给出时 dbstats 读取用这个运行的采样器 */
  async dataSource(at: number, run: string | null = null): Promise<EvidenceDataSource> {
    const ds = await this.base.dataSource(at);
    if (!this.db) {
      return ds;
    }
    const sampler = this.sampler(run);
    return new DbstatsOverlay(ds, this.db.id, (entity, req, opts) => sampler.sample(entity, req, opts.rate));
  }

  /** 信号键 → 选中的备选（按小时缓存 10 分钟） */
  async resolve(
    set: PackSet,
    keys: Iterable<string>,
    ds: EvidenceDataSource,
    at: number,
  ): Promise<Map<string, SignalResolution>> {
    const out = new Map<string, SignalResolution>();
    const wall = this.now();
    const iso = (t: number) => new Date(t).toISOString();
    const clock = { from: iso(at - 2 * 3600_000), to: iso(at) };
    const hour = Math.floor(at / 3600_000);
    for (const k of keys) {
      const cacheKey = `${k}@${hour}`;
      const hit = this.resolutions.get(cacheKey);
      if (hit && wall - hit.at < RESOLUTION_TTL_MS) {
        out.set(k, hit.r);
        continue;
      }
      const sig = set.signals.get(k);
      if (!sig) {
        continue;
      }
      const r = await resolveSignal(k, sig.signal, ds, this.base.engine, iso(at), clock);
      if (!r.rejected.some((x) => x.reason.startsWith('探测失败'))) {
        this.resolutions.set(cacheKey, { at: wall, r });
      }
      out.set(k, r);
    }
    for (const [key, v] of this.resolutions) {
      if (wall - v.at >= RESOLUTION_TTL_MS) {
        this.resolutions.delete(key);
      }
    }
    return out;
  }
}
