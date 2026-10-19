// 接入归一化：Alertmanager webhook 与 API v2 的告警 → 契约中的 Alert（DESIGN §3）
import type { Alert, AlertmanagerAlert, AlertmanagerWebhook, ClusterId, Labels, Severity } from '@srenautix/contract';
import { type AlertCatalog, classifyAlert } from './classify.js';
import { alertEntityCandidate, type EntityResolver } from './entity.js';
import { formatTime, isZeroTime, parseTime } from './time.js';

const IGNORED_LABELS = new Set(['__name__', 'alertstate', 'alertgroup']);

export function identityLabels(labels: Labels): Labels {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([k]) => !IGNORED_LABELS.has(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** 标签集的 FNV-1a 64 位哈希（按键排序，键值之间用 0xff 分隔），16 位十六进制 */
export function labelsFingerprint(labels: Labels): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder();
  for (const [k, v] of Object.entries(identityLabels(labels))) {
    for (const part of [k, v]) {
      for (const b of bytes.encode(part)) {
        h ^= BigInt(b);
        h = (h * prime) & 0xffffffffffffffffn;
      }
      h ^= 0xffn;
      h = (h * prime) & 0xffffffffffffffffn;
    }
  }
  return h.toString(16).padStart(16, '0');
}

const SEVERITIES = new Set<Severity>(['critical', 'warning', 'info']);

/** Watchdog、InfoInhibitor 与 severity=none 的告警不进入事件 */
export function isIgnorable(labels: Labels): boolean {
  return (
    !labels.alertname ||
    labels.alertname === 'Watchdog' ||
    labels.alertname === 'InfoInhibitor' ||
    labels.severity === 'none'
  );
}

export interface NormalizeContext {
  clusterId: ClusterId;
  source: Alert['source'];
  receivedAt: number;
  catalog: AlertCatalog;
  resolver: EntityResolver;
  /** rules API 中的规则表达式，按告警名 */
  ruleExprs?: ReadonlyMap<string, string>;
  /** 长期告警判断（告警名 × 实体，7 天触发率）；不提供时视为非长期 */
  chronic?: (alertname: string, entityKeyOrNull: string | null) => boolean;
  now: number;
}

export async function normalizeAlert(raw: AlertmanagerAlert, ctx: NormalizeContext): Promise<Alert | null> {
  const labels = identityLabels(raw.labels);
  if (isIgnorable(labels)) {
    return null;
  }
  const startsAt = parseTime(raw.startsAt);
  const resolved =
    raw.status === 'resolved' ||
    (!isZeroTime(raw.endsAt) && typeof raw.status === 'string' && parseTime(raw.endsAt!) <= ctx.now);
  const status = typeof raw.status === 'object' ? raw.status : undefined;
  const suppressed: Alert['suppressed'] =
    status?.state !== 'suppressed' ? 'none' : (status.silencedBy?.length ?? 0) > 0 ? 'silenced' : 'inhibited';
  const hit = ctx.catalog.lookup(labels);
  const candidate = alertEntityCandidate(labels, hit?.entry, ctx.clusterId);
  const resolution = await ctx.resolver.resolve(candidate, startsAt, ctx.now);
  const entityRef = resolution.entity;
  const ek = entityRef ? `${entityRef.kind}:${entityRef.namespace ?? ''}/${entityRef.name}` : null;
  const classification = classifyAlert(
    { labels, ruleExpr: ctx.ruleExprs?.get(labels.alertname!), chronic: ctx.chronic?.(labels.alertname!, ek) ?? false },
    ctx.catalog,
  );
  const fp = labelsFingerprint(labels);
  return {
    alert_id: `${fp}@${Math.floor(startsAt / 1000)}`,
    cluster_id: ctx.clusterId,
    source: ctx.source,
    fingerprint: fp,
    alertname: labels.alertname!,
    labels,
    annotations: raw.annotations ?? {},
    severity: SEVERITIES.has(labels.severity as Severity) ? (labels.severity as Severity) : 'warning',
    status: resolved ? 'resolved' : 'firing',
    suppressed,
    starts_at: formatTime(startsAt),
    ends_at: resolved && !isZeroTime(raw.endsAt) ? formatTime(parseTime(raw.endsAt!)) : null,
    generator_url: raw.generatorURL ?? null,
    classification,
    entity: entityRef,
    entity_resolution: resolution.layer,
    component: resolution.component,
    received_at: formatTime(ctx.receivedAt),
  };
}

export async function normalizeWebhook(body: AlertmanagerWebhook, ctx: NormalizeContext): Promise<Alert[]> {
  const out: Alert[] = [];
  for (const a of body.alerts) {
    const n = await normalizeAlert(a, ctx);
    if (n) {
      out.push(n);
    }
  }
  return out;
}
