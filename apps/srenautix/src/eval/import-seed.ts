import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import type {
  ChangeEvent,
  EvalCase,
  EvalSnapshot,
  EvidenceResult,
  Incident,
  IncidentMember,
  MetricSeries,
  StageAReport,
} from '@srenautix/contract';
import { logger } from '../log.js';
import type { CaseStore } from './store.js';

// 旧版 Ops-Agent 回放种子（format=cchp-srenautix-seed，version 1，自描述的 zstd JSON Lines，说明见种子目录的 FORMAT.md）
// 的导入器：每个导出单元转换为一个评测用例与一份快照。
//
// 对应关系：
// - 旧版组件 id → 组件键 legacy.component:<id>（旧版没有 Kubernetes 对象级的组件）；
// - 单元的 incident → 契约 Incident；根因组件是唯一的候选；告警 → 成员；变更 → ChangeEvent；
// - 单元的 cards（事件自身与两跳邻域的证据链、自动检查）→ 阶段 A 的证据卡结果（card_id 为 legacy/<链>/<序号>）；
//   异常卡的异常起始时间取所在告警的 activeAt（邻域组件范围的卡没有告警，为 null）；
// - neighborhood 与 catalog.json 的依赖边 → 两跳拓扑子图；
// - 调用 → 查询快照条目：prom range → query_range，prom instant → query，loki_lines → logs_query，tempo_search → traces_search；
//   与单元日志窗口重叠的日志块按日志组合并为一条 logs_query；单元用到的原始序列（5 分钟 rollup）合并为一条 query_range；
// - 标准答案：知识条目的 root_component（truth_source=knowledge），或快照行的 ground_truth.root_component（truth_source=imported）；
//   都没有时用例进入 <suite>-unlabeled（"稍后标注"）；
// - 防泄漏：learned_from_keys 含用例自己的知识条目 id 与事件键，知识条目都带 learned_from。

export const LEGACY_SEED_FORMAT = 'cchp-srenautix-seed';
export const COMPONENT_KIND = 'legacy.component';
/** 每个单元每个日志组最多保留的日志行（最新的在前） */
export const MAX_LOG_LINES_PER_GROUP = 5000;

type Rec = Record<string, unknown>;

interface LegacyAlert {
  id: string;
  alertname: string;
  component: string;
  role: string;
  severity: string;
  status: string;
  activeAt: number;
  firedAt: number;
  endedAt?: number;
  summary: string;
}

interface LegacyIncident {
  key: string;
  root: string;
  severity: string;
  state: string;
  firstFiring: number;
  endedAt?: number;
  alerts: LegacyAlert[];
  components: string[];
  changes: Array<{ time: number; kind: string; components: string[]; title: string; detail: string }>;
  chain: string;
}

interface Unit {
  unit: string;
  origin: string;
  incident_key: string;
  case_ids: string[];
  snapshot_ids: string[];
  first_firing_at: string;
  end_at: string;
  windows: Record<string, { from: string; to: string }>;
  incident: LegacyIncident;
  neighborhood: { seeds: string[]; components: Array<{ id: string; hops: number }> };
  cards: Array<{
    scope: string;
    card: string;
    title: string;
    verdict: string;
    value: string | null;
    reason: string;
    calls: string[];
  }>;
  log_groups: string[];
  log_window: { from: string; to: string };
}

interface Call {
  unit: string;
  id: string;
  op: string;
  request: Rec & {
    query?: string;
    expr?: string;
    range?: boolean;
    window?: { from: number; to: number };
    step?: number;
    time?: number;
    limit?: number;
    q?: string;
  };
  status: string;
  error: string | null;
  result: unknown;
}

export interface ImportOptions {
  dir: string;
  suite: string;
  clusterId: string;
  store: CaseStore;
}

export interface ImportSummary {
  units: number;
  cases: number;
  labeled: number;
  unlabeled: number;
  skipped: Array<{ unit: string; reason: string }>;
  entries: number;
}

