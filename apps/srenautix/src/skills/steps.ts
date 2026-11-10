import type { SignalAlternative, SkillCapability, SkillSubject, SkillTriggerHit } from '@srenautix/contract';
import { toIso, type PromqlEngine } from '@srenautix/integration-sdk';
import {
  podPattern,
  renderMetrics,
  resolveSignal,
  skills as sdk,
  type EvidenceDataSource,
  type PackSet,
} from '@srenautix/packs-sdk';
import { parseDuration } from '../kernel/files.js';
import type { GitHubApp } from '../github/app.js';
import { RepoCodeCache } from '../optimize/code/tree.js';
import { SkillDenied, type SkillContext } from './context.js';
import { podSummary, type SkillKube } from './kube.js';

// 宿主的步骤类型（ADR 0181 §3）。访问外部系统的步骤（kube.read、trigger.occurrences、metrics.range、logs.events、
// code.locate）只经 SkillContext；analyze.* 与 logs.extract 是 packs-sdk 的纯函数；issue.related 与 issue.publish 由
// 运行器提供状态库的部分。

export class StepInputError extends Error {
  override name = 'StepInputError';
}

export interface StepEnv {
  ctx: SkillContext;
  lang: sdk.Lang;
  clusterId: string;
  subject: SkillSubject;
  /** 参考时刻（unix 毫秒）：窗口都以它为终点 */
  at: number;
  triggers: readonly SkillTriggerHit[];
  /** at 时刻的数据源（指标与日志）；第一次使用时取得 */
  ds: () => Promise<EvidenceDataSource>;
  engine: PromqlEngine;
  set: PackSet;
  kube: SkillKube | null;
  kubeLimits: { tailLines: number; maxBytes: number };
  github: GitHubApp | null;
  /** 仓库角色 → 仓库 */
  repos: { business: { repo: string; default_branch: string } | null; ops: string | null };
  /** 这个工作负载上以前的运行已经报告过的发生 */
  reported: ReadonlySet<string>;
  /** 本技能在同一工作负载上开过的其他 issue */
  related: () => Promise<number[]>;
  /** 运行内的信号备选缓存；null 表示这个信号没有可用的备选 */
  resolved: Map<string, SignalAlternative | null>;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) {
    throw new StepInputError(`${what} 必须是非空字符串`);
  }
  return v;
};
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new StepInputError(`${what} 必须是数`);
  }
  return v;
};
const dur = (v: unknown, what: string): number => parseDuration(what, str(v, what));
const arr = <T>(v: unknown, what: string): T[] => {
  if (!Array.isArray(v)) {
    throw new StepInputError(`${what} 必须是数组`);
  }
  return v as T[];
};

/** 发生的键：同一工作负载上以后的运行只投递新的发生 */
export const occurrenceKey = (o: { pod: string; container: string; at: number; cause: string }) =>
  `${o.pod}/${o.container}/${o.cause}@${Math.floor(o.at / 60_000)}`;

/** 运行对象的 Pod：名字符合控制器的命名规则 */
export function subjectPods(subject: SkillSubject): RegExp {
  const p = podPattern({ cluster_id: '', kind: subject.kind, namespace: subject.namespace, name: subject.name });
  if (!p) {
    throw new StepInputError(`${subject.kind} 没有 Pod 命名规则`);
  }
  return new RegExp(`^(?:${p})$`);
}

async function resolveAlt(env: StepEnv, key: string): Promise<SignalAlternative | null> {
  if (env.resolved.has(key)) {
    return env.resolved.get(key)!;
  }
  const sig = env.set.signals.get(key);
  if (!sig || sig.signal.kind !== 'metrics') {
    throw new StepInputError(`信号 ${key} 不是加载的领域包中的 metrics 信号`);
  }
  // 备选的探测（指标名在参考时刻前 2 小时内是否存在）计作一次指标查询；没有可用的备选时这个信号没有数据
  const clock = { from: toIso(env.at - 2 * 3600_000), to: toIso(env.at) };
  const ds = await env.ds();
  const r = await env.ctx.call('metrics.query_range', 'metrics', 'resolve_signal', { signal: key }, () =>
    resolveSignal(key, sig.signal, ds, env.engine, toIso(env.at), clock),
  );
  const probeFailed = r.rejected.find((x) => x.cause === 'error');
  if (!r.alternative && probeFailed) {
    throw new Error(`信号 ${key} 的备选探测失败：${probeFailed.reason}`);
  }
  env.resolved.set(key, r.alternative);
  return r.alternative;
}

