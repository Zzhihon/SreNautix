import { createHash } from 'node:crypto';
import type { ChangeEvent, MetricSeries } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';

// 退役（ADR 0161）：工作负载被删除或副本缩到 0 并保持，是一次变更。抓取目标随之消失时，报"抓取 job 没有目标"的告警
// （ObservabilityScrapeJobVanished 之类）落在不在拓扑里的抓取 job 上，按拓扑关系连不到任何变更；退役变更把这些 job 写进
// scrape_jobs，并按触及的 GitOps 应用找到之前合并的 Git 提交，标出计划内的退役。
// 数据来自 kube-state-metrics 的副本数与 up 序列：拓扑事件里删除的工作负载可能被 informer 的重新列举补回来，也看不出副本数。
// server 与 eval 的重建用同一组查询与同一个 deriveRetirements。

/** 区间查询（步长 RETIRE_STEP_MS）。副本数的序列在工作负载删除后消失，缩到 0 后取值为 0 */
export const RETIRE_QUERIES = {
  deployment: 'max by (namespace, deployment) (kube_deployment_spec_replicas)',
  statefulset: 'max by (namespace, statefulset) (kube_statefulset_replicas)',
  daemonset: 'max by (namespace, daemonset) (kube_daemonset_status_desired_number_scheduled)',
  /** 抓取目标是 Pod 的 up 序列 */
  targets: 'max by (job, namespace, pod) (up{pod!=""})',
} as const;

export type RetireSeries = Record<keyof typeof RETIRE_QUERIES, MetricSeries[]>;

export const RETIRE_STEP_MS = 60_000;

const KINDS = { deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet' } as const;

/** 序列消失后至少这么久才算删除：kube-state-metrics 换 Pod、抓取偶尔失败时序列会短暂中断 */
export const RETIRE_SETTLE_MS = 5 * 60_000;
/** 抓取 job 的目标在退役之前这段时间内都属于被退役的工作负载，才算随退役失去目标 */
export const SCRAPE_LOOKBACK_MS = 3600_000;
/** 退役的计划依据：退役之前这段时间内的 Git 提交 */
export const PLAN_LOOKBACK_MS = 24 * 3600_000;
/** 管理应用取退役之前这段时间内有效的 managed_by 边（应用可能先于工作负载被删除） */
export const MANAGER_LOOKBACK_MS = 3600_000;

export interface RetireContext {
  clusterId: string;
  /** 只取在 [from, to] 内退役的工作负载；序列取到 to 为止 */
  from: number;
  to: number;
  stepMs: number;
  groupWithinMs: number;
  /** 时刻 at 的拓扑：Pod 所属的工作负载（沿 owned_by 取到顶层），不在拓扑里时为 null */
  podOwners(at: number): Promise<(podKey: string) => string | null>;
  /** 这些对象在 [from, to] 内有效的 managed_by 目标 */
  managers(keys: readonly string[], from: number, to: number): Promise<Map<string, string[]>>;
  /** 计划依据的候选：变更源写入的变更（Git 提交），至少覆盖 [最早的退役 − PLAN_LOOKBACK_MS, to] */
  plans: readonly ChangeEvent[];
}

interface Atom {
  key: string;
  namespace: string;
  at: number;
  how: 'deleted' | 'scaled_to_zero';
}

const short = (key: string) => key.slice(key.indexOf(':') + 1);
const iso = (ms: number) => new Date(ms).toISOString();

/** 序列在 to 之前的点（非空） */
function points(s: MetricSeries, to: number): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  s.times.forEach((t, i) => {
    const v = s.values[i];
    if (t <= to && v !== null && v !== undefined) {
      out.push({ t, v });
    }
  });
  return out;
}

/**
 * 一条副本数序列的退役时刻：最后一次大于 0 之后还有取值（都是 0）时为缩到 0，退役时刻是第一个 0；之后没有取值、
 * 并且已经消失至少 RETIRE_SETTLE_MS 时为删除，退役时刻是最后一个大于 0 的点之后一个步长。从来没有大于 0 时为 null
 */
function retiredAt(
  s: MetricSeries,
  to: number,
  stepMs: number,
  ksmAlive: boolean,
): { at: number; how: Atom['how'] } | null {
  const ps = points(s, to);
  let last = -1;
  ps.forEach((p, i) => {
    if (p.v > 0) {
      last = i;
    }
  });
  if (last < 0) {
    return null;
  }
  const after = ps[last + 1];
  if (after) {
    return { at: after.t, how: 'scaled_to_zero' };
  }
  // kube-state-metrics 自己没有数据时，全部序列一起中断，不是删除
  if (!ksmAlive || to - ps[last]!.t < RETIRE_SETTLE_MS) {
    return null;
  }
  return { at: ps[last]!.t + stepMs, how: 'deleted' };
}

/** 退役变更的 change_id：第一个退役的工作负载与时刻，组里后来加入的工作负载不改变它 */
function retireId(clusterId: string, first: Atom): string {
  const h = createHash('sha256').update(`${first.key}@${first.at}`).digest('hex').slice(0, 16);
  return `kubernetes:${clusterId}:retire-${h}`;
}

/**
 * 副本数与 up 序列 → 退役变更（kind retire，source kubernetes），按时间排序；同样的输入得到同样的结果。
 * - groupWithinMs 内、同一命名空间或同一个管理应用的退役合成一次变更，目标是管理应用与工作负载；
 * - scrape_jobs：退役之前 SCRAPE_LOOKBACK_MS 内的目标全部是这次退役的工作负载的 Pod、之后没有目标的抓取 job；
 * - planned_by：退役之前 PLAN_LOOKBACK_MS 内最近一次触及这些工作负载、管理应用或其上层应用的 Git 提交
 */
