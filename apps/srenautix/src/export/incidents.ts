// 事件批量导出（GET /v1/incidents/export，ADR 0186，契约 2.49.0 的 IncidentExport）。筛选条件与 GET /v1/incidents 共用
// incidentConditions；事件按批从状态库读出，附加信息（阶段 A、研判、终态记录、合并、重开、issue）每类一次批量查询，
// Kubernetes Warning 每个集群调用一次 collectKubeWarnings（ADR 0185）。查询数与事件数无关。
import type {
  EvidenceResult,
  ExportedClusterKubeWarnings,
  ExportedConclusion,
  ExportedEvidenceCard,
  ExportedIncident,
  ExportedIssue,
  ExportedReason,
  ExportedSeries,
  IncidentExport,
  IncidentExportFilters,
  IncidentExportGroupBy,
  IncidentExportGroupingParams,
  KubeWarningReport,
  ReasonStage,
} from '@srenautix/contract';
import { reasonEntry } from '@srenautix/contract';
import { incidentOccurrences, isComponentKey, type Occurrence } from '@srenautix/core';
import type pg from 'pg';
import { badRequest } from '../api/errors.js';
import {
  incidentConditions,
  parseCategoryFilters,
  rowCategories,
  type IncidentFilters,
} from '../console-bff/incident-filters.js';
import {
  decodeCursor,
  encodeCursor,
  incidentTarget,
  sortCards,
  visible,
  type Cursor,
} from '../console-bff/routes-incidents.js';
import type { RoleBinding } from '../identity/bindings.js';
import type { IncidentRow } from '../incident/read.js';
import {
  collectKubeWarnings,
  DEFAULT_GROUPING,
  type GroupingOptions,
  type KubeWarningIncident,
  type KubeWarningsDeps,
} from './kube-warnings.js';

/** 导出时间窗的最大跨度 */
export const MAX_EXPORT_SPAN_MS = 31 * 86_400_000;
/** 一次导出的事件数上限（也是 limit 的默认值） */
export const MAX_EXPORT_LIMIT = 5000;
/** 每批从状态库读出的事件行数 */
const BATCH = 1000;
/** 分组参数时长的上限 */
const MAX_GROUPING_MS = 24 * 3600_000;
const MAX_MIN_INCIDENTS = 100;
const SUMMARY_MAX = 300;

export type ExportFormat = 'json' | 'ndjson' | 'md';

export interface ExportRequest {
  from: string;
  to: string;
  filters: IncidentFilters & { suppressed: boolean };
  format: ExportFormat;
  group: IncidentExportGroupBy;
  grouping: GroupingOptions;
  cursor: Cursor | null;
  limit: number;
}

/** 只能出现一次的查询参数 */
function single(query: Record<string, unknown>, key: string): string | null {
  const v = query[key];
  if (v === undefined) {
    return null;
  }
  if (typeof v !== 'string') {
    throw badRequest(`${key} 只能给出一次`);
  }
  if (v === '') {
    throw badRequest(`${key} 不能为空`);
  }
  return v;
}

function timestamp(query: Record<string, unknown>, key: 'from' | 'to'): number {
  const v = single(query, key);
  if (v === null) {
    throw badRequest(`导出需要 ${key}`);
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    throw badRequest(`${key} 不是合法的 RFC 3339 时间：${v}`);
  }
  return t;
}

const DURATION = /^(\d+)(s|m|h)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000 };

function groupingDuration(query: Record<string, unknown>, key: string, fallback: number): number {
  const v = single(query, key);
  if (v === null) {
    return fallback;
  }
  const m = DURATION.exec(v);
  if (!m) {
    throw badRequest(`${key} 必须是形如 30s、30m、2h 的时长：${v}`);
  }
  const ms = Number(m[1]) * (UNIT_MS[m[2] as string] as number);
  if (ms > MAX_GROUPING_MS) {
    throw badRequest(`${key} 不能超过 24h：${v}`);
  }
  return ms;
}

function boundedInt(query: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = single(query, key);
  if (v === null) {
    return fallback;
  }
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw badRequest(`${key} 必须是 ${min}–${max} 的整数：${v}`);
  }
  return Number(v);
}

function oneOf<T extends string>(query: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
  const v = single(query, key);
  if (v === null) {
    return fallback;
  }
  if (!(values as readonly string[]).includes(v)) {
    throw badRequest(`${key} 只能是 ${values.join('、')}：${v}`);
  }
  return v as T;
}

const SEVERITIES = ['critical', 'warning', 'info'] as const;