/** 一个信号在一个实体上的区间查询 */
async function range(
  env: StepEnv,
  key: string,
  entity: { kind: string; namespace: string; name: string },
  from: number,
  to: number,
  stepSeconds: number,
  wrap: (expr: string) => string = (e) => e,
): Promise<sdk.SignalData> {
  const alt = await resolveAlt(env, key);
  if (!alt) {
    return { expr: '', series: [] };
  }
  const ds = await env.ds();
  const profile = ds.labelProfile;
  if (!profile) {
    throw new Error('指标数据源没有标签档案');
  }
  const expr = wrap(
    renderMetrics(env.engine, alt, {
      entity: { cluster_id: env.clusterId, ...entity },
      params: {},
      windowSeconds: Math.max(60, Math.round((to - from) / 1000)),
      profile,
    }),
  );
  const clockFrom = env.at - 8 * 24 * 3600_000;
  const r = await env.ctx.call(
    'metrics.query_range',
    'metrics',
    'query_range',
    { signal: key, expr, from: toIso(from), to: toIso(to), step_seconds: stepSeconds },
    () =>
      ds.queryRange({
        expr,
        dialect: alt.dialect === 'metricsql' ? 'metricsql' : 'promql',
        window: { from: toIso(from), to: toIso(to) },
        step_seconds: stepSeconds,
        clock_window: { from: toIso(clockFrom), to: toIso(env.at) },
        timeout_ms: 30_000,
        max_series: 200,
      }),
    (v) => ({ bytes: v.series.reduce((a, s) => a + s.times.length * 16, 0), truncated: v.truncated }),
  );
  const back = (labels: Record<string, string | undefined>) => {
    // 标签档案改写过标签名：结果按规范名读取 pod、container
    const l = Object.fromEntries(Object.entries(labels).filter((e): e is [string, string] => e[1] !== undefined));
    const out: Record<string, string> = { ...l };
    if (profile.pod !== 'pod' && l[profile.pod] !== undefined) {
      out.pod = l[profile.pod]!;
    }
    if (profile.container !== 'container' && l[profile.container] !== undefined) {
      out.container = l[profile.container]!;
    }
    return out;
  };
  return {
    expr,
    series: r.series.map((s) => ({
      labels: back(s.labels),
      points: s.times.flatMap((t, i) => {
        const v = s.values[i];
        return v === null || v === undefined || !Number.isFinite(v) ? [] : [{ t, v }];
      }),
    })),
  };
}

function signalsIn(v: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(v)) {
    v.forEach((x) => signalsIn(x, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'signal' && typeof x === 'string') {
        out.add(x);
      } else {
        signalsIn(x, out);
      }
    }
  }
  return out;
}

const CAUSE: Record<sdk.Occurrence['cause'], [string, string]> = {
  oom_killed: ['OOMKilled', 'OOMKilled'],
  evicted: ['被驱逐', 'evicted'],
  near_limit: ['贴近 limit', 'near the limit'],
};
const SOURCE: Record<sdk.Occurrence['source'], [string, string]> = {
  metric: ['指标（精度一个步长）', 'metrics (one step precision)'],
  pod_status: ['Pod 状态', 'Pod status'],
  trigger: ['触发', 'trigger'],
};