export async function deriveRetirements(series: RetireSeries, ctx: RetireContext): Promise<ChangeEvent[]> {
  const step = ctx.stepMs;
  const workloads = (Object.keys(KINDS) as Array<keyof typeof KINDS>).flatMap((k) =>
    series[k].map((s) => ({ kind: KINDS[k], name: s.labels[k], namespace: s.labels.namespace, s })),
  );
  const ksmAlive = workloads.some(({ s }) => points(s, ctx.to).some((p) => p.t >= ctx.to - 2 * step));
  const atoms: Atom[] = [];
  for (const w of workloads) {
    if (!w.name || !w.namespace) {
      continue;
    }
    const key = tryNodeKey(w.kind, w.namespace, w.name);
    const r = retiredAt(w.s, ctx.to, step, ksmAlive);
    if (key && r && r.at >= ctx.from && r.at <= ctx.to) {
      atoms.push({ key, namespace: w.namespace, at: r.at, how: r.how });
    }
  }
  if (!atoms.length) {
    return [];
  }
  atoms.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const first = atoms[0]!.at;
  const last = atoms[atoms.length - 1]!.at;
  const managed = await ctx.managers(
    atoms.map((a) => a.key),
    first - MANAGER_LOOKBACK_MS,
    last,
  );
  const managersOf = (a: Atom) => managed.get(a.key) ?? [];
  const groups: Atom[][] = [];
  for (const a of atoms) {
    const g = groups.find(
      (x) =>
        a.at - x[0]!.at <= ctx.groupWithinMs &&
        x.some((y) => y.namespace === a.namespace || managersOf(y).some((m) => managersOf(a).includes(m))),
    );
    if (g) {
      g.push(a);
    } else {
      groups.push([a]);
    }
  }
  const out: ChangeEvent[] = [];
  for (const g of groups) {
    const time = g[0]!.at;
    const keys = [...new Set(g.map((a) => a.key))].sort();
    const managers = [...new Set(g.flatMap(managersOf))].sort();
    const parents = managers.length
      ? [...new Set([...(await ctx.managers(managers, time - MANAGER_LOOKBACK_MS, time)).values()].flat())]
      : [];
    const jobs = await scrapeJobs(series.targets, new Set(keys), time, Math.max(...g.map((a) => a.at)), ctx);
    const touched = new Set([...keys, ...managers, ...parents]);
    const plan = [...ctx.plans]
      .filter((c) => {
        const t = Date.parse(c.time);
        return (
          c.source !== 'kubernetes' &&
          c.kind !== 'runtime_config' &&
          t <= time &&
          time - t <= PLAN_LOOKBACK_MS &&
          c.targets.some((x) => touched.has(x))
        );
      })
      .sort((a, b) => b.time.localeCompare(a.time) || a.change_id.localeCompare(b.change_id))[0];
    const lines = [
      ...g.map((a) => `${short(a.key)} ${a.how === 'deleted' ? '已删除' : '副本缩到 0'}`),
      ...jobs.map((j) => `抓取 job ${j.job} 失去全部 ${j.targets} 个目标`),
    ];
    const change: ChangeEvent = {
      change_id: retireId(ctx.clusterId, g[0]!),
      source: 'kubernetes',
      kind: 'retire',
      refs: managers,
      revision: null,
      actor: null,
      time: iso(time),
      link: null,
      targets: [...managers, ...keys],
      summary: lines.join('；').slice(0, 500),
    };
    if (jobs.length) {
      change.scrape_jobs = jobs.map((j) => j.job);
    }
    if (plan) {
      change.planned_by = [
        {
          change_id: plan.change_id,
          revision: plan.revision,
          time: plan.time,
          link: plan.link,
          summary: plan.summary,
        },
      ];
    }
    out.push(change);
  }
  return out.sort((a, b) => a.time.localeCompare(b.time) || a.change_id.localeCompare(b.change_id));
}

/**
 * 随退役失去全部目标的抓取 job：在 [退役 − SCRAPE_LOOKBACK_MS, 退役] 内出现过的目标 Pod 全部属于被退役的工作负载
 * （拓扑在退役之前两个步长时的属主），最后一个目标不晚于最后一次退役之后 RETIRE_SETTLE_MS，并且到 to 为止已经消失
 */
async function scrapeJobs(
  targets: readonly MetricSeries[],
  retired: ReadonlySet<string>,
  time: number,
  lastRetire: number,
  ctx: RetireContext,
): Promise<Array<{ job: string; targets: number }>> {
  const byJob = new Map<string, MetricSeries[]>();
  for (const s of targets) {
    const job = s.labels.job;
    if (job) {
      byJob.set(job, [...(byJob.get(job) ?? []), s]);
    }
  }
  const owners = await ctx.podOwners(time - 2 * ctx.stepMs);
  const out: Array<{ job: string; targets: number }> = [];
  for (const [job, list] of [...byJob].sort(([a], [b]) => a.localeCompare(b))) {
    const all = list.flatMap((s) => points(s, ctx.to).map((p) => p.t));
    const lastSeen = Math.max(...all);
    if (!all.length || lastSeen > lastRetire + RETIRE_SETTLE_MS || lastSeen >= ctx.to - 2 * ctx.stepMs) {
      continue;
    }
    const before = list.filter((s) => points(s, time).some((p) => p.t >= time - SCRAPE_LOOKBACK_MS));
    if (!before.length) {
      continue;
    }
    const mine = before.every((s) => {
      const pod = s.labels.pod && s.labels.namespace ? tryNodeKey('Pod', s.labels.namespace, s.labels.pod) : null;
      const owner = pod ? owners(pod) : null;
      return owner !== null && retired.has(owner);
    });
    if (mine) {
      out.push({ job, targets: before.length });
    }
  }
  return out;
}
