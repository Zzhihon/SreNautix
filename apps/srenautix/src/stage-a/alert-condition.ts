import type { Alert, AlertCatalogEntry, EntityRef, EvidenceResult, Labels } from '@srenautix/contract';
import { ClockWindowViolation, DatasourceError, toIso } from '@srenautix/integration-sdk';
import {
  CapabilityMissing,
  cardWindow,
  DEFAULT_WINDOW,
  durationSeconds,
  stepSeconds,
  type CardEntry,
  type EvidenceDataSource,
  type Locale,
  type RunCardInput,
} from '@srenautix/packs-sdk';
import { logger } from '../kernel/log.js';

/** 运行时合成的通用告警条件卡前缀；eval 一致率排除此前缀，避免自证循环。 */
export const GENERIC_ALERT_CONDITION_PREFIX = 'builtin/alert-condition/';

/** 单次事件最多合成的通用告警条件卡数量（按不同 alertname 计），防止告警风暴下放大 Prometheus 查询。 */
export const MAX_GENERIC_ALERT_CONDITIONS = 15;

/** 单次事件最多合成的通用告警条件卡总数（跨全部实体），防止单个 alertname 扇出到大量实体时放大查询。 */
export const MAX_GENERIC_ALERT_CONDITION_CARDS = 30;

const LOOKBACK_MS = 24 * 3600_000;
const SKETCH_POINTS = 300;
const SKETCH_SERIES = 20;
const PROM_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isGenericAlertConditionCard(cardId: string): boolean {
  return cardId.startsWith(GENERIC_ALERT_CONDITION_PREFIX);
}

/** 符合 EvidenceResult.card_id 契约正则（^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_-]*$）的卡片 id */
export function genericAlertConditionCardId(entryIdOrAlertname: string): string {
  const slug = entryIdOrAlertname
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-_]+$/g, '');
  return `${GENERIC_ALERT_CONDITION_PREFIX}${slug || 'alert'}`;
}

export interface GenericAlertConditionTask {
  cardId: string;
  alert: Alert;
  entry: AlertCatalogEntry;
  entity: EntityRef;
  component: string | null;
  latest?: number;
}

export interface GenericAlertConditionInput {
  task: GenericAlertConditionTask;
  anchor: number;
  now: number;
  ds: EvidenceDataSource;
  locale: Locale;
  timeoutMs: number;
  extend?: RunCardInput['extend'];
}

const DEFAULT_AFTER_MS = durationSeconds(DEFAULT_WINDOW.after) * 1000;
const DEFAULT_BEFORE_MS = durationSeconds(DEFAULT_WINDOW.before) * 1000;

function anchorOf(task: GenericAlertConditionTask, anchor: number): number {
  return task.latest !== undefined && task.latest > anchor + DEFAULT_AFTER_MS ? task.latest : anchor;
}

