import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
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

/**
 * zstd 文件逐行流式解压：按需从解压流读取（处理慢时不会预读积压），跨块的多字节字符由 StringDecoder 拼接。
 * 内存只与最长的一行有关。
 */
export async function* zstdLines(file: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  for await (const chunk of createReadStream(file).pipe(createZstdDecompress())) {
    const parts = (carry + decoder.write(chunk as Buffer)).split('\n');
    carry = parts.pop() as string;
    for (const line of parts) {
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  const rest = carry + decoder.end();
  if (rest) {
    yield rest;
  }
}

/** 逐行读取一个 zstd JSON Lines 文件；第一行必须是本格式的文件头 */
export async function* readJsonl(file: string): AsyncGenerator<Rec> {
  let first = true;
  for await (const line of zstdLines(file)) {
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

/** eval-case.schema.json 的 case_id 模式 */
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

/**
 * 单元 → case_id：legacy:<unit>。旧版 Ops-Agent 的事件键是 <根组件>:<首次触发时间取整到 10 分钟>，同一根组件、
 * 同一个 10 分钟内的多个不同事件按首次触发顺序加 ~<序号>（N ≥ 2）后缀，例如 node:2026-10-16T23:20:00Z~2。
 * 契约的 case_id 不允许 ~，按固定规则改为 .（node:2026-10-16T23:20:00Z.2）；导入时检查映射后的冲突。
 * 原始的事件键保留在用例的 label、leakage.learned_from_keys 与快照的 source.ref 中。映射后仍不合法时报错，不做其他改写。
 */
export function caseIdOf(unit: string): string {
  const id = `legacy:${unit.replace(/~/g, '.')}`;
  if (!CASE_ID.test(id)) {
    throw new Error(`单元 ${JSON.stringify(unit)} 无法映射为合法的 case_id（得到 ${JSON.stringify(id)}）`);
  }
  return id;
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

/**
 * 一个单元一个日志组窗口内日志行的时间戳：第一遍只记录最新的 limit 个时间戳（最小堆），得到截断线。
 * 第二遍按截断线保留行：时间晚于截断线的全部保留，等于截断线的按出现顺序保留 keepAtCutoff 行。
 * 这与"读完全部行、按时间倒序稳定排序、取前 limit 行"的结果相同，而内存只与 limit 有关。
 */
export class NewestTimes {
  private heap: number[] = [];
  /** 窗口内的总行数 */
  total = 0;

  constructor(private readonly limit = MAX_LOG_LINES_PER_GROUP) {}

  offer(t: number): void {
    this.total++;
    const h = this.heap;
    if (h.length < this.limit) {
      h.push(t);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((h[p] as number) <= t) {
          break;
        }
        h[i] = h[p] as number;
        i = p;
      }
      h[i] = t;
    } else if (t > (h[0] as number)) {
      // 替换堆顶后下沉
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mv = t;
        if (l < h.length && (h[l] as number) < mv) {
          m = l;
          mv = h[l] as number;
        }
        if (r < h.length && (h[r] as number) < mv) {
          m = r;
        }
        if (m === i) {
          break;
        }
        h[i] = h[m] as number;
        i = m;
      }
      h[i] = t;
    }
  }

  /** 截断线：未满 limit 时为 -Infinity（全部保留）；以及等于截断线的行应保留几行 */
  cutoff(): { at: number; keepAtCutoff: number } {
    if (this.heap.length < this.limit) {
      return { at: -Infinity, keepAtCutoff: Infinity };
    }
    const at = this.heap[0] as number;
    const above = this.heap.filter((x) => x > at).length;
    return { at, keepAtCutoff: this.limit - above };
  }
}

/** 每个单元的中间结果先写入临时文件（每批一个带帧长前缀的 zstd 帧），写出用例时再逐帧读回，不在内存中累积。 */
class UnitSpool {
  private buf: string[] = [];
  private size = 0;

  constructor(readonly file: string) {}

  add(rec: unknown): void {
    const s = JSON.stringify(rec);
    this.buf.push(s);
    this.size += s.length;
    if (this.size >= SPOOL_FLUSH_BYTES) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buf.length) {
      const frame = zstdCompressSync(Buffer.from(this.buf.join('\n')));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(frame.length);
      appendFileSync(this.file, Buffer.concat([len, frame]));
      this.buf = [];
      this.size = 0;
    }
  }

  /** 逐帧解压读回（每帧前 4 字节为帧长；Node 的流式 zstd 解压不接受多帧拼接） */
  *read(): Generator<SpoolRec> {
    this.flush();
    if (!existsSync(this.file)) {
      return;
    }
    const data = readFileSync(this.file);
    for (let off = 0; off < data.length;) {
      const len = data.readUInt32BE(off);
      const text = zstdDecompressSync(data.subarray(off + 4, off + 4 + len)).toString('utf8');
      off += 4 + len;
      for (const line of text.split('\n')) {
        yield JSON.parse(line) as SpoolRec;
      }
    }
  }
}

/** 缓冲达到这个大小（字符数）时写入一帧 */
const SPOOL_FLUSH_BYTES = 256 * 1024;

type SpoolRec =
  | { k: 'call'; e: Entry }
  | { k: 'group'; g: string; q: string }
  | { k: 'line'; g: string; t: number; s: Record<string, string>; l: string }
  /** 单元用到的一个原始序列选择器（第一次出现时写入，决定条目的顺序；窗口内没有点时条目的结果为空） */
  | { k: 'rawsel'; id: string; q: string }
  /** 一个原始序列块中一条序列落在窗口 W 内的点 */
  | { k: 'raw'; id: string; labels: Record<string, string>; t: number[]; v: Array<number | null> };

interface Pending {
  u: Unit;
  spool: UnitSpool;
  /** 日志组 → 窗口内的总行数（第一遍得出，决定 truncated） */
  totals: Map<string, number>;
  /** 已写入 rawsel 的选择器 */
  rawSelectors: Set<string>;
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
  // case_id 映射的冲突检查：同一次导入的两个单元、或用例目录中已有的其他单元的用例，映射到同一个 case_id 时报错，
  // 不覆盖。同一单元重复导入时 case_id 与 snapshot_id 都相同，按新内容覆盖。
  const existing = new Map(o.store.cases().map((c) => [c.case_id, c.snapshot_id]));
  const unitByCase = new Map<string, string>();
  for (const u of units.values()) {
    if (!u.incident.root) {
      summary.skipped.push({ unit: u.unit, reason: '事件没有根组件（以知识条目时间窗为单元，没有告警）' });
      continue;
    }
    const caseId = caseIdOf(u.unit);
    const other = unitByCase.get(caseId);
    if (other !== undefined) {
      throw new Error(`单元 ${JSON.stringify(other)} 与 ${JSON.stringify(u.unit)} 映射到同一个 case_id ${caseId}`);
    }
    const snap = existing.get(caseId);
    if (snap !== undefined && snap !== stableUuid('snapshot', u.unit)) {
      throw new Error(
        `用例目录中已有 case_id ${caseId}，来自另一个单元（快照 ${snap}）；单元 ${JSON.stringify(u.unit)} 不覆盖它`,
      );
    }
    unitByCase.set(caseId, u.unit);
  }
  // 中间结果的临时目录在用例目录内，导入结束（含失败）时删除
  const spoolDir = join(o.store.dir, `.import-${process.pid}-${Date.now()}`);
  mkdirSync(spoolDir, { recursive: true });
  try {
    let n = 0;
    for (const u of units.values()) {
      if (u.incident.root) {
        pending.set(u.unit, {
          u,
          spool: new UnitSpool(join(spoolDir, `${n++}.jsonl.zst`)),
          totals: new Map(),
          rawSelectors: new Set(),
        });
      }
    }
    await spoolSources(o.dir, pending);
    logger.info('种子导入：调用、日志与原始序列已按单元写入临时文件', { heap_mb: heapMb() });
    await writeUnits(o, pending, { now, topo, knowledge, references, caseByUnit, truthBySnapshot, summary });
  } finally {
    rmSync(spoolDir, { recursive: true, force: true });
  }
  logger.info('种子导入完成', { ...summary, skipped: summary.skipped.length });
  return summary;
}

/** 日志块中一条成功的日志调用，按它所属的日志组交给 visit；log_chunk 记录给出随后调用所属的组与查询 */
async function forEachLogCall(
  dir: string,
  visit: (
    chunk: { group: string; query: string },
    res: { streams: Array<Record<string, string>>; lines: Array<[number, number, string]> },
  ) => void,
): Promise<void> {
  const chunkByUnit = new Map<string, { group: string; query: string }>();
  for await (const r of readJsonl(join(dir, 'logs.jsonl.zst'))) {
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
    visit(chunk, r.result as { streams: Array<Record<string, string>>; lines: Array<[number, number, string]> });
  }
}

/**
 * 逐行读取调用、日志块与原始序列（全部流式），把每个单元用到的部分写入它的临时文件：
 * - 调用：转换为查询快照条目；
 * - 日志：第一遍记录每个单元每个日志组窗口内最新的 MAX_LOG_LINES_PER_GROUP 个时间戳，第二遍只写入保留的行；
 * - 原始序列：数据量小（5 分钟 rollup），在内存中按窗口 W 合并。
 */
const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1048576);

async function spoolSources(dir: string, pending: Map<string, Pending>): Promise<void> {
  for await (const r of readJsonl(join(dir, 'calls.jsonl.zst'))) {
    if (r.type !== 'call') {
      continue;
    }
    const p = pending.get(r.unit as string);
    const e = p ? callEntry(r as unknown as Call) : null;
    if (p && e) {
      p.spool.add({ k: 'call', e });
    }
  }
  logger.info('种子导入：调用已读完', { heap_mb: heapMb() });

  if (existsSync(join(dir, 'logs.jsonl.zst'))) {
    const byGroup = new Map<string, Array<{ p: Pending; from: number; to: number }>>();
    for (const p of pending.values()) {
      for (const g of p.u.log_groups) {
        const list = byGroup.get(g) ?? [];
        list.push({ p, from: Date.parse(p.u.log_window.from), to: Date.parse(p.u.log_window.to) });
        byGroup.set(g, list);
      }
    }
    const key = (p: Pending, g: string) => `${p.u.unit}\0${g}`;
    const times = new Map<string, NewestTimes>();
    await forEachLogCall(dir, (chunk, res) => {
      for (const { p, from, to } of byGroup.get(chunk.group) ?? []) {
        const k = key(p, chunk.group);
        let acc = times.get(k);
        if (!acc) {
          acc = new NewestTimes();
          times.set(k, acc);
        }
        for (const [, t] of res.lines) {
          if (t >= from && t <= to) {
            acc.offer(t);
          }
        }
      }
    });
    for (const { p } of [...byGroup.values()].flat()) {
      for (const g of p.u.log_groups) {
        const t = times.get(key(p, g));
        if (t) {
          p.totals.set(g, t.total);
        }
      }
    }
    const cut = new Map([...times].map(([k, v]) => [k, { ...v.cutoff(), keptAtCutoff: 0, seen: false }]));
    times.clear();
    logger.info('种子导入：日志第一遍（每个单元每个日志组的截断时间）完成', { heap_mb: heapMb() });
    await forEachLogCall(dir, (chunk, res) => {
      for (const { p, from, to } of byGroup.get(chunk.group) ?? []) {
        const c = cut.get(key(p, chunk.group)) as {
          at: number;
          keepAtCutoff: number;
          keptAtCutoff: number;
          seen: boolean;
        };
        if (!c.seen) {
          // 组在单元中的顺序与查询取自该组第一条成功的日志调用（即使窗口内没有行）
          c.seen = true;
          p.spool.add({ k: 'group', g: chunk.group, q: chunk.query });
        }
        for (const [s, t, line] of res.lines) {
          if (t < from || t > to || t < c.at) {
            continue;
          }
          if (t === c.at) {
            if (c.keptAtCutoff >= c.keepAtCutoff) {
              continue;
            }
            c.keptAtCutoff++;
          }
          p.spool.add({ k: 'line', g: chunk.group, t, s: res.streams[s] ?? {}, l: line });
        }
      }
    });
  }

  // 原始序列：单元用到的选择器的 5 分钟 rollup，按窗口 W 合并
  if (existsSync(join(dir, 'raw.jsonl.zst'))) {
    const selectors = new Map<string, { selector: string; units: string[] }>();
    for await (const r of readJsonl(join(dir, 'raw.jsonl.zst'))) {
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
        const id = r.selector_id as string;
        if (!p.rawSelectors.has(id)) {
          p.rawSelectors.add(id);
          p.spool.add({ k: 'rawsel', id, q: sel.selector });
        }
        for (const s of r.series as Array<{ labels: Record<string, string>; avg: Array<number | null> }>) {
          const t: number[] = [];
          const v: Array<number | null> = [];
          s.avg.forEach((x, i) => {
            const at = (start + i * step) * 1000;
            if (at >= from && at <= to) {
              t.push(at);
              v.push(x);
            }
          });
          p.spool.add({ k: 'raw', id, labels: s.labels, t, v });
        }
      }
    }
  }
}

