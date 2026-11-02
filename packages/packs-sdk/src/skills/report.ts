// analyze.top@v1 与 analyze.profiles@v1：日志记录的排序与份额、堆画像的文件名与命令。

import type { Lang, LogRecord, LogsOutput } from './data.js';
import { fmtTime, localized, pick } from './stats.js';

export interface TopColumn {
  field: string;
  title: unknown;
  /** 以代码片段展示 */
  code?: boolean;
}

export interface TopOutput {
  columns: Array<{ title: string }>;
  items: Array<LogRecord & { cells: Array<{ text: string; code: boolean }> }>;
  /** 份额最高的分组；份额不足 share_min 时 key 为 *（进入指纹） */
  group: { key: string; share: number | null; total: number | null; label: string | null };
}

export function topRecords(i: {
  logs: readonly LogsOutput[];
  event: string;
  pods?: readonly string[] | null;
  by: readonly string[];
  limit: number;
  columns: readonly TopColumn[];
  group?: { field: string; value_field: string; min_value: number; share_min: number } | null;
  lang: Lang;
}): TopOutput {
  const all = i.logs
    .flatMap((x) => x.records)
    .filter((r) => r.event === i.event && (!i.pods || i.pods.includes(r.pod)));
  // 同一请求（同一组字段值）只保留一条
  const seen = new Set<string>();
  const uniq = all.filter((r) => {
    const k = JSON.stringify(r.fields);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
  const num = (r: LogRecord, f: string) => (typeof r.fields[f] === 'number' ? (r.fields[f] as number) : -Infinity);
  const sorted = [...uniq].sort((a, b) => {
    for (const f of i.by) {
      const d = num(b, f) - num(a, f);
      if (d !== 0) {
        return d;
      }
    }
    return a.time - b.time;
  });
  let group: TopOutput['group'] = { key: '*', share: null, total: null, label: null };
  if (i.group) {
    const g = i.group;
    const sums = new Map<string, number>();
    let total = 0;
    for (const r of uniq) {
      const v = num(r, g.value_field);
      const k = r.fields[g.field];
      if (v >= g.min_value && typeof k === 'string' && k) {
        sums.set(k, (sums.get(k) ?? 0) + v);
        total += v;
      }
    }
    const top = [...sums.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (top && total > 0) {
      const share = top[1] / total;
      const ok = share >= g.share_min;
      group = {
        key: ok ? top[0] : '*',
        share,
        total,
        label: ok
          ? pick(
              i.lang,
              `组织 ${top[0]}…（${Math.round(share * 100)}%）`,
              `organization ${top[0]}… (${Math.round(share * 100)}%)`,
            )
          : pick(i.lang, '多个组织', 'several organizations'),
      };
    }
  }
  const columns = [
    { field: 'time', title: pick(i.lang, '时间 (UTC)', 'Time (UTC)'), code: false },
    { field: 'pod', title: 'Pod', code: false },
    ...i.columns.map((c) => ({ field: c.field, title: localized(c.title, i.lang) || c.field, code: c.code === true })),
  ];
  const items = sorted.slice(0, i.limit).map((r) => ({
    ...r,
    cells: columns.map((c) => ({
      text: c.field === 'time' ? fmtTime(r.time) : c.field === 'pod' ? r.pod : (r.text[c.field] ?? '—'),
      code: c.code,
    })),
  }));
  return { columns: columns.map((c) => ({ title: c.title })), items, group };
}

export interface ProfilesDecl {
  /** 写出堆画像的日志事件 */
  log: { id: string };
  field: string;
  pattern: string;
  fetch: string;
  analyze: string;
}

export interface ProfileItem {
  pod: string;
  path: string;
  file: string;
  time_text: string;
  fetch: string;
  analyze: string;
}

/** 堆画像：路径按模式校验，不符合的丢弃；每个 Pod 按时间取最近 limit 个；命令中的占位符只用校验过的值替换 */
export function listProfiles(i: {
  logs: readonly LogsOutput[];
  profiles: ProfilesDecl;
  limitPerPod: number;
  namespace: string;
  container: string;
}): { items: ProfileItem[] } {
  const re = new RegExp(i.profiles.pattern);
  const byPod = new Map<string, Map<string, LogRecord>>();
  for (const r of i.logs.flatMap((x) => x.records)) {
    const p = r.fields[i.profiles.field];
    if (r.event !== i.profiles.log.id || typeof p !== 'string' || !re.test(p) || !/^[a-z0-9-]+$/.test(r.pod)) {
      continue;
    }
    const m = byPod.get(r.pod) ?? new Map<string, LogRecord>();
    const prev = m.get(p);
    if (!prev || prev.time < r.time) {
      m.set(p, r);
    }
    byPod.set(r.pod, m);
  }
  const items: ProfileItem[] = [];
  for (const pod of [...byPod.keys()].sort()) {
    const rs = [...byPod.get(pod)!.values()].sort((a, b) => b.time - a.time).slice(0, i.limitPerPod);
    for (const r of rs) {
      const path = r.fields[i.profiles.field] as string;
      const file = path.split('/').pop()!;
      const fill = (t: string) =>
        t
          .replaceAll('{namespace}', i.namespace)
          .replaceAll('{pod}', pod)
          .replaceAll('{path}', path)
          .replaceAll('{file}', file)
          .replaceAll('{container}', i.container);
      items.push({
        pod,
        path,
        file,
        time_text: fmtTime(r.time),
        fetch: fill(i.profiles.fetch),
        analyze: fill(i.profiles.analyze),
      });
    }
  }
  return { items };
}
