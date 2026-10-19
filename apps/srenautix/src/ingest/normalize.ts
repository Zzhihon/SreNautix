import type { AlertmanagerAlert, Labels, Severity } from '@srenautix/contract';
import { JSONPath } from 'jsonpath-plus';

/** 不属于告警身份的标签（与 Prometheus ALERTS 序列的附加标签一致）。 */
export const NON_IDENTITY_LABELS = new Set(['alertstate', 'alertgroup', '__name__']);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/**
 * 告警指纹：去掉 alertstate、alertgroup、__name__ 后，按键排序，逐个写入 key、0xff、value、0xff 的 UTF-8 字节，
 * 取 FNV-1a 64 位哈希的 16 位十六进制。各接入源（webhook、Alertmanager API、ALERTS 序列）对同一标签集得到同一个指纹。
 */
export function fingerprint(labels: Labels): string {
  let h = FNV_OFFSET;
  const keys = Object.keys(labels)
    .filter((k) => !NON_IDENTITY_LABELS.has(k) && labels[k] !== undefined)
    .sort();
  const sep = 0xff;
  for (const k of keys) {
    for (const b of [...Buffer.from(k, 'utf8'), sep, ...Buffer.from(labels[k] as string, 'utf8'), sep]) {
      h ^= BigInt(b);
      h = (h * FNV_PRIME) & MASK;
    }
  }
  return h.toString(16).padStart(16, '0');
}

export function identityLabels(labels: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!NON_IDENTITY_LABELS.has(k) && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 告警源的严重度标签映射到 critical / warning / info。 */
export function normalizeSeverity(raw: string | undefined): Severity {
  const v = (raw ?? '').trim().toLowerCase();
  if (['critical', 'crit', 'error', 'emergency', 'page', 'p1', 'disaster', 'high'].includes(v)) {
    return 'critical';
  }
  if (['warning', 'warn', 'major', 'p2', 'average', 'medium'].includes(v)) {
    return 'warning';
  }
  return 'info';
}

/** Alertmanager 用 0001-01-01T00:00:00Z 表示没有结束时间。 */
const ZERO_TIME = /^0001-01-01T/;

export function parseTime(raw: string | undefined | null): Date | null {
  if (!raw || ZERO_TIME.test(raw)) {
    return null;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

/** 接入层的一个告警实例（尚未分类与解析实体）。 */
export interface RawAlert {
  source: 'alertmanager' | 'grafana' | 'nightingale' | 'generic' | 'reconcile';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  severity: Severity;
  status: 'firing' | 'resolved';
  suppressed: 'none' | 'silenced' | 'inhibited';
  startsAt: Date;
  endsAt: Date | null;
  generatorUrl: string | null;
  fingerprint: string;
  alertname: string;
}

export function alertId(fp: string, startsAt: Date): string {
  return `${fp}@${Math.floor(startsAt.getTime() / 1000)}`;
}

export class PayloadError extends Error {
  override name = 'PayloadError';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function labelsOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x !== undefined && x !== null) {
      out[k] = str(x);
    }
  }
  return out;
}

/**
 * Alertmanager webhook（version 4）、Alertmanager API v2 的 GettableAlert，以及 Grafana 告警的 webhook
 * （与 Alertmanager 格式兼容）中的一个告警。`now` 用于判断 endsAt 是否已过（webhook 的 status 字段优先）。
 */
export function fromAlertmanager(a: AlertmanagerAlert, source: RawAlert['source'], now: Date): RawAlert {
  const labels = identityLabels(labelsOf(a.labels));
  const alertname = labels.alertname;
  if (!alertname) {
    throw new PayloadError('告警缺少 alertname 标签');
  }
  const startsAt = parseTime(a.startsAt);
  if (!startsAt) {
    throw new PayloadError(`告警 ${alertname} 的 startsAt 不合法：${a.startsAt}`);
  }
  const endsAt = parseTime(a.endsAt);
  let status: 'firing' | 'resolved';
  let suppressed: RawAlert['suppressed'] = 'none';
  if (typeof a.status === 'string') {
    status = a.status;
  } else {
    // API v2：state=active/suppressed 都在触发；endsAt 早于 now 表示已恢复
    status = endsAt && endsAt.getTime() <= now.getTime() ? 'resolved' : 'firing';
    if (a.status?.state === 'suppressed') {
      suppressed = (a.status.silencedBy?.length ?? 0) > 0 ? 'silenced' : 'inhibited';
    }
  }
  const fp = fingerprint(labels);
  return {
    source,
    labels,
    annotations: labelsOf(a.annotations),
    severity: normalizeSeverity(labels.severity),
    status,
    suppressed,
    startsAt,
    endsAt: status === 'resolved' ? (endsAt ?? now) : null,
    generatorUrl: a.generatorURL || null,
    fingerprint: fp,
    alertname,
  };
}

/** Alertmanager webhook 请求体。 */
export function parseAlertmanagerWebhook(body: unknown, source: 'alertmanager' | 'grafana', now: Date): RawAlert[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { alerts?: unknown }).alerts)) {
    throw new PayloadError('请求体必须是 Alertmanager webhook 格式（含 alerts 数组）');
  }
  return ((body as { alerts: AlertmanagerAlert[] }).alerts ?? []).map((a) => fromAlertmanager(a, source, now));
}