/** 逐行读取一个 zstd JSON Lines 文件；第一行必须是本格式的文件头 */
export async function* readJsonl(file: string): AsyncGenerator<Rec> {
  const input = createReadStream(file).pipe(createZstdDecompress());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) {
    if (!line) {
      continue;
    }
    const rec = JSON.parse(line) as Rec;
    if (first) {
      first = false;
      if (rec.type !== 'header' || rec.format !== LEGACY_SEED_FORMAT || rec.version !== 1) {
        throw new Error(`${file} 的文件头不是 ${LEGACY_SEED_FORMAT} v1：${line.slice(0, 200)}`);
      }
      continue;
    }
    yield rec;
  }
  if (first) {
    throw new Error(`${file} 是空文件`);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** 由字符串确定性地生成 UUID（sha256 前 16 字节，按 RFC 9562 第 8 版设置版本与变体位） */
export function stableUuid(namespace: string, name: string): string {
  const h = createHash('sha256').update(`${namespace}\0${name}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function slug(s: string): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return v || 'x';
}

export function componentKey(id: string): string {
  const name = id.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (!name) {
    throw new Error(`旧版组件 id 无法转换为组件键：${JSON.stringify(id)}`);
  }
  return `${COMPONENT_KIND}:${name}`;
}

function entity(clusterId: string, id: string): EvidenceResult['entity'] {
  return {
    cluster_id: clusterId,
    kind: COMPONENT_KIND,
    namespace: null,
    name: componentKey(id).slice(COMPONENT_KIND.length + 1),
    uid: null,
  };
}

const ROLES = new Set(['cause', 'change', 'symptom', 'forecast', 'meta']);
const SEVERITIES = new Set(['critical', 'warning', 'info']);
const CHANGE_KINDS: Record<string, ChangeEvent['kind']> = {
  release: 'ci_deploy',
  argocd: 'gitops_sync',
  migration: 'other',
  cnpg: 'operator',
};

/** 稳定标签 <根组件键>:<首次触发时间取整到 10 分钟> */
function label(root: string, firstFiring: number): string {
  const bucket = new Date(Math.floor(firstFiring / 600_000) * 600_000).toISOString().replace('.000Z', 'Z');
  return `${componentKey(root)}:${bucket}`;
}

export function convertIncident(u: Unit, clusterId: string, now: string): Incident {
  const inc = u.incident;
  const id = stableUuid('incident', u.incident_key);
  const members: IncidentMember[] = inc.alerts.map((a) => ({
    alert_id: a.id,
    alertname: a.alertname,
    role: (ROLES.has(a.role) ? a.role : 'symptom') as IncidentMember['role'],
    component: a.component ? componentKey(a.component) : null,
    severity: (SEVERITIES.has(a.severity) ? a.severity : 'info') as IncidentMember['severity'],
    status: a.status === 'firing' ? 'firing' : 'resolved',
    starts_at: iso(a.activeAt),
    ends_at: a.endedAt === undefined ? null : iso(a.endedAt),
    joined_version: 1,
    left_version: null,
  }));
  const root = componentKey(inc.root);
  return {
    incident_id: id,
    cluster_id: clusterId,
    label: label(inc.root, inc.firstFiring),
    incident_version: 1,
    state: inc.state === 'firing' ? 'firing' : 'resolved',
    severity: (SEVERITIES.has(inc.severity) ? inc.severity : 'warning') as Incident['severity'],
    first_firing_at: u.first_firing_at,
    ended_at: inc.endedAt === undefined ? null : iso(inc.endedAt),
    root: { component: root, entity: entity(clusterId, inc.root), ambiguous: false, margin: null, silent_root: false },
    candidates: [
      {
        component: root,
        score: 1,
        terms: { coverage: 1, precedence: 1, role_prior: 1, recent_change: 0, chronic_penalty: 0 },
        depth: 0,
        explains: members.filter((m) => m.role === 'symptom').map((m) => m.alert_id),
        source: 'alert',
      },
    ],
    members,
    components: [...new Set(inc.components.map(componentKey))],
    changes: inc.changes.map((ch, i) => ({
      change_id: `legacy:${u.incident_key}#${i + 1}`,
      source: `legacy-${slug(ch.kind)}`,
      kind: CHANGE_KINDS[ch.kind] ?? 'other',
      refs: [],
      revision: null,
      actor: null,
      time: iso(ch.time),
      link: null,
      targets: ch.components.map(componentKey),
      summary: `${ch.title}：${ch.detail}`.slice(0, 500),
    })),
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 0,
    created_at: u.first_firing_at,
    updated_at: now,
  };
}

