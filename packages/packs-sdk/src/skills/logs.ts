// 日志事件（ADR 0181 §7.3）：绑定声明事件的消息与字段，宿主据此生成 LogQL，取回的每一行按 JSON 解析，
// 只保留声明的字段并按类型转换，其余内容（请求体、上游错误文字等）在这里丢弃。组织 id 只保留声明的前缀长度。

import { fmtBytes, fmtSecs } from '../cel/format.js';
import type { FieldType, LogEventDecl, LogRecord, LogsOutput } from './data.js';
import { fmtTime } from './stats.js';

export interface Identifiers {
  /** 组织 id 字段（as 之后的名字）与保留的前缀长度 */
  org?: { field: string; prefix: number };
}

const lq = (s: string) => JSON.stringify(s);

/** 一个事件在一个 Pod、一个容器上的 LogQL */
export function eventQuery(
  e: LogEventDecl,
  labels: { namespace: string; pod: string; container: string },
  sel: { namespace: string; pod: string; container: string | null },
): string {
  const parts = [`${labels.namespace}=${lq(sel.namespace)}`, `${labels.pod}=${lq(sel.pod)}`];
  if (sel.container) {
    parts.push(`${labels.container}=${lq(sel.container)}`);
  }
  let q = `{${parts.join(', ')}} |= ${lq(e.message)}`;
  if (e.min) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(e.min.field) || !Number.isFinite(e.min.gt)) {
      throw new Error(`日志事件 ${e.id} 的 min 不合法`);
    }
    q += ` | json ${e.min.field}=${lq(e.min.field)} | ${e.min.field} > ${e.min.gt}`;
  }
  return q;
}

function convert(v: unknown, type: FieldType, ids: Identifiers, as: string): string | number | boolean | null {
  if (v === undefined || v === null) {
    return null;
  }
  switch (type) {
    case 'bytes':
    case 'int':
    case 'float':
    case 'duration_ms': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;
    case 'org_id': {
      const s = String(v);
      const p = ids.org && ids.org.field === as ? ids.org.prefix : 8;
      return s.slice(0, p);
    }
    case 'string':
    case 'path':
    case 'request_id':
      return String(v).slice(0, 200);
  }
}

function display(v: string | number | boolean | null, type: FieldType): string {
  if (v === null) {
    return '—';
  }
  if (typeof v === 'number') {
    if (type === 'bytes') {
      return fmtBytes(v);
    }
    if (type === 'duration_ms') {
      return fmtSecs(v / 1000);
    }
    return String(v);
  }
  return type === 'org_id' ? `${String(v)}…` : String(v);
}

/**
 * 一行日志按声明的事件取出记录；不是 JSON、消息不匹配或不满足 where 时为 null。
 * 一行只匹配第一个消息相同的事件
 */
export function extractRecord(
  line: string,
  time: number,
  pod: string,
  events: readonly LogEventDecl[],
  ids: Identifiers,
): LogRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return null;
  }
  const o = obj as Record<string, unknown>;
  for (const e of events) {
    if (o[e.message_key] !== e.message) {
      continue;
    }
    const fields: LogRecord['fields'] = {};
    const text: LogRecord['text'] = {};
    for (const f of e.fields) {
      const as = f.as ?? f.name;
      const v = convert(o[f.name], f.type, ids, as);
      fields[as] = v;
      text[as] = display(v, f.type);
    }
    // where 的键是声明过的字段（as 之后的名字），按转换之后的值比较
    for (const [k, want] of Object.entries(e.where ?? {})) {
      if (!(k in fields)) {
        throw new Error(`日志事件 ${e.id} 的 where 引用了没有声明的字段 ${k}`);
      }
      if (fields[k] !== want) {
        return null;
      }
    }
    // 日志行里的时间优先（time 或 ts 字段，RFC 3339），没有时用日志源的时间
    const ts = typeof o.time === 'string' ? Date.parse(o.time) : typeof o.ts === 'string' ? Date.parse(o.ts) : NaN;
    return {
      event: e.id,
      pod,
      time: Number.isFinite(ts) ? ts : time,
      fields,
      text: { ...text, time: fmtTime(Number.isFinite(ts) ? ts : time) },
    };
  }
  return null;
}

/** logs.extract@v1：kube.read 读到的上一次退出的日志（每个 Pod 一段文本）按事件取出记录 */
export function extractLogs(
  logs: ReadonlyArray<{ pod: string; container: string; text: string; read_at: number }>,
  events: readonly LogEventDecl[],
  ids: Identifiers,
): LogsOutput & { skipped: number } {
  const records: LogRecord[] = [];
  const queries: Record<string, string[]> = {};
  let skipped = 0;
  for (const l of logs) {
    for (const line of l.text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const r = extractRecord(line, l.read_at, l.pod, events, ids);
      if (r) {
        records.push(r);
        queries[r.event] = [...new Set([...(queries[r.event] ?? []), `kube_logs --previous ${l.pod}/${l.container}`])];
      } else {
        skipped++;
      }
    }
  }
  return { records, queries, truncated: false, skipped };
}