/** 查询参数 → 导出请求；不合法时 400 */
export function parseExportQuery(query: Record<string, unknown>): ExportRequest {
  const from = timestamp(query, 'from');
  const to = timestamp(query, 'to');
  if (to < from) {
    throw badRequest('to 不能早于 from');
  }
  if (to - from > MAX_EXPORT_SPAN_MS) {
    throw badRequest('from 与 to 相隔不能超过 31 天');
  }
  const severity = single(query, 'severity');
  if (severity !== null && !(SEVERITIES as readonly string[]).includes(severity)) {
    throw badRequest(`severity 只能是 ${SEVERITIES.join('、')}：${severity}`);
  }
  const component = single(query, 'component');
  if (component !== null && !isComponentKey(component)) {
    throw badRequest(`component 的组件键不合法：${component}`);
  }
  const cursor = single(query, 'cursor');
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    filters: {
      ...parseCategoryFilters(query),
      clusterId: single(query, 'cluster_id'),
      severity,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      component,
      suppressed: oneOf(query, 'suppressed', ['true', 'false'], 'false') === 'true',
    },
    format: oneOf(query, 'format', ['json', 'ndjson', 'md'], 'json'),
    group: oneOf(query, 'group', ['incident', 'series'], 'incident'),
    grouping: {
      gapMs: groupingDuration(query, 'group_gap', DEFAULT_GROUPING.gapMs),
      beforeMs: groupingDuration(query, 'group_before', DEFAULT_GROUPING.beforeMs),
      afterMs: groupingDuration(query, 'group_after', DEFAULT_GROUPING.afterMs),
      minIncidents: boundedInt(query, 'group_min_incidents', 1, MAX_MIN_INCIDENTS, DEFAULT_GROUPING.minIncidents),
    },
    cursor: cursor === null ? null : decodeCursor(cursor),
    limit: boundedInt(query, 'limit', 1, MAX_EXPORT_LIMIT, MAX_EXPORT_LIMIT),
  };
}

export interface ExportDeps {
  pool: pg.Pool;
  /** Kubernetes Warning 的依赖（server 配置、证据数据源与拓扑存储，ADR 0185）；每次导出取一次 */
  kubeWarnings: () => Promise<KubeWarningsDeps>;
  now?: () => number;
}

export interface Page {
  rows: IncidentRow[];
  suppressedCount: number;
  more: boolean;
}

/**
 * 按 (first_firing_at, incident_id) 从新到旧分批读出符合条件的事件，过滤掉调用方看不到的与（suppressed=false 时）
 * 被抑制的，直到凑满 limit + 1 条或没有更多行
 */