const VERDICTS: Record<string, EvidenceResult['verdict']> = {
  ok: 'normal',
  abnormal: 'abnormal',
  undeterminable: 'undeterminable',
};

/** 卡片范围 <链>@<告警 id> 或 <链>@component:<组件> → 组件与告警 */
function scopeOf(scope: string, inc: LegacyIncident): { component: string; alert: LegacyAlert | null } {
  const at = scope.indexOf('@');
  const target = at < 0 ? '' : scope.slice(at + 1);
  if (target.startsWith('component:')) {
    return { component: target.slice('component:'.length), alert: null };
  }
  const alert = inc.alerts.find((a) => a.id === target) ?? null;
  return { component: alert?.component || inc.root, alert };
}

export function convertCards(u: Unit, clusterId: string): EvidenceResult[] {
  const window = { from: u.windows.R?.from ?? u.first_firing_at, to: u.end_at };
  return u.cards.map((c, i) => {
    const { component, alert } = scopeOf(c.scope, u.incident);
    const [chain, n] = c.card.startsWith('check.')
      ? ['checks', c.card.slice(6)]
      : [c.card.slice(0, c.card.lastIndexOf('.')), c.card.slice(c.card.lastIndexOf('.') + 1)];
    const verdict = VERDICTS[c.verdict];
    if (!verdict) {
      throw new Error(`单元 ${u.unit} 的卡 ${c.card} 判定未知：${c.verdict}`);
    }
    return {
      ref: `card:${i + 1}`,
      card_id: `legacy/${slug(chain as string)}/${slug(n as string).replace(/\./g, '-')}`,
      title: { 'zh-CN': c.title },
      threshold: null,
      series: [],
      entity: entity(clusterId, component),
      window,
      verdict,
      display_state: verdict,
      reason: {
        kind: verdict === 'abnormal' ? 'rule' : verdict === 'normal' ? 'all_clear' : 'no_data',
        text: c.reason.slice(0, 1000),
      },
      value: c.value,
      table: null,
      queries: [],
      egress: 'redact',
      anomaly_started_at: verdict === 'abnormal' && alert ? iso(alert.activeAt) : null,
      evaluated_at: u.end_at,
    };
  });
}

function fingerprint(cards: EvidenceResult[]): string {
  const v = cards.map((c) => `${c.card_id}@${c.entity?.name ?? ''}=${c.verdict}`).sort();
  return `sha256:${createHash('sha256').update(v.join('\n')).digest('hex')}`;
}

export function stageA(u: Unit, inc: Incident, cards: EvidenceResult[]): StageAReport {
  const blind = cards.length > 0 && cards.filter((c) => c.verdict === 'undeterminable').length / cards.length >= 0.5;
  return {
    report_id: stableUuid('stage-a', u.unit),
    incident_id: inc.incident_id,
    incident_version: 1,
    disposition: blind ? 'escalate' : 'undetermined',
    disposition_reason: blind ? 'observability_blind' : 'default',
    candidates: inc.candidates,
    ambiguous: false,
    cards,
    evidence_fingerprint: fingerprint(cards),
    observability_blind: blind,
    timeline: [],
    runbooks: [],
    rule_proposals: [],
    degraded: false,
    rendered_at: u.end_at,
  };
}