interface WriteContext {
  now: string;
  topo: { edges: Array<{ caller: string; callee: string }> };
  knowledge: EvalSnapshot['context']['knowledge'];
  references: EvalSnapshot['context']['cases'];
  caseByUnit: Map<string, Rec[]>;
  truthBySnapshot: Map<string, string>;
  summary: ImportSummary;
}

/** 逐个单元读回临时文件，组装查询快照条目，写出用例与快照；每个单元写完即释放。 */
async function writeUnits(o: ImportOptions, pending: Map<string, Pending>, x: WriteContext): Promise<void> {
  const { now, topo, knowledge, references, caseByUnit, truthBySnapshot, summary } = x;
  for (const p of pending.values()) {
    const u = p.u;
    const inc = convertIncident(u, o.clusterId, now);
    const cards = convertCards(u, o.clusterId);
    const w = u.windows.W ?? { from: u.first_firing_at, to: u.end_at };
    const entries: Entry[] = [];
    const logs = new Map<
      string,
      { query: string; lines: Array<{ t: number; s: Record<string, string>; l: string }> }
    >();
    const raw = new Map<
      string,
      {
        selector: string;
        series: Map<string, { labels: Record<string, string>; times: number[]; values: Array<number | null> }>;
      }
    >();
    for (const r of p.spool.read()) {
      if (r.k === 'call') {
        entries.push(r.e);
      } else if (r.k === 'group') {
        logs.set(r.g, { query: r.q, lines: [] });
      } else if (r.k === 'line') {
        (logs.get(r.g) as { lines: Array<{ t: number; s: Record<string, string>; l: string }> }).lines.push(r);
      } else if (r.k === 'rawsel') {
        raw.set(r.id, { selector: r.q, series: new Map() });
      } else {
        // 同一条序列（按标签）跨多个块的点合并
        const acc = raw.get(r.id) as {
          series: Map<string, { labels: Record<string, string>; times: number[]; values: Array<number | null> }>;
        };
        const k = JSON.stringify(Object.entries(r.labels).sort());
        const cur = acc.series.get(k) ?? { labels: r.labels, times: [], values: [] };
        cur.times.push(...r.t);
        cur.values.push(...r.v);
        acc.series.set(k, cur);
      }
    }
    for (const [g, l] of logs) {
      // 窗口内的总行数由第一遍得出；这里保留的就是最新的 MAX_LOG_LINES_PER_GROUP 行
      const total = p.totals.get(g) ?? l.lines.length;
      const lines = l.lines.sort((a, b) => b.t - a.t).map((y) => ({ time: iso(y.t), labels: y.s, line: y.l }));
      entries.push({
        op: 'logs_query',
        request: {
          query: l.query,
          dialect: 'logql',
          window: { from: u.log_window.from, to: u.log_window.to },
          limit: MAX_LOG_LINES_PER_GROUP,
        },
        result: { lines, truncated: total > lines.length },
      });
    }
    for (const [, r] of raw) {
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
    const caseId = caseIdOf(u.unit);
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
      // 原始的事件键（case_id 中的 ~ 已改写）
      label: u.incident_key,
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
}