async function loadPage(pool: pg.Pool, scopes: RoleBinding[] | 'all', req: ExportRequest): Promise<Page> {
  const conditions = incidentConditions(req.filters);
  const rows: IncidentRow[] = [];
  let suppressedCount = 0;
  let after: Cursor | null = req.cursor;
  for (;;) {
    const params: unknown[] = [];
    const where = ["state <> 'merged'"];
    for (const c of conditions) {
      params.push(c.value);
      where.push(c.sql.replaceAll(':p', `$${params.length}`));
    }
    if (after) {
      params.push(after.t, after.id);
      where.push(`(first_firing_at, incident_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(BATCH);
    const r = await pool.query<IncidentRow>(
      `SELECT * FROM server.incidents WHERE ${where.join(' AND ')}
        ORDER BY first_firing_at DESC, incident_id DESC LIMIT $${params.length}`,
      params,
    );
    for (const x of r.rows) {
      if (!visible(scopes, incidentTarget(x.body))) {
        continue;
      }
      if (x.suppressed && !req.filters.suppressed) {
        suppressedCount += 1;
        continue;
      }
      rows.push(x);
      if (rows.length > req.limit) {
        return { rows: rows.slice(0, req.limit), suppressedCount, more: true };
      }
    }
    const last = r.rows.at(-1);
    if (r.rows.length < BATCH || !last) {
      return { rows, suppressedCount, more: false };
    }
    after = { t: last.first_firing_at.toISOString(), id: last.incident_id };
  }
}

interface StageARow {
  incident_id: string;
  incident_version: number;
  disposition: string;
  disposition_reason: string | null;
  cards: EvidenceResult[] | null;
  rendered_at: Date;
}

interface RunRow {
  run_id: string;
  incident_id: string;
  incident_version: number;
  state: string;
  disposition: string | null;
  conclusion_level: string | null;
  summary: string | null;
  stop_reason: string | null;
  undetermined_reason: string | null;
  error: { kind?: string; message?: string } | null;
  started_at: Date;
  finished_at: Date | null;
}

interface SkipRow {
  incident_id: string;
  incident_version: number;
  skip_reason: string;
}

interface ReasonRow {
  incident_id: string;
  incident_version: number | null;
  stage: 'research' | 'stage_a';
  code: string;
  detail: string | null;
}

interface IssueRow {
  incident_id: string;
  repo: string;
  number: number;
  url: string;
  closed_at: Date | null;
  reused_from: string | null;
}

/** 附加信息：每类一次批量查询 */
export interface Facts {
  stageA: Map<string, StageARow>;
  completed: Map<string, RunRow>;
  latestRun: Map<string, RunRow>;
  skips: Map<string, SkipRow>;
  reasons: Map<string, ReasonRow[]>;
  aliases: Map<string, number>;
  reopened: Map<string, number>;
  issues: Map<string, IssueRow[]>;
}

const RUN_COLUMNS = `run_id, incident_id, incident_version, state, disposition, conclusion_level, summary,
  output->>'stop_reason' AS stop_reason, output->'conclusion'->>'undetermined_reason' AS undetermined_reason, error,
  started_at, finished_at`;

function byIncident<T extends { incident_id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((x) => [x.incident_id, x]));
}

function groupByIncident<T extends { incident_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of rows) {
    const list = out.get(x.incident_id);
    if (list) {
      list.push(x);
    } else {
      out.set(x.incident_id, [x]);
    }
  }
  return out;
}

async function loadFacts(pool: pg.Pool, ids: readonly string[]): Promise<Facts> {
  const stageA = await pool.query<StageARow>(
    `SELECT DISTINCT ON (incident_id) incident_id, incident_version, disposition, body->>'disposition_reason' AS disposition_reason,
       body->'cards' AS cards, rendered_at
       FROM server.stage_a_reports WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, incident_version DESC`,
    [ids],
  );
  const completed = await pool.query<RunRow>(
    `SELECT DISTINCT ON (incident_id) ${RUN_COLUMNS} FROM server.research_runs
      WHERE incident_id = ANY($1::uuid[]) AND state = 'completed' ORDER BY incident_id, started_at DESC`,
    [ids],
  );
  const latestRun = await pool.query<RunRow>(
    `SELECT DISTINCT ON (incident_id) ${RUN_COLUMNS} FROM server.research_runs
      WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, started_at DESC`,
    [ids],
  );
  const skips = await pool.query<SkipRow>(
    `SELECT DISTINCT ON (incident_id) incident_id, incident_version, skip_reason FROM server.research_queue
      WHERE incident_id = ANY($1::uuid[]) AND skip_reason IS NOT NULL ORDER BY incident_id, enqueued_at DESC`,
    [ids],
  );
  const reasons = await pool.query<ReasonRow>(
    `SELECT incident_id, incident_version, stage, code, detail FROM server.incident_reasons
      WHERE incident_id = ANY($1::uuid[]) AND stage IN ('research', 'stage_a') ORDER BY incident_id, at, id`,
    [ids],
  );
  const aliases = await pool.query<{ incident_id: string; n: number }>(
    `SELECT into_incident_id AS incident_id, count(*)::int AS n FROM server.incident_aliases
      WHERE into_incident_id = ANY($1::uuid[]) GROUP BY into_incident_id`,
    [ids],
  );
  const reopened = await pool.query<{ incident_id: string; n: number }>(
    `SELECT incident_id, count(*)::int AS n FROM server.incident_versions
      WHERE incident_id = ANY($1::uuid[]) AND reason = 'reopened' GROUP BY incident_id`,
    [ids],
  );
  const issues = await pool.query<IssueRow>(
    `SELECT incident_id, repo, number, url, closed_at, reused_from FROM server.github_issues
      WHERE incident_id = ANY($1::uuid[]) AND number IS NOT NULL AND url IS NOT NULL ORDER BY incident_id, repo, number`,
    [ids],
  );
  return {
    stageA: byIncident(stageA.rows),
    completed: byIncident(completed.rows),
    latestRun: byIncident(latestRun.rows),
    skips: byIncident(skips.rows),
    reasons: groupByIncident(reasons.rows),
    aliases: new Map(aliases.rows.map((x) => [x.incident_id, x.n])),
    reopened: new Map(reopened.rows.map((x) => [x.incident_id, x.n])),
    issues: groupByIncident(issues.rows),
  };
}

function reason(stage: ReasonStage, code: string, detail: string | null): ExportedReason {
  const e = reasonEntry(stage, code);
  return { stage, code, level: e.level, text: e.text['zh-CN'], detail };
}

/**
 * 无法判定的原因码：完成的研判的停止原因；比完成的研判更新的那次研判失败的类型；比完成的研判更新的入队跳过原因；
 * 事件最近一个有终态记录的版本上 research、stage_a 阶段的终态记录（没有版本的记录也算）。同一原因码只列一次
 */
export function undeterminedCodes(id: string, f: Facts): ExportedReason[] {
  const out: ExportedReason[] = [];
  const done = f.completed.get(id);
  if (done?.stop_reason) {
    out.push(reason('research', done.stop_reason, null));
  }
  const last = f.latestRun.get(id);
  if (last && last.state !== 'completed' && last.error?.kind && (!done || last.started_at > done.started_at)) {
    out.push(reason('research', last.error.kind, last.error.message ?? null));
  }
  const skip = f.skips.get(id);
  if (skip && (!done || skip.incident_version > done.incident_version)) {
    out.push(reason('research', skip.skip_reason, null));
  }
  const rs = f.reasons.get(id) ?? [];
  const versions = rs.map((r) => r.incident_version).filter((v): v is number => v !== null);
  const latest = versions.length ? Math.max(...versions) : null;
  for (const r of rs) {
    if (r.incident_version === null || r.incident_version === latest) {
      out.push(reason(r.stage, r.code, r.detail));
    }
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.stage}\0${r.code}`;
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

/** 结论：完成的研判优先，其次阶段 A；处置或档位为 undetermined、或者没有结论时附原因 */
export function conclusionOf(id: string, f: Facts): ExportedConclusion {
  const done = f.completed.get(id);
  const stageA = f.stageA.get(id);
  let c: Omit<ExportedConclusion, 'undetermined'>;
  if (done) {
    c = {
      source: 'research',
      disposition: done.disposition as ExportedConclusion['disposition'],
      conclusion_level: done.conclusion_level as ExportedConclusion['conclusion_level'],
      disposition_reason: null,
      run_id: done.run_id,
      incident_version: done.incident_version,
      at: (done.finished_at ?? done.started_at).toISOString(),
      summary: done.summary,
    };
  } else if (stageA) {
    c = {
      source: 'stage_a',
      disposition: stageA.disposition as ExportedConclusion['disposition'],
      conclusion_level: null,
      disposition_reason: stageA.disposition_reason,
      run_id: null,
      incident_version: stageA.incident_version,
      at: stageA.rendered_at.toISOString(),
      summary: null,
    };
  } else {
    c = {
      source: 'none',
      disposition: null,
      conclusion_level: null,
      disposition_reason: null,
      run_id: null,
      incident_version: null,
      at: null,
      summary: null,
    };
  }
  const undetermined =
    c.source === 'none' || c.disposition === 'undetermined' || c.conclusion_level === 'undetermined'
      ? { codes: undeterminedCodes(id, f), undetermined_reason: done?.undetermined_reason ?? null }
      : null;
  return { ...c, undetermined };
}

/** 判定说明的第一句（到第一个句号、问号、叹号或换行） */
function firstSentence(text: string): string {
  const m = /^[^。！？\n]*[。！？]?/.exec(text.trim());
  return (m?.[0] ?? '').trim();
}

/** abnormal 与 undeterminable 的证据卡，abnormal 在前 */
export function evidenceOf(cards: readonly EvidenceResult[]): ExportedEvidenceCard[] {
  return sortCards(cards.filter((c) => c.verdict === 'abnormal' || c.verdict === 'undeterminable')).map((c) => {
    const sentence = firstSentence(c.reason.text);
    const summary = c.value ? (sentence ? `${c.value}：${sentence}` : c.value) : sentence;
    return {
      ref: c.ref,
      card_id: c.card_id,
      title: c.title,
      verdict: c.verdict as ExportedEvidenceCard['verdict'],
      reason_kind: c.reason.kind,
      summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    };
  });
}

function issueOf(r: IssueRow): ExportedIssue {
  return {
    repo: r.repo,
    number: r.number,
    url: r.url,
    state: r.closed_at ? 'closed' : 'open',
    reused: r.reused_from !== null,
  };
}

/** 仍在的成员与离开之前已经恢复的成员（与 incidentOccurrences 的取法相同） */
function countedMembers(row: IncidentRow) {
  return row.body.members.filter((m) => !(m.left_version !== null && m.ends_at === null));
}

function firingSeconds(os: readonly Occurrence[], now: number): number {
  return Math.round(os.reduce((s, o) => s + ((o.end ?? now) - o.start), 0) / 1000);
}

const isoMax = (xs: readonly string[]): string => xs.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/** 一个事件的导出内容（kube_warnings 由调用方填入） */
export function exportedIncident(row: IncidentRow, f: Facts, now: number): Omit<ExportedIncident, 'kube_warnings'> {
  const members = countedMembers(row);
  const occurrences = incidentOccurrences([row.body]);
  const firstFiring = row.first_firing_at.toISOString();
  const cats = rowCategories(row);
  return {
    incident_id: row.incident_id,
    cluster_id: row.cluster_id,
    label: row.label,
    state: row.state as ExportedIncident['state'],
    severity: row.body.severity,
    categories: cats.categories,
    primary_category: cats.primary_category,
    alertnames: [...new Set(members.map((m) => m.alertname))].sort(),
    root: { component: row.body.root.component, entity: row.body.root.entity, ambiguous: row.body.root.ambiguous },
    components: row.body.components,
    first_firing_at: firstFiring,
    last_firing_at: members.length ? isoMax(members.map((m) => m.starts_at)) : firstFiring,
    ended_at: row.ended_at?.toISOString() ?? null,
    firing_seconds: firingSeconds(occurrences, now),
    occurrences: occurrences.length,
    merged_count: f.aliases.get(row.incident_id) ?? 0,
    reopened_count: f.reopened.get(row.incident_id) ?? 0,
    series_key: row.series_key,
    conclusion: conclusionOf(row.incident_id, f),
    evidence: evidenceOf(f.stageA.get(row.incident_id)?.cards ?? []),
    issues: (f.issues.get(row.incident_id) ?? []).map(issueOf),
  };
}

/**
 * 按系列汇总：有系列键时按系列键，没有时按 <根因组件>|<告警名,…>；同一集群内汇总。发生次数与累计时长按全部事件的
 * 成员告警触发区间合并后计算（ADR 0184 的 incidentOccurrences），issue 按 repo 与 number 去重
 */
export function seriesOf(
  rows: readonly IncidentRow[],
  incidents: readonly ExportedIncident[],
  now: number,
): ExportedSeries[] {
  const groups = new Map<string, { key: string; stored: boolean; rows: IncidentRow[]; items: ExportedIncident[] }>();
  rows.forEach((row, i) => {
    const item = incidents[i] as ExportedIncident;
    const key = row.series_key ?? `${row.body.root.component ?? ''}|${item.alertnames.join(',')}`;
    const g = groups.get(`${row.cluster_id}\0${key}`);
    if (g) {
      g.rows.push(row);
      g.items.push(item);
    } else {
      groups.set(`${row.cluster_id}\0${key}`, { key, stored: row.series_key !== null, rows: [row], items: [item] });
    }
  });
  const out: ExportedSeries[] = [];
  for (const g of groups.values()) {
    const occurrences = incidentOccurrences(g.rows.map((r) => r.body));
    const issues = new Map<string, ExportedIssue>();
    for (const it of g.items) {
      for (const x of it.issues) {
        const k = `${x.repo}#${x.number}`;
        const prev = issues.get(k);
        // 开出 issue 的那个事件在导出范围内时，这个 issue 不算复用
        issues.set(k, prev ? { ...prev, reused: prev.reused && x.reused, state: x.state } : x);
      }
    }
    const first = g.items.at(-1) as ExportedIncident;
    out.push({
      key: g.key,
      key_source: g.stored ? 'series_key' : 'alertnames_root',
      cluster_id: first.cluster_id,
      root_component: first.root.component,
      alertnames: [...new Set(g.items.flatMap((x) => x.alertnames))].sort(),
      occurrences: occurrences.length,
      firing_seconds: firingSeconds(occurrences, now),
      first_firing_at: g.items.map((x) => x.first_firing_at).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)),
      last_firing_at: isoMax(g.items.map((x) => x.last_firing_at)),
      ended_at: g.items.some((x) => x.ended_at === null) ? null : isoMax(g.items.map((x) => x.ended_at as string)),
      incident_ids: g.items.map((x) => x.incident_id),
      issues: [...issues.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number),
    });
  }
  return out.sort((a, b) => Date.parse(b.last_firing_at) - Date.parse(a.last_firing_at) || a.key.localeCompare(b.key));
}

/** 事件的 Warning 计数时间窗：事件时间窗限定在导出时间窗与计算时刻之内 */
export function warningWindow(row: IncidentRow, req: Pick<ExportRequest, 'from' | 'to'>, now: number) {
  const to = Math.min(row.ended_at?.getTime() ?? now, Date.parse(req.to), now);
  const from = Math.min(Math.max(row.first_firing_at.getTime(), Date.parse(req.from)), to);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function groupingParams(g: GroupingOptions): IncidentExportGroupingParams {
  return {
    gap_seconds: Math.round(g.gapMs / 1000),
    before_seconds: Math.round(g.beforeMs / 1000),
    after_seconds: Math.round(g.afterMs / 1000),
    min_incidents: g.minIncidents,
  };
}

function filtersOf(req: ExportRequest): IncidentExportFilters {
  return {
    cluster_id: req.filters.clusterId,
    severity: req.filters.severity as IncidentExportFilters['severity'],
    component: req.filters.component,
    category: req.filters.category,
    exclude_category: req.filters.excludeCategory,
    exclude_component: req.filters.excludeComponent,
    suppressed: req.filters.suppressed,
  };
}

/** 执行一次导出 */
export async function exportIncidents(
  d: ExportDeps,
  scopes: RoleBinding[] | 'all',
  req: ExportRequest,
): Promise<IncidentExport> {
  const now = (d.now ?? Date.now)();
  const page = await loadPage(d.pool, scopes, req);
  const facts = await loadFacts(
    d.pool,
    page.rows.map((r) => r.incident_id),
  );
  const reports: KubeWarningReport[] = [];
  const clusters = [...new Set(page.rows.map((r) => r.cluster_id))].sort();
  if (clusters.length) {
    const deps = { ...(await d.kubeWarnings()), grouping: req.grouping, now: () => now };
    for (const cluster of clusters) {
      reports.push(
        await collectKubeWarnings(deps, {
          cluster_id: cluster,
          incidents: warningInputs(
            page.rows.filter((r) => r.cluster_id === cluster),
            req,
            now,
          ),
        }),
      );
    }
  }
  return assembleExport({ req, ...page, facts, reports, now });
}

/** 一个集群的事件 → collectKubeWarnings 的输入 */
export function warningInputs(rows: readonly IncidentRow[], req: Pick<ExportRequest, 'from' | 'to'>, now: number) {
  return rows.map((r): KubeWarningIncident => ({
    incident_id: r.incident_id,
    window: warningWindow(r, req, now),
    components: r.body.components,
    alertnames: [...new Set(countedMembers(r).map((m) => m.alertname))].sort(),
  }));
}

export interface ExportParts extends Page {
  req: ExportRequest;
  facts: Facts;
  /** 每个导出了事件的集群一份，按 cluster_id 排序 */
  reports: readonly KubeWarningReport[];
  now: number;
}

/** 由读出的事件、附加信息与各集群的 Warning 报告组成导出结果 */
export function assembleExport(p: ExportParts): IncidentExport {
  const summaries = new Map(p.reports.flatMap((r) => r.summaries.map((s) => [s.incident_id, s] as const)));
  const incidents: ExportedIncident[] = p.rows.map((r) => {
    const s = summaries.get(r.incident_id);
    if (!s) {
      throw new Error(`事件 ${r.incident_id} 没有 Kubernetes Warning 摘要`);
    }
    return { ...exportedIncident(r, p.facts, p.now), kube_warnings: s };
  });
  const kube: ExportedClusterKubeWarnings[] = p.reports.map((r) => ({
    cluster_id: r.cluster_id,
    window: r.window,
    step_seconds: r.step_seconds,
    complete: r.complete,
    queries: r.queries,
    groups: r.groups,
  }));
  const last = p.rows.at(-1);
  return {
    generated_at: new Date(p.now).toISOString(),
    window: { from: p.req.from, to: p.req.to },
    filters: filtersOf(p.req),
    group: p.req.group,
    grouping: groupingParams(p.req.grouping),
    incidents,
    // md 总是带系列汇总（给人读的导出先分组、再按系列汇总、最后是事件明细）
    series: p.req.group === 'series' || p.req.format === 'md' ? seriesOf(p.rows, incidents, p.now) : null,
    kube_warnings: kube,
    suppressed_count: p.suppressedCount,
    complete: kube.every((k) => k.complete),
    truncated: p.more,
    next_cursor: p.more && last ? encodeCursor({ t: last.first_firing_at.toISOString(), id: last.incident_id }) : null,
  };
}