function cleanAnnotation(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function annotationDetail(alert: Alert): string {
  const summary = cleanAnnotation(alert.annotations.summary);
  const desc = cleanAnnotation(alert.annotations.description);
  if (summary && desc && summary !== desc) {
    return `${summary} — ${desc}`;
  }
  return summary || desc;
}

function buildMatchers(
  alert: Alert,
  entry: AlertCatalogEntry,
  entity: EntityRef,
  clusterLabel: string | null,
): {
  base: string[];
  scoped: string[];
  forStateScoped: string[];
  forStateBase: string[];
} {
  const seen = new Set<string>(['alertname', 'alertstate']);
  const base = [`alertname=${JSON.stringify(alert.alertname)}`, 'alertstate="firing"'];
  const forStateBase = [`alertname=${JSON.stringify(alert.alertname)}`];
  if (clusterLabel && PROM_LABEL_NAME.test(clusterLabel) && entity.cluster_id) {
    seen.add(clusterLabel);
    const clusterMatcher = `${clusterLabel}=${JSON.stringify(entity.cluster_id)}`;
    base.push(clusterMatcher);
    forStateBase.push(clusterMatcher);
  }
  const extra: string[] = [];

  for (const [k, v] of Object.entries(entry.match_labels ?? {})) {
    if (!seen.has(k) && PROM_LABEL_NAME.test(k) && typeof v === 'string') {
      seen.add(k);
      extra.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  const nsLabel = entry.entity.namespace_label ?? 'namespace';
  if (
    entity.namespace &&
    !seen.has(nsLabel) &&
    PROM_LABEL_NAME.test(nsLabel) &&
    alert.labels[nsLabel] === entity.namespace
  ) {
    seen.add(nsLabel);
    extra.push(`${nsLabel}=${JSON.stringify(entity.namespace)}`);
  }
  for (const l of entry.entity.name_labels ?? []) {
    const v = alert.labels[l];
    if (!seen.has(l) && PROM_LABEL_NAME.test(l) && typeof v === 'string' && v !== '') {
      seen.add(l);
      extra.push(`${l}=${JSON.stringify(v)}`);
      break;
    }
  }
  return {
    base,
    scoped: [...base, ...extra],
    forStateScoped: [...forStateBase, ...extra],
    forStateBase,
  };
}

function downsample(
  ref: string,
  series: ReadonlyArray<{ labels: Labels; times: number[]; values: Array<number | null> }>,
): EvidenceResult['series'] {
  const out: EvidenceResult['series'] = [];
  for (const s of series.slice(0, SKETCH_SERIES)) {
    const n = s.times.length;
    const idx =
      n <= SKETCH_POINTS
        ? s.times.map((_, i) => i)
        : Array.from({ length: SKETCH_POINTS }, (_, i) => Math.round((i * (n - 1)) / (SKETCH_POINTS - 1)));
    out.push({
      ref,
      labels: s.labels,
      points: idx.map((i) => {
        const v = s.values[i]!;
        return [s.times[i]! / 1000, v === null || Number.isFinite(v) ? v : null] as [number, number | null];
      }),
    });
  }
  return out;
}

function earliestPositiveMs(series: ReadonlyArray<{ times: number[]; values: Array<number | null> }>): number | null {
  let min = Infinity;
  for (const s of series) {
    for (let i = 0; i < s.times.length; i++) {
      const v = s.values[i];
      if (v !== null && v !== undefined && Number.isFinite(v) && v > 0 && s.times[i]! < min) {
        min = s.times[i]!;
      }
    }
  }
  return Number.isFinite(min) ? min : null;
}

function titleOf(alert: Alert, entry: AlertCatalogEntry): { 'zh-CN': string; en: string } {
  if (entry.title && (entry.title['zh-CN'] || entry.title.en)) {
    return {
      'zh-CN': entry.title['zh-CN'] ?? entry.title.en ?? `告警 ${alert.alertname} 状态`,
      en: entry.title.en ?? entry.title['zh-CN'] ?? `Alert ${alert.alertname} state`,
    };
  }
  return {
    'zh-CN': `告警 ${alert.alertname} 状态`,
    en: `Alert ${alert.alertname} state`,
  };
}

/**
 * 为未声明静态 primary_card 的告警目录条目合成运行时通用告警条件卡：
 * 查询 Prometheus / VictoriaMetrics 的 ALERTS{alertname="...", alertstate="firing"} 与 ALERTS_FOR_STATE，
 * 结合告警注解给出阶段 A 判定与证据；无 ALERTS 序列时一律判为 undeterminable（绝不误判为 normal）。
 */
export async function runGenericAlertCondition(
  input: GenericAlertConditionInput,
): Promise<Omit<EvidenceResult, 'ref'> | null> {
  const { task, now, ds, locale, timeoutMs, extend } = input;
  const { alert, entry, entity, cardId } = task;
  const at = anchorOf(task, input.anchor);
  let w: { from: number; to: number };
  try {
    w = cardWindow({ key: cardId, def: { window: DEFAULT_WINDOW } as CardEntry['def'] }, at, now, undefined, extend);
  } catch (err) {
    if (err instanceof RangeError) {
      logger.warn('通用告警条件卡窗口为空，跳过', { card: cardId, alertname: alert.alertname, error: err });
      return null;
    }
    throw err;
  }

  const window = { from: toIso(w.from), to: toIso(w.to) };
  const clock = { from: toIso(at - DEFAULT_BEFORE_MS - LOOKBACK_MS), to: toIso(now) };
  const title = titleOf(alert, entry);
  const queries: EvidenceResult['queries'] = [];

  const makeResult = (
    verdict: EvidenceResult['verdict'],
    displayState: EvidenceResult['display_state'],
    reason: EvidenceResult['reason'],
    extra: {
      series?: EvidenceResult['series'];
      value?: string | null;
      valueNumber?: number | null;
      anomalyStartedAt?: string | null;
      observations?: Record<string, number | string | boolean | null>;
    } = {},
  ): Omit<EvidenceResult, 'ref'> => ({
    card_id: cardId,
    title,
    threshold: null,
    series: extra.series ?? [],
    entity: { ...entity },
    window,
    verdict,
    display_state: displayState,
    reason: { kind: reason.kind, text: reason.text.slice(0, 1000) },
    value: extra.value ?? null,
    table: null,
    queries,
    egress: 'redact',
    anomaly_started_at: extra.anomalyStartedAt ?? null,
    evaluated_at: toIso(now),
    unit: 'none',
    observations: extra.observations ?? {},
    params: {},
    conditions: [],
    baseline: null,
    impact: false,
    category: null,
    value_number: extra.valueNumber ?? null,
  });

  const profile = ds.labelProfile;
  if (!profile) {
    return makeResult('undeterminable', 'capability_missing', {
      kind: 'capability_missing',
      text:
        locale === 'zh-CN'
          ? '指标数据源缺少 metrics.query_range 能力，无法查询 ALERTS 状态'
          : 'Metrics datasource lacks metrics.query_range capability to query ALERTS state',
    });
  }

  const matchers = buildMatchers(alert, entry, entity, profile.cluster ?? null);

  const step = stepSeconds(w.to - w.from, profile);
  const runRange = async (name: string, expr: string) => {
    const started = Date.now();
    try {
      const out = await ds.queryRange({
        expr,
        dialect: 'promql',
        window,
        step_seconds: step,
        clock_window: clock,
        timeout_ms: timeoutMs,
        max_series: 200,
      });
      queries.push({
        name,
        integration: ds.ids.metrics ?? '',
        capability: 'metrics.query_range',
        query: expr,
        sample_count: out.series.reduce((a, s) => a + s.values.filter((v) => v !== null).length, 0),
        truncated: out.truncated,
        error: null,
        duration_ms: Date.now() - started,
      });
      return out.series;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queries.push({
        name,
        integration: ds.ids.metrics ?? '',
        capability: err instanceof CapabilityMissing ? err.capability : 'metrics.query_range',
        query: expr,
        sample_count: 0,
        truncated: false,
        error: message,
        duration_ms: Date.now() - started,
      });
      throw err;
    }
  };

  let activeSeries: Awaited<ReturnType<EvidenceDataSource['queryRange']>>['series'];
  let activeRef = 'alerts';
  let broadened = false;

  try {
    const scopedExpr = `ALERTS{${matchers.scoped.join(', ')}}`;
    activeSeries = await runRange('alerts', scopedExpr);
    if (earliestPositiveMs(activeSeries) === null && matchers.scoped.length > matchers.base.length) {
      const fallbackExpr = `ALERTS{${matchers.base.join(', ')}}`;
      const fallbackSeries = await runRange('alerts_fallback', fallbackExpr);
      if (earliestPositiveMs(fallbackSeries) !== null) {
        activeSeries = fallbackSeries;
        activeRef = 'alerts_fallback';
        broadened = true;
      }
    }
  } catch (err) {
    if (err instanceof CapabilityMissing) {
      return makeResult('undeterminable', 'capability_missing', {
        kind: 'capability_missing',
        text: err.message,
      });
    }
    if (err instanceof DatasourceError || err instanceof ClockWindowViolation) {
      return makeResult('undeterminable', 'undeterminable', {
        kind: 'source_error',
        text: err.message,
      });
    }
    throw err;
  }

  const earliestFiring = earliestPositiveMs(activeSeries);
  const note = annotationDetail(alert);

  if (earliestFiring === null) {
    const baseText =
      locale === 'zh-CN'
        ? `指标后端在窗口内未返回告警 ${alert.alertname} 的 ALERTS firing 序列（可能来自外部 webhook 或未写入 ALERTS），无法判定`
        : `No firing ALERTS series found for ${alert.alertname} in window (may originate from external webhook or lack ALERTS remote-write)`;
    return makeResult(
      'undeterminable',
      'undeterminable',
      {
        kind: 'no_data',
        text: note ? `${baseText}。${note}` : baseText,
      },
      {
        observations: {
          alertname: alert.alertname,
          alertstate: 'absent',
          label_precision: matchers.scoped.length > matchers.base.length ? 'scoped_and_fallback' : 'alertname_only',
        },
      },
    );
  }

  // 尽力读取 ALERTS_FOR_STATE 获取条件首次进入 pending/firing 的起始时间戳；失败时回退到 ALERTS 首个触发点或 alert.starts_at
  let onsetIso: string | null = null;
  const forStateExpr = `ALERTS_FOR_STATE{${(broadened ? matchers.forStateBase : matchers.forStateScoped).join(', ')}}`;
  const fsStart = Date.now();
  try {
    const fs = await ds.query({
      expr: forStateExpr,
      dialect: 'promql',
      time: window.to,
      clock_window: clock,
      timeout_ms: timeoutMs,
    });
    queries.push({
      name: 'alerts_for_state',
      integration: ds.ids.metrics ?? '',
      capability: 'metrics.query',
      query: forStateExpr,
      sample_count: fs.series.reduce((a, s) => a + s.values.filter((v) => v !== null).length, 0),
      truncated: fs.truncated,
      error: null,
      duration_ms: Date.now() - fsStart,
    });
    let minForStateSec = Infinity;
    for (const s of fs.series) {
      for (const v of s.values) {
        if (v !== null && Number.isFinite(v) && v > 1_000_000_000 && v <= now / 1000 + 60 && v < minForStateSec) {
          minForStateSec = v;
        }
      }
    }
    if (Number.isFinite(minForStateSec)) {
      onsetIso = toIso(minForStateSec * 1000);
    }
  } catch (err) {
    // ALERTS_FOR_STATE 是辅助时间戳，不影响主判定
    queries.push({
      name: 'alerts_for_state',
      integration: ds.ids.metrics ?? '',
      capability: 'metrics.query',
      query: forStateExpr,
      sample_count: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - fsStart,
    });
  }

  const parsedAlertStart = Date.parse(alert.starts_at);
  const anomalyStartedAt =
    onsetIso ?? (Number.isFinite(parsedAlertStart) ? toIso(parsedAlertStart) : toIso(earliestFiring));

  const precisionNote = broadened
    ? locale === 'zh-CN'
      ? '（未按实体标签精确匹配，已回退到同名告警查询）'
      : ' (entity labels did not match precisely; fell back to alertname-only match)'
    : '';
  const summaryPrefix =
    locale === 'zh-CN'
      ? `告警 ${alert.alertname} 在窗口内处于 firing 状态${precisionNote}`
      : `Alert ${alert.alertname} was firing in window${precisionNote}`;
  const reasonText = note ? `${summaryPrefix}：${note}` : summaryPrefix;

  return makeResult(
    'abnormal',
    'abnormal',
    { kind: 'rule', text: reasonText },
    {
      series: downsample(activeRef, activeSeries),
      value: locale === 'zh-CN' ? '触发中' : 'firing',
      valueNumber: 1,
      anomalyStartedAt,
      observations: {
        alertname: alert.alertname,
        alertstate: 'firing',
        series_count: activeSeries.length,
        label_precision: broadened ? 'alertname_only' : 'scoped',
      },
    },
  );
}