export async function runStep(uses: string, w: Record<string, unknown>, env: StepEnv): Promise<unknown> {
  const L = env.lang;
  const pick = (zh: string, en: string) => (L === 'zh-CN' ? zh : en);
  const ns = env.subject.namespace;
  switch (uses) {
    case 'kube.read@v1': {
      const object = str(w.object, 'object') as 'pod_status' | 'events' | 'pod_logs_previous';
      const allowed = env.ctx.params('kube.read').objects;
      if (allowed && !allowed.includes(object)) {
        env.ctx.deny('kube.read', object, { object }, `对象 ${object} 不在授予的范围内`);
      }
      if (!env.kube) {
        env.ctx.deny('kube.read', object, { object }, 'server 没有 Kubernetes 只读访问');
      }
      const kube = env.kube;
      if (object === 'pod_status') {
        env.ctx.inScope('kube.read', 'workload_pods', ns, null);
        const pods = await env.ctx.call(
          'kube.read',
          'kube',
          'workload_pods',
          { namespace: ns, kind: env.subject.kind, name: env.subject.name },
          () => kube.workloadPods(ns, env.subject.kind, env.subject.name),
          (v) => ({ bytes: v.length * 512, truncated: false }),
        );
        const summaries = pods.map(podSummary);
        return { pods: summaries, names: summaries.map((p) => p.name).sort(), events: [], logs: [] };
      }
      if (object === 'events') {
        env.ctx.inScope('kube.read', 'events', ns, null);
        const re = subjectPods(env.subject);
        const all = await env.ctx.call(
          'kube.read',
          'kube',
          'events',
          { namespace: ns },
          () => kube.events(ns),
          (v) => ({ bytes: v.length * 256, truncated: v.length >= 500 }),
        );
        return { pods: [], names: [], events: all.filter((e) => re.test(e.object.split('/').pop() ?? '')), logs: [] };
      }
      const container = str(w.container, 'container');
      const tail = Math.min(
        typeof w.tail_lines === 'number' ? w.tail_lines : env.kubeLimits.tailLines,
        5 * env.kubeLimits.tailLines,
      );
      const logs: Array<{ pod: string; container: string; text: string; read_at: number }> = [];
      for (const pod of arr<string>(w.pods ?? [], 'pods')) {
        env.ctx.inScope('kube.read', 'pod_logs_previous', ns, pod);
        try {
          const r = await env.ctx.call(
            'kube.read',
            'kube',
            'pod_logs_previous',
            { namespace: ns, pod, container, tail_lines: tail },
            () => env.kube!.previousLog(ns, pod, container, tail, env.kubeLimits.maxBytes),
            (v) => ({ bytes: v.bytes, truncated: v.truncated }),
          );
          logs.push({ pod, container, text: r.text, read_at: env.at });
        } catch (e) {
          // 上一次退出的容器不存在（Pod 被重建、从没有重启）时 API 返回 400：这个 Pod 没有可读的日志，访问记录里有原因
          if (e instanceof SkillDenied || (e as { code?: unknown }).code !== 400) {
            throw e;
          }
        }
      }
      return { pods: [], names: [], events: [], logs };
    }

    case 'trigger.occurrences@v1': {
      const signal = str(w.signal, 'signal');
      const window = dur(w.window, 'window');
      const stepS = Math.round(dur(w.step ?? '60s', 'step') / 1000);
      const container = typeof w.container === 'string' ? w.container : null;
      const pods = arr<sdk.PodSummary>(w.pods ?? [], 'pods');
      const from = env.at - window;
      const data = await range(env, signal, env.subject, from, env.at, stepS);
      const found: sdk.Occurrence[] = [];
      for (const s of data.series) {
        const pod = s.labels.pod;
        const c = s.labels.container ?? container ?? '';
        if (!pod || (container && s.labels.container && s.labels.container !== container)) {
          continue;
        }
        let last = -Infinity;
        for (const p of s.points) {
          if (p.v > 0 && p.t - last > stepS * 1000 * 1.5) {
            // 第一个为正的点之前一个步长内发生了终止：取这个下界，窗口里不含终止之后的新容器
            found.push({
              pod,
              container: c,
              at: p.t - stepS * 1000,
              cause: 'oom_killed',
              source: 'metric',
              new: false,
            });
          }
          if (p.v > 0) {
            last = p.t;
          }
        }
      }
      // Pod 状态里最近一次终止的时刻比区间查询精确：10 分钟内的同一 Pod 的发生改用它，查询里没有的补上
      for (const pod of pods) {
        for (const c of pod.containers) {
          const t = c.last_terminated;
          if (!t?.finished_at || t.reason !== 'OOMKilled' || t.finished_at < from || t.finished_at > env.at) {
            continue;
          }
          if (container && c.name !== container) {
            continue;
          }
          const near = found.find((o) => o.pod === pod.name && Math.abs(o.at - t.finished_at!) <= 10 * 60_000);
          if (near) {
            near.at = t.finished_at;
            near.source = 'pod_status';
          } else {
            found.push({
              pod: pod.name,
              container: c.name,
              at: t.finished_at,
              cause: 'oom_killed',
              source: 'pod_status',
              new: false,
            });
          }
        }
      }
      // 触发带来的发生：kube 触发（终止原因、驱逐）与信号不同的指标触发（贴近 limit）
      for (const h of env.triggers) {
        if (!h.pod || !h.cause) {
          continue;
        }
        const t = Date.parse(h.at);
        if (t < from || t > env.at) {
          continue;
        }
        if (!found.some((o) => o.pod === h.pod && Math.abs(o.at - t) <= 10 * 60_000)) {
          found.push({
            pod: h.pod,
            container: h.container ?? container ?? '',
            at: t,
            cause: h.cause,
            source: 'trigger',
            new: false,
          });
        }
      }
      const re = subjectPods(env.subject);
      const occurrences = found
        .filter((o) => re.test(o.pod))
        .sort((a, b) => a.at - b.at || (a.pod < b.pod ? -1 : 1))
        .map((o) => ({
          ...o,
          new: !env.reported.has(occurrenceKey(o)),
          at_text: sdk.fmtTime(o.at),
          cause_text: pick(...CAUSE[o.cause]),
          source_text: pick(...SOURCE[o.source]),
        }));
      return {
        occurrences,
        new: occurrences.filter((o) => o.new),
        pods: [...new Set(occurrences.map((o) => o.pod))],
        query: data.expr,
      };
    }

    case 'metrics.range@v1': {
      const mode = str(w.mode, 'mode');
      const stepS = Math.round(dur(w.step, 'step') / 1000);
      const keys = [...arr<string>(w.signals, 'signals'), ...signalsIn(w.extra ?? [], new Set())];
      const unique = [...new Set(keys)];
      if (mode === 'history') {
        const from = env.at - dur(w.last, 'last');
        // 绑定中声明为峰值型（evidence: peak）的序列按步长内的最大值取样，步长之间的瞬时峰值不会丢失
        const peaks = sdk.peakSignals(w.extra ?? []);
        const res =
          w.peak_resolution === undefined ? null : Math.round(dur(w.peak_resolution, 'peak_resolution') / 1000);
        const signals: Record<string, sdk.SignalData> = {};
        for (const k of unique) {
          const wrap = peaks.has(k) ? (e: string) => sdk.peakExpr(e, stepS, res) : undefined;
          signals[k] = await range(env, k, env.subject, from, env.at, stepS, wrap);
        }
        return { windows: [], history: { from, to: env.at, step_seconds: stepS, signals } };
      }
      if (mode !== 'around') {
        throw new StepInputError(`mode 只能是 around 或 history：${mode}`);
      }
      const before = dur(w.before, 'before');
      const after = dur(w.after ?? '0s', 'after');
      const windows: sdk.AroundWindow[] = [];
      const re = subjectPods(env.subject);
      for (const o of arr<sdk.Occurrence>(w.occurrences, 'occurrences')) {
        if (!re.test(o.pod)) {
          env.ctx.deny('metrics.query_range', 'query_range', { pod: o.pod }, `Pod ${o.pod} 不属于运行对象`);
        }
        const from = o.at - before;
        const to = Math.min(env.at, o.at + after);
        const signals: Record<string, sdk.SignalData> = {};
        for (const k of unique) {
          signals[k] = await range(env, k, { kind: 'Pod', namespace: ns, name: o.pod }, from, to, stepS);
        }
        windows.push({ pod: o.pod, container: o.container, at: o.at, from, to, signals });
      }
      return { windows, history: null };
    }

    case 'logs.events@v1': {
      const events = arr<sdk.LogEventDecl>(w.events, 'events');
      const before = dur(w.before, 'before');
      // through 为 true 时每个 Pod 的窗口从发生之前 before 一直到参考时刻（发生之后才写出的事件，例如堆画像）
      const through = w.through === true;
      const container = typeof w.container === 'string' ? w.container : null;
      const ids = (w.identifiers ?? {}) as sdk.Identifiers;
      const ds = await env.ds();
      const profile = ds.logsProfile;
      if (!profile) {
        env.ctx.deny('logs.query', 'query', {}, 'server 没有配置日志数据源');
      }
      const maxLines = env.ctx.params('logs.query').max_lines ?? 1000;
      // 同一 Pod 的窗口合并
      const spans = new Map<string, Array<[number, number]>>();
      const re = subjectPods(env.subject);
      for (const o of arr<sdk.Occurrence>(w.occurrences, 'occurrences')) {
        if (!re.test(o.pod)) {
          env.ctx.deny('logs.query', 'query', { pod: o.pod }, `Pod ${o.pod} 不属于运行对象`);
        }
        const list = spans.get(o.pod) ?? [];
        list.push([o.at - before, through ? env.at : o.at]);
        spans.set(o.pod, list);
      }
      const records: sdk.LogRecord[] = [];
      const queries: Record<string, string[]> = {};
      let truncated = false;
      for (const [pod, list] of [...spans.entries()].sort()) {
        list.sort((a, b) => a[0] - b[0]);
        const merged: Array<[number, number]> = [];
        for (const s of list) {
          const last = merged[merged.length - 1];
          if (last && s[0] <= last[1]) {
            last[1] = Math.max(last[1], s[1]);
          } else {
            merged.push([s[0], s[1]]);
          }
        }
        for (const e of events) {
          const q = sdk.eventQuery(e, profile, { namespace: ns, pod, container });
          queries[e.id] = [...new Set([...(queries[e.id] ?? []), q])];
          for (const [from, to] of merged) {
            const limit = Math.max(1, Math.min(maxLines, env.ctx.remaining('log_lines')));
            const r = await env.ctx.call(
              'logs.query',
              'logs',
              'query',
              { query: q, from: toIso(from), to: toIso(to), limit },
              () =>
                ds.logsQuery({
                  query: q,
                  dialect: 'logql',
                  window: { from: toIso(from), to: toIso(to) },
                  limit,
                  clock_window: { from: toIso(env.at - 8 * 24 * 3600_000), to: toIso(env.at) },
                }),
              (v) => ({ bytes: v.lines.reduce((a, l) => a + l.line.length, 0), truncated: v.truncated }),
            );
            env.ctx.charge('logs.query', 'query', 'log_lines', r.lines.length, { query: q });
            truncated ||= r.truncated;
            for (const l of r.lines) {
              const rec = sdk.extractRecord(l.line, Date.parse(l.time), pod, [e], ids);
              if (rec) {
                records.push(rec);
              }
            }
          }
        }
      }
      records.sort((a, b) => a.time - b.time);
      return { records, queries, truncated };
    }

    case 'logs.extract@v1':
      return sdk.extractLogs(
        arr(w.logs, 'logs'),
        arr<sdk.LogEventDecl>(w.events, 'events'),
        (w.identifiers ?? {}) as sdk.Identifiers,
      );

    case 'analyze.memory_kind@v1':
      return sdk.classifyMemory({
        runtime: w.runtime === 'go' ? 'go' : 'other',
        container: '',
        occurrences: arr(w.occurrences, 'occurrences'),
        pods: arr(w.pods ?? [], 'pods'),
        kubeEvents: arr(w.kube_events ?? [], 'kube_events'),
        around: arr(w.around, 'around'),
        signals: w.signals as sdk.MemorySignals,
        thresholds: w.thresholds as sdk.MemoryThresholds,
        lang: L,
      });

    case 'analyze.suspects@v1':
      if (!w.classified) {
        throw new StepInputError('classified 为空：analyze.memory_kind 没有执行');
      }
      return sdk.rankSuspects({
        suspects: arr(w.suspects, 'suspects'),
        context: arr(w.context ?? [], 'context'),
        classified: w.classified as sdk.MemoryKindOutput,
        around: arr(w.around, 'around'),
        history: (w.history ?? null) as sdk.HistoryWindow | null,
        logs: arr(w.logs, 'logs'),
        thresholds: w.thresholds as sdk.SuspectThresholds,
        lang: L,
      });

    case 'analyze.top@v1': {
      const g = w.group as Record<string, unknown> | undefined;
      return sdk.topRecords({
        logs: arr(w.logs, 'logs'),
        event: str(w.event, 'event'),
        pods: Array.isArray(w.pods) ? (w.pods as string[]) : null,
        by: arr(w.by, 'by'),
        limit: num(w.limit, 'limit'),
        columns: arr(w.columns, 'columns'),
        group: g
          ? {
              field: str(g.field, 'group.field'),
              value_field: str(g.value_field, 'group.value_field'),
              min_value: num(g.min_value, 'group.min_value'),
              share_min: num(g.share_min, 'group.share_min'),
            }
          : null,
        lang: L,
      });
    }

    case 'analyze.profiles@v1':
      return sdk.listProfiles({
        logs: arr(w.logs, 'logs'),
        profiles: w.profiles as sdk.ProfilesDecl,
        limitPerPod: typeof w.limit_per_pod === 'number' ? w.limit_per_pod : 4,
        namespace: ns,
        container: typeof w.container === 'string' ? w.container : '',
      });

    case 'code.locate@v1':
      return locateCode(arr(w.items, 'items'), env);

    case 'issue.related@v1': {
      const refs = arr<number>(w.references ?? [], 'references').filter((n) => Number.isInteger(n));
      const other = await env.related();
      return { items: [...new Set([...refs, ...other])].sort((a, b) => a - b).map((number) => ({ number })) };
    }

    default:
      throw new StepInputError(`步骤类型 ${uses} 由运行器处理`);
  }
}