function subgraph(u: Unit, edges: Array<{ caller: string; callee: string }>): EvalSnapshot['context']['subgraph'] {
  const ids = new Set(u.neighborhood.components.map((c) => c.id));
  const seeds = new Set(u.neighborhood.seeds);
  return {
    topology_version: 0,
    root: componentKey(u.incident.root),
    nodes: u.neighborhood.components.map((c) => ({
      component: componentKey(c.id),
      kind: COMPONENT_KIND,
      namespace: null,
      name: componentKey(c.id).slice(COMPONENT_KIND.length + 1),
      role: c.id === u.incident.root ? 'root' : seeds.has(c.id) ? 'member' : 'neighbor',
      alerts: u.incident.alerts.filter((a) => a.component === c.id).map((a) => a.id),
      hops: Math.min(2, c.hops),
    })),
    edges: edges
      .filter((e) => ids.has(e.caller) && ids.has(e.callee))
      .map((e) => ({
        from: componentKey(e.caller),
        to: componentKey(e.callee),
        relation: 'depends_on',
        provenance: 'structural' as const,
        confidence: 1,
        scope: 'service' as const,
      })),
  };
}

type Entry = EvalSnapshot['queries']['entries'][number];

function seriesResult(
  series: Array<{ labels: Record<string, string>; times: number[]; values: Array<number | null> }>,
  warnings: string[] = [],
) {
  return {
    series: series.map((s): MetricSeries => ({ labels: s.labels, times: s.times, values: s.values })),
    truncated: false,
    warnings,
  };
}

/** 一次旧版调用 → 查询快照条目；不对应任何集成能力的调用（告警状态、单条 trace）返回 null */
export function callEntry(c: Call): Entry | null {
  const r = c.request;
  const error =
    c.status === 'ok' ? undefined : { kind: 'datasource' as const, message: (c.error ?? 'error').slice(0, 1000) };
  const window = r.window ? { from: iso(r.window.from), to: iso(r.window.to) } : undefined;
  switch (c.op) {
    case 'prom':
      if (r.range) {
        const request = { expr: String(r.query ?? r.expr), dialect: 'metricsql', window, step_seconds: Number(r.step) };
        return error
          ? { op: 'query_range', request, error }
          : { op: 'query_range', request, result: seriesResult(c.result as never) };
      } else {
        const request = { expr: String(r.query ?? r.expr), dialect: 'metricsql', time: iso(Number(r.time) * 1000) };
        return error
          ? { op: 'query', request, error }
          : { op: 'query', request, result: seriesResult(c.result as never) };
      }
    case 'loki_lines': {
      const request = { query: String(r.query ?? r.expr), dialect: 'logql', window, limit: Number(r.limit) };
      if (error) {
        return { op: 'logs_query', request, error };
      }
      const res = c.result as { streams: Array<Record<string, string>>; lines: Array<[number, number, string]> };
      return {
        op: 'logs_query',
        request,
        result: {
          lines: res.lines.map(([s, t, line]) => ({ time: iso(t), labels: res.streams[s] ?? {}, line })),
          truncated: false,
        },
      };
    }
    case 'tempo_search': {
      const request = { query: String(r.q), dialect: 'traceql', window, limit: Number(r.limit) };
      return error
        ? { op: 'traces_search', request, error }
        : { op: 'traces_search', request, result: { traces: c.result } };
    }
    default:
      return null;
  }
}

interface Pending {
  u: Unit;
  calls: Entry[];
  logs: Map<string, { query: string; lines: Array<{ time: string; labels: Record<string, string>; line: string }> }>;
  raw: Map<
    string,
    {
      selector: string;
      series: Map<string, { labels: Record<string, string>; times: number[]; values: Array<number | null> }>;
    }
  >;
}