/**
 * 夜莺（Nightingale）回调的告警事件：rule_name 作为 alertname，tags_map 作为标签，severity 1/2/3 对应
 * critical/warning/info，first_trigger_time 为触发时间（unix 秒），is_recovered 表示恢复。
 * 请求体可以是单个事件或事件数组。
 */
export function parseNightingale(body: unknown, now: Date): RawAlert[] {
  const list = Array.isArray(body) ? body : [body];
  return list.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new PayloadError('夜莺事件必须是对象');
    }
    const e = raw as Record<string, unknown>;
    const ruleName = str(e.rule_name);
    if (!ruleName) {
      throw new PayloadError('夜莺事件缺少 rule_name');
    }
    const tags = labelsOf(e.tags_map);
    const labels = identityLabels({ ...tags, alertname: ruleName });
    if (e.target_ident && !labels.instance) {
      labels.instance = str(e.target_ident);
    }
    const sevNum = Number(e.severity);
    const severity: Severity = sevNum === 1 ? 'critical' : sevNum === 2 ? 'warning' : 'info';
    const first = Number(e.first_trigger_time ?? e.trigger_time);
    if (!Number.isFinite(first) || first <= 0) {
      throw new PayloadError(`夜莺事件 ${ruleName} 缺少 first_trigger_time`);
    }
    const recovered = e.is_recovered === true;
    const lastEval = Number(e.last_eval_time);
    return {
      source: 'nightingale',
      labels,
      annotations: { ...labelsOf(e.annotations), ...(e.rule_note ? { description: str(e.rule_note) } : {}) },
      severity,
      status: recovered ? 'resolved' : 'firing',
      suppressed: 'none',
      startsAt: new Date(first * 1000),
      endsAt: recovered ? (Number.isFinite(lastEval) && lastEval > 0 ? new Date(lastEval * 1000) : now) : null,
      generatorUrl: null,
      fingerprint: fingerprint(labels),
      alertname: ruleName,
    } satisfies RawAlert;
  });
}

export interface GenericMapping {
  alerts: string;
  alertname: string;
  status: string;
  firing_value: string;
  starts_at: string;
  ends_at?: string | undefined;
  labels?: string | undefined;
  annotations?: string | undefined;
  severity?: string | undefined;
  generator_url?: string | undefined;
}

function first(path: string, json: unknown): unknown {
  const r = JSONPath({ path, json: json as object, wrap: true }) as unknown[];
  return r[0];
}

/** 通用 webhook：用 JSONPath 选出告警数组，其余字段相对每个告警求值。 */
export function parseGeneric(body: unknown, m: GenericMapping, now: Date): RawAlert[] {
  const items = JSONPath({ path: m.alerts, json: body as object, wrap: true }) as unknown[];
  const alerts = items.length === 1 && Array.isArray(items[0]) ? (items[0] as unknown[]) : items;
  return alerts.map((a) => {
    const alertname = str(first(m.alertname, a));
    if (!alertname) {
      throw new PayloadError(`通用 webhook 的告警在 ${m.alertname} 处没有告警名`);
    }
    const labels = identityLabels({ ...(m.labels ? labelsOf(first(m.labels, a)) : {}), alertname });
    const startsRaw = first(m.starts_at, a);
    const startsAt =
      typeof startsRaw === 'number'
        ? new Date(startsRaw > 1e12 ? startsRaw : startsRaw * 1000)
        : parseTime(str(startsRaw));
    if (!startsAt) {
      throw new PayloadError(`通用 webhook 的告警 ${alertname} 在 ${m.starts_at} 处没有合法的开始时间`);
    }
    const firing = str(first(m.status, a)).toLowerCase() === m.firing_value.toLowerCase();
    const sevRaw = m.severity ? str(first(m.severity, a)) : labels.severity;
    const endsRaw = m.ends_at ? first(m.ends_at, a) : undefined;
    const endsAt =
      typeof endsRaw === 'number' ? new Date(endsRaw > 1e12 ? endsRaw : endsRaw * 1000) : parseTime(str(endsRaw));
    return {
      source: 'generic',
      labels,
      annotations: m.annotations ? labelsOf(first(m.annotations, a)) : {},
      severity: normalizeSeverity(sevRaw),
      status: firing ? 'firing' : 'resolved',
      suppressed: 'none',
      startsAt,
      endsAt: firing ? null : (endsAt ?? now),
      generatorUrl: m.generator_url ? str(first(m.generator_url, a)) || null : null,
      fingerprint: fingerprint(labels),
      alertname,
    } satisfies RawAlert;
  });
}