interface CodeItem {
  code?: Array<{ path: string; pattern: string; before?: number; after?: number; note?: unknown }>;
  [k: string]: unknown;
}

/** code.locate@v1：业务仓库的文件中找出字面量第一次出现的行，链接固定到读取时默认分支的头 */
async function locateCode(items: CodeItem[], env: StepEnv) {
  const cap: SkillCapability = 'code.read';
  const role = env.ctx.params(cap).repo_role ?? 'business';
  const repo = role === 'business' ? env.repos.business : null;
  if (!repo || !env.github) {
    env.ctx.deny(cap, 'code', { repo_role: role }, `没有 ${role} 角色的仓库`);
  }
  const gh = env.github;
  const reader = {
    api: <T>(method: string, path: string, body: unknown, op: string) =>
      env.ctx.call(cap, 'github', op, { method, path: path.split('?')[0] }, () => gh.api<T>(method, path, body, op)),
  };
  const branch = encodeURIComponent(repo.default_branch);
  const head = await reader.api<{ base_commit: { sha: string } }>(
    'GET',
    `/repos/${repo.repo}/compare/${branch}...${branch}`,
    undefined,
    'business_head',
  );
  const commit = head.base_commit.sha;
  const cache = new RepoCodeCache(reader);
  const tree = await cache.tree(repo.repo, commit);
  const contents = new Map<string, string | null>();
  const stale: Array<{ path: string; pattern: string }> = [];
  const out = [];
  for (const it of items) {
    const locations = [];
    for (const h of it.code ?? []) {
      if (!contents.has(h.path)) {
        const entry = tree.entries.find((e) => e.path === h.path);
        if (!entry) {
          contents.set(h.path, null);
        } else {
          env.ctx.charge(cap, 'code_content', 'code_files', 1, { path: h.path });
          env.ctx.charge(cap, 'code_content', 'code_bytes', entry.size, { path: h.path });
          contents.set(h.path, await cache.content(repo.repo, commit, entry));
        }
      }
      const text = contents.get(h.path);
      const lines = text ? text.split('\n') : [];
      const idx = lines.findIndex((l) => l.includes(h.pattern));
      if (idx < 0) {
        stale.push({ path: h.path, pattern: h.pattern });
        continue;
      }
      const start = Math.max(1, idx + 1 - (h.before ?? 0));
      const end = Math.min(lines.length, idx + 1 + (h.after ?? 0));
      locations.push({
        path: h.path,
        line: idx + 1,
        start,
        end,
        url: `https://github.com/${repo.repo}/blob/${commit}/${h.path}#L${start}-L${end}`,
        note: h.note ? sdk.localized(h.note, env.lang) : '',
      });
    }
    out.push({ ...it, locations });
  }
  return { commit, items: out, stale };
}