export async function importSeed(o: ImportOptions): Promise<ImportSummary> {
  const now = new Date().toISOString();
  const catalog = JSON.parse(readFileSync(join(o.dir, 'catalog.json'), 'utf8')) as Rec;
  if (catalog.format !== LEGACY_SEED_FORMAT || catalog.version !== 1) {
    throw new Error(`catalog.json 不是 ${LEGACY_SEED_FORMAT} v1`);
  }
  const topo = catalog.topology as { edges: Array<{ caller: string; callee: string }> };
  const knowledgeCases = (catalog.knowledge_cases ?? []) as Array<
    Rec & {
      id: string;
      title: string;
      mechanism?: string;
      root_component: string;
      components: string[];
      misjudgement_hints?: string[];
      effective_window: { from: string; to: string };
    }
  >;
  const summary: ImportSummary = { units: 0, cases: 0, labeled: 0, unlabeled: 0, skipped: [], entries: 0 };

  // 第一遍：单元、知识条目的事件选择、快照行的标准答案
  const units = new Map<string, Unit>();
  const caseByUnit = new Map<string, Rec[]>();
  for await (const r of readJsonl(join(o.dir, 'units.jsonl.zst'))) {
    if (r.type === 'unit') {
      units.set(r.unit as string, r as unknown as Unit);
    } else if (r.type === 'case' && typeof r.unit === 'string') {
      caseByUnit.set(r.unit, [...(caseByUnit.get(r.unit) ?? []), r]);
    }
  }
  const truthBySnapshot = new Map<string, string>();
  if (existsSync(join(o.dir, 'snapshots.jsonl.zst'))) {
    for await (const r of readJsonl(join(o.dir, 'snapshots.jsonl.zst'))) {
      const row = r.row as Rec | undefined;
      const gt = row?.ground_truth as Rec | null | undefined;
      if (r.type === 'snapshot' && row && gt && typeof gt.root_component === 'string') {
        truthBySnapshot.set(row.snapshot_id as string, gt.root_component);
      }
    }
  }

  // 知识条目：可检索的材料，learned_from 指向它的来源（知识条目 id 与所选事件键）
  const knowledge = knowledgeCases.map((k) => {
    const picked = [...caseByUnit.values()].flat().find((x) => x.case_id === k.id);
    return {
      id: `legacy/${slug(k.id)}`,
      components: k.components.map(componentKey),
      text: [k.title, k.mechanism ?? '', ...(k.misjudgement_hints ?? [])].filter(Boolean).join('\n').slice(0, 4000),
      learned_from: [k.id, ...(picked?.picked_incident_key ? [picked.picked_incident_key as string] : [])],
      learned_at: k.effective_window.to,
      source: 'human' as const,
    };
  });
  const references = knowledgeCases.map((k) => ({
    incident_id: stableUuid('knowledge', k.id),
    label: label(k.root_component, Date.parse(k.effective_window.from)),
    root_component: componentKey(k.root_component),
    mechanism: k.mechanism ?? null,
    resolved_at: k.effective_window.to,
    source: 'human' as const,
  }));

  const pending = new Map<string, Pending>();
  for (const u of units.values()) {
    if (!u.incident.root) {
      summary.skipped.push({ unit: u.unit, reason: '事件没有根组件（以知识条目时间窗为单元，没有告警）' });
      continue;
    }
    pending.set(u.unit, { u, calls: [], logs: new Map(), raw: new Map() });
  }

  // 第二遍：单元的数据源调用
  for await (const r of readJsonl(join(o.dir, 'calls.jsonl.zst'))) {
    if (r.type !== 'call') {
      continue;
    }
    const p = pending.get(r.unit as string);
    const e = p ? callEntry(r as unknown as Call) : null;
    if (p && e) {
      p.calls.push(e);
    }
  }

  // 日志块：每个单元按日志组合并窗口内的行
  if (existsSync(join(o.dir, 'logs.jsonl.zst'))) {
    const chunkByUnit = new Map<string, { group: string; query: string }>();
    for await (const r of readJsonl(join(o.dir, 'logs.jsonl.zst'))) {
      if (r.type === 'log_chunk') {
        chunkByUnit.set(r.unit as string, { group: r.group as string, query: r.query as string });
        continue;
      }
      if (r.type !== 'call' || r.status !== 'ok') {
        continue;
      }
      const chunk = chunkByUnit.get(r.unit as string);
      if (!chunk) {
        throw new Error(`日志调用 ${String(r.id)} 之前没有它所属的 log_chunk`);
      }
      const res = r.result as { streams: Array<Record<string, string>>; lines: Array<[number, number, string]> };
      for (const p of pending.values()) {
        if (!p.u.log_groups.includes(chunk.group)) {
          continue;
        }
        const from = Date.parse(p.u.log_window.from);
        const to = Date.parse(p.u.log_window.to);
        const acc = p.logs.get(chunk.group) ?? { query: chunk.query, lines: [] };
        for (const [s, t, line] of res.lines) {
          if (t >= from && t <= to) {
            acc.lines.push({ time: iso(t), labels: res.streams[s] ?? {}, line });
          }
        }
        p.logs.set(chunk.group, acc);
      }
    }
  }

  // 原始序列：单元用到的选择器的 5 分钟 rollup，按窗口 W 合并
  if (existsSync(join(o.dir, 'raw.jsonl.zst'))) {
    const selectors = new Map<string, { selector: string; units: string[] }>();
    for await (const r of readJsonl(join(o.dir, 'raw.jsonl.zst'))) {
      if (r.type === 'raw_selector' && r.status === 'exported') {
        selectors.set(r.id as string, { selector: r.selector as string, units: r.units as string[] });
        continue;
      }
      if (r.type !== 'raw_chunk' || r.status !== 'ok') {
        continue;
      }
      const sel = selectors.get(r.selector_id as string);
      if (!sel) {
        throw new Error(`raw_chunk 之前没有选择器 ${String(r.selector_id)}`);
      }
      const start = Number(r.start);
      const step = Number(r.step);
      for (const unit of sel.units) {
        const p = pending.get(unit);
        const w = p?.u.windows.W;
        if (!p || !w) {
          continue;
        }
        const from = Date.parse(w.from);
        const to = Date.parse(w.to);
        const acc = p.raw.get(r.selector_id as string) ?? { selector: sel.selector, series: new Map() };
        for (const s of r.series as Array<{ labels: Record<string, string>; avg: Array<number | null> }>) {
          const k = JSON.stringify(Object.entries(s.labels).sort());
          const cur = acc.series.get(k) ?? { labels: s.labels, times: [], values: [] };
          s.avg.forEach((v, i) => {
            const t = (start + i * step) * 1000;
            if (t >= from && t <= to) {
              cur.times.push(t);
              cur.values.push(v);
            }
          });
          acc.series.set(k, cur);
        }
        p.raw.set(r.selector_id as string, acc);
      }
    }
  }

  // 写出用例与快照
  for (const p of pending.values()) {
    const u = p.u;
    const inc = convertIncident(u, o.clusterId, now);
    const cards = convertCards(u, o.clusterId);
    const w = u.windows.W ?? { from: u.first_firing_at, to: u.end_at };
    const entries: Entry[] = [...p.calls];
    for (const [, l] of p.logs) {
      const lines = l.lines.sort((a, b) => b.time.localeCompare(a.time)).slice(0, MAX_LOG_LINES_PER_GROUP);
      entries.push({
        op: 'logs_query',
        request: {
          query: l.query,
          dialect: 'logql',
          window: { from: u.log_window.from, to: u.log_window.to },
          limit: MAX_LOG_LINES_PER_GROUP,
        },
        result: { lines, truncated: l.lines.length > lines.length },
      });
    }
    for (const [, r] of p.raw) {
      const series = [...r.series.values()].map((s) => {
        const order = s.times.map((t, i) => [t, s.values[i] ?? null] as const).sort((a, b) => a[0] - b[0]);
        return { labels: s.labels, times: order.map((x) => x[0]), values: order.map((x) => x[1]) };
      });
      entries.push({
        op: 'query_range',
        request: { expr: r.selector, dialect: 'metricsql', window: w, step_seconds: 300 },
        result: seriesResult(series, ['downsampled: 每点为前 5 分钟原始样本的平均值']),
      });
    }
    summary.entries += entries.length;
    const caseRecs = caseByUnit.get(u.unit) ?? [];
    const knowledgeRoot = caseRecs
      .map((c) => (c.knowledge as { root_component?: string } | undefined)?.root_component)
      .find((x): x is string => typeof x === 'string');
    const snapRoot = u.snapshot_ids.map((id) => truthBySnapshot.get(id)).find((x): x is string => x !== undefined);
    const truthRoot = knowledgeRoot ?? snapRoot ?? null;
    const caseId = `legacy:${u.unit}`;
    const snapshotId = stableUuid('snapshot', u.unit);
    const own = new Set([...u.case_ids, u.incident_key]);
    const usable = knowledge.filter((k) => !k.learned_from.some((x) => own.has(x)));
    const packTiming = usable.some(
      (k) => k.learned_at !== null && Date.parse(k.learned_at) > Date.parse(u.first_firing_at),
    )
      ? 'pack_after_incident'
      : 'pack_before_incident';
    const c: EvalCase = {
      case_id: caseId,
      version: 1,
      suite: truthRoot ? o.suite : `${o.suite}-unlabeled`,
      type: 'incident',
      cluster_id: o.clusterId,
      incident_id: inc.incident_id,
      label: inc.label,
      started_at: u.first_firing_at,
      as_of: u.end_at,
      truth: {
        root_components: truthRoot ? [componentKey(truthRoot)] : [],
        granularity: truthRoot ? 'component' : null,
        mechanism: null,
        disposition: null,
        forbid_evidence_consistent: false,
      },
      truth_source: knowledgeRoot
        ? { kind: 'knowledge', principal: null, ref: caseRecs.map((x) => x.case_id as string).join(',') }
        : { kind: 'imported', principal: null, ref: snapRoot ? u.snapshot_ids.join(',') : null },
      leakage: {
        exclude_incident_ids: [inc.incident_id, ...u.case_ids.map((id) => stableUuid('knowledge', id))],
        exclude_refs: [...u.case_ids, ...u.snapshot_ids],
        learned_from_keys: [...own],
      },
      pack_timing: packTiming,
      snapshot_id: snapshotId,
      derived_from: null,
      authored_by: null,
      created_at: now,
    };
    const s: EvalSnapshot = {
      snapshot_id: snapshotId,
      case_id: caseId,
      format_version: 1,
      window: w,
      as_of: u.end_at,
      context: {
        incident: inc,
        stage_a: stageA(u, inc, cards),
        subgraph: subgraph(u, topo.edges),
        alerts: [],
        actions: [],
        runbooks: [],
        knowledge,
        cases: references,
        templates: [],
      },
      queries: {
        api_version: 'srenautix.io/query-snapshot/v1',
        snapshot_id: snapshotId,
        recorded_at: now,
        clock_window: w,
        ids: { metrics: 'legacy-metrics', logs: 'legacy-logs', traces: 'legacy-traces' },
        capabilities: ['metrics.query', 'metrics.query_range', 'logs.query', 'traces.search'],
        metrics_dialects: ['metricsql'],
        label_profile: null,
        logs_profile: null,
        entries,
        cases: [],
      },
      created_at: now,
      source: { kind: 'imported', ref: `${LEGACY_SEED_FORMAT}@1:${u.unit}`, code_sha: null, pack_lock: null },
    };
    o.store.writeSnapshot(s);
    o.store.writeCase(c);
    summary.units++;
    summary.cases++;
    if (truthRoot) {
      summary.labeled++;
    } else {
      summary.unlabeled++;
    }
  }
  logger.info('种子导入完成', { ...summary, skipped: summary.skipped.length });
  return summary;
}
