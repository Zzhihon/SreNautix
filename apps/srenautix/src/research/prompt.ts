import { PROMPTS, type Language } from '../prompts/index.js';
import type { Item, Segment, SegmentTrim } from '../llm/types.js';
import type { CardEntry, EvidenceBook } from './evidence.js';
import { ownerOf, scopeOf, type Ledger } from './ledger.js';
import type { PreviousRun, ResearchCase, Subgraph } from './types.js';

// 提示词按稳定前缀排列（DESIGN §8.3），便于服务方命中前缀缓存：
// 1. 固定指令（system）；
// 2. 只随领域包与集群配置变化的目录：查询模板、只读工具、可用动作、runbook；
// 3. 事件数据：事件概要、拓扑、告警、变更、证据卡、知识与参考案例、上一次的账本与反馈；
// 4. 步骤相关的部分：conclude 的账本与检查结果；最后是本步骤的任务说明。
// hypothesize 与 conclude 共用 1–3。
//
// 第 3 段的片段带裁剪方式（ADR 0099）：估算超出路由窗口或本次可用预算时，模型层按 TRIM 的顺序逐步裁剪，
// 优先保留结论相关的证据卡，其次拓扑子图、知识，最后才是参考案例；裁掉的内容写进运行详情。

const TABLE_ROWS = 8;
const CELL_CHARS = 120;
const TEXT_CHARS = 300;

/** 上下文较小的路由只放入异常卡、候选根因上的卡与检查卡（DESIGN §7.5 上下文预算） */
export const SMALL_CONTEXT_TOKENS = 64_000;
/** 阶段 A 的卡超过这个数时同样只完整放入结论相关的卡，其余写成摘要（ADR 0127） */
export const MANY_CARDS = 40;
/** 完整放入的结论相关卡最多这么多张，按相关性排序取前面的；其余的结论相关卡只列判定（ADR 0127） */
export const MAX_FULL_CARDS = 40;
/** 账本片段里补充的假设相关卡最多这么多张（ADR 0127） */
export const MAX_HYPOTHESIS_CARDS = 16;
/** 摘要里每条证据链最多列出的组件数 */
const SUMMARY_COMPONENTS = 6;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function fenced(title: string, value: unknown): string {
  return `## ${title}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function seg(text: string, categories: Segment['categories'], egress: Segment['egress']): Segment {
  return { text, categories, egress };
}

/** 裁剪顺序：数值小的先裁 */
export const TRIM = {
  irrelevantCards: 1,
  cases: 2,
  knowledge: 3,
  irrelevantList: 4,
  changes: 5,
  topologyReduce: 6,
  topologyDrop: 7,
  cardTables: 8,
  relevantCards: 9,
} as const;

/** 裁剪后保留的最近变更条数 */
const KEEP_CHANGES = 20;
/** 裁剪后每张证据卡表格保留的行数 */
const TRIMMED_TABLE_ROWS = 3;

function cardView(c: CardEntry, tableRows = TABLE_ROWS): Record<string, unknown> {
  const r = c.result;
  return {
    ref: c.ref,
    card: r.card_id,
    entity: c.component,
    verdict: r.verdict,
    state: r.display_state,
    value: r.value,
    reason: cut(r.reason.text, TEXT_CHARS),
    anomaly_started_at: r.anomaly_started_at ?? null,
    window: r.window,
    ...(r.table
      ? {
          table: {
            head: r.table.head,
            rows: r.table.rows.slice(0, tableRows).map((row) => row.map((x) => cut(x, CELL_CHARS))),
          },
        }
      : {}),
    ...(c.hypothesisId ? { check_for: c.hypothesisId, judged_by: c.judgedBy } : {}),
  };
}

/** 与结论相关的证据卡：异常、区分性检查产生的、或落在候选根因上 */
function relevant(c: ResearchCase): (x: CardEntry) => boolean {
  const candidates = new Set(c.incident.candidates.map((x) => x.component));
  return (x) =>
    x.result.verdict === 'abnormal' || x.hypothesisId !== null || (x.component !== null && candidates.has(x.component));
}

/** 结论相关证据卡的保留顺序：候选根因上的异常卡、其他异常卡、检查卡、候选根因上的其他卡 */
function relevanceRank(c: ResearchCase): (x: CardEntry) => number {
  const candidates = new Set(c.incident.candidates.map((x) => x.component));
  return (x) => {
    const onCandidate = x.component !== null && candidates.has(x.component);
    if (x.result.verdict === 'abnormal') {
      return onCandidate ? 0 : 1;
    }
    return x.hypothesisId !== null ? 2 : 3;
  };
}

/**
 * 阶段 A 的卡怎样进入提示词（ADR 0127）：
 * - 卡不多、路由上下文足够时全部完整放入（与结论无关的卡可在裁剪时改为只列判定）；
 * - 卡超过 MANY_CARDS 或路由上下文小于 SMALL_CONTEXT_TOKENS 时，结论相关的卡按相关性取前 MAX_FULL_CARDS 张完整放入
 *   （included），其余结论相关的卡只列判定（listed），与结论无关的卡只写摘要（summarized：按证据链与判定计数）。
 */
export function selectCards(
  book: EvidenceBook,
  c: ResearchCase,
  contextTokens: number,
): { included: CardEntry[]; listed: CardEntry[]; summarized: CardEntry[] } {
  const cards = book.promptCards();
  const stageA = cards.filter((x) => x.hypothesisId === null);
  if (contextTokens >= SMALL_CONTEXT_TOKENS && stageA.length <= MANY_CARDS) {
    return { included: cards, listed: [], summarized: [] };
  }
  const isRelevant = relevant(c);
  const rank = relevanceRank(c);
  const rel = cards.filter(isRelevant);
  const full = new Set(
    rel
      .map((x, i) => ({ x, i }))
      .sort((p, q) => rank(p.x) - rank(q.x) || p.i - q.i)
      .slice(0, MAX_FULL_CARDS)
      .map((p) => p.x.ref),
  );
  return {
    included: cards.filter((x) => full.has(x.ref)),
    listed: rel.filter((x) => !full.has(x.ref)),
    summarized: cards.filter((x) => !isRelevant(x)),
  };
}

/** 输出 schema 里根因组件枚举的上限（ADR 0127） */
export const MAX_COMPONENT_CHOICES = 300;

/**
 * 输出 schema 里根因组件的可选值（动态枚举 components，ADR 0127）。假设按组件粒度提出（ADR 0121），由控制器拥有的对象
 * （子图里有 owned_by 出边的 Pod、ReplicaSet 等）不在其中，事件根因与候选根因除外；超过上限时按角色（根因、候选、成员、
 * 邻居）与跳数取前面的。几百个 Pod 的子图里，枚举曾是请求中最大且不可裁剪的部分。
 */
export function componentChoices(c: ResearchCase): string[] {
  const owned = new Set(c.subgraph.edges.filter((e) => e.relation === 'owned_by').map((e) => e.from));
  const nodes = c.subgraph.nodes.filter((n) => !owned.has(n.component) || n.role === 'root' || n.role === 'candidate');
  const role = { root: 0, candidate: 1, member: 2, neighbor: 3 } as Record<string, number>;
  const picked =
    nodes.length <= MAX_COMPONENT_CHOICES
      ? nodes
      : nodes
          .map((n, i) => ({ n, i }))
          .sort((a, b) => (role[a.n.role] ?? 4) - (role[b.n.role] ?? 4) || a.n.hops - b.n.hops || a.i - b.i)
          .slice(0, MAX_COMPONENT_CHOICES)
          .sort((a, b) => a.i - b.i)
          .map((x) => x.n);
  return [...new Set(picked.map((n) => n.component))];
}

const listedView = (x: CardEntry) => ({
  ref: x.ref,
  card: x.result.card_id,
  entity: x.component,
  verdict: x.result.verdict,
});

/** 与结论无关的卡的摘要：按证据链统计各判定的张数，列出前几个组件 */
export function summaryView(cards: readonly CardEntry[]): Record<string, unknown> {
  const verdicts: Record<string, number> = {};
  const chains = new Map<string, { counts: Record<string, number>; components: string[] }>();
  for (const x of cards) {
    verdicts[x.result.verdict] = (verdicts[x.result.verdict] ?? 0) + 1;
    const chain = x.result.card_id.split('/').slice(0, 2).join('/');
    const cur = chains.get(chain) ?? { counts: {}, components: [] };
    cur.counts[x.result.verdict] = (cur.counts[x.result.verdict] ?? 0) + 1;
    if (x.component !== null && !cur.components.includes(x.component)) {
      cur.components.push(x.component);
    }
    chains.set(chain, cur);
  }
  return {
    total: cards.length,
    verdicts,
    chains: [...chains.entries()].map(([chain, v]) => ({
      chain,
      ...v.counts,
      components: v.components.slice(0, SUMMARY_COMPONENTS),
      ...(v.components.length > SUMMARY_COMPONENTS
        ? { more_components: v.components.length - SUMMARY_COMPONENTS }
        : {}),
    })),
  };
}

/** 一组同出境方式的证据卡片段的状态；每一步裁剪得到下一个状态 */
interface CardState {
  /** 这一组的全部卡，按原顺序 */
  all: CardEntry[];
  /** 仍然保留的结论相关卡 */
  keep: Set<string>;
  /** 结论相关卡按保留优先级排序 */
  ranked: CardEntry[];
  /** 其余卡：完整放入、只列判定、不放 */
  others: 'full' | 'list' | 'none';
  otherRefs: Set<string>;
  tableRows: number;
  title: string;
  egress: Segment['egress'];
}

const CARD_CATEGORIES: Segment['categories'] = ['metrics', 'logs', 'traces', 'events'];

function cardStateSegment(st: CardState): Segment {
  const shown = st.all.filter((x) => st.keep.has(x.ref) || (st.others === 'full' && st.otherRefs.has(x.ref)));
  const title = st.egress === 'redact' ? `${st.title}（脱敏）` : st.title;
  const blocks = [
    fenced(
      title,
      shown.map((x) => cardView(x, st.tableRows)),
    ),
  ];
  if (st.others === 'list') {
    blocks.push(fenced('其余证据卡（只列判定）', st.all.filter((x) => st.otherRefs.has(x.ref)).map(listedView)));
  }
  const segment = seg(blocks.join('\n\n'), CARD_CATEGORIES, st.egress);
  const t = cardTrim(st);
  return t ? { ...segment, trim: t } : segment;
}

function cardTrim(st: CardState): SegmentTrim | null {
  const others = st.otherRefs.size;
  if (st.others === 'full' && others) {
    return {
      rank: TRIM.irrelevantCards,
      label: `证据卡 ${others} 张（判定正常且不在候选根因上）改为只列判定`,
      next: () => cardStateSegment({ ...st, others: 'list' }),
    };
  }
  if (st.others === 'list' && others) {
    return {
      rank: TRIM.irrelevantList,
      label: `其余证据卡的判定列表 ${others} 张`,
      next: () => cardStateSegment({ ...st, others: 'none' }),
    };
  }
  const kept = st.all.filter((x) => st.keep.has(x.ref));
  if (st.tableRows > TRIMMED_TABLE_ROWS && kept.some((x) => (x.result.table?.rows.length ?? 0) > TRIMMED_TABLE_ROWS)) {
    return {
      rank: TRIM.cardTables,
      label: `结论相关证据卡的表格（每张只保留前 ${TRIMMED_TABLE_ROWS} 行）`,
      next: () => cardStateSegment({ ...st, tableRows: TRIMMED_TABLE_ROWS }),
    };
  }
  if (st.keep.size > 1) {
    const k = Math.ceil(st.keep.size / 2);
    const keep = new Set(
      st.ranked
        .filter((x) => st.keep.has(x.ref))
        .slice(0, k)
        .map((x) => x.ref),
    );
    return {
      rank: TRIM.relevantCards,
      label: `结论相关证据卡 ${st.keep.size - k} 张（保留排名靠前的 ${k} 张）`,
      next: () => cardStateSegment({ ...st, keep }),
    };
  }
  return null;
}

/**
 * 证据卡片段：每种出境方式一段。included 是放入的卡（其中与结论无关的卡可被裁成只列判定），
 * listed 是一开始就只列判定的卡，summarized 是只写摘要的卡（selectCards），各自单独一段。
 */
function cardSegments(
  entries: CardEntry[],
  listed: CardEntry[],
  title: string,
  c: ResearchCase,
  summarized: CardEntry[] = [],
): Segment[] {
  const out: Segment[] = [];
  const isRelevant = relevant(c);
  const rank = relevanceRank(c);
  for (const egress of ['allow', 'redact'] as const) {
    const all = entries.filter((x) => x.result.egress === egress);
    if (!all.length) {
      continue;
    }
    const rel = all.filter(isRelevant);
    out.push(
      cardStateSegment({
        all,
        keep: new Set(rel.map((x) => x.ref)),
        ranked: rel
          .map((x, i) => ({ x, i }))
          .sort((p, q) => rank(p.x) - rank(q.x) || p.i - q.i)
          .map((p) => p.x),
        others: 'full',
        otherRefs: new Set(all.filter((x) => !isRelevant(x)).map((x) => x.ref)),
        tableRows: TABLE_ROWS,
        title,
        egress,
      }),
    );
  }
  if (listed.length) {
    out.push({
      ...seg(fenced('其余证据卡（只列判定）', listed.map(listedView)), ['metrics'], 'allow'),
      trim: { rank: TRIM.irrelevantList, label: `其余证据卡的判定列表 ${listed.length} 张`, next: () => null },
    });
  }
  if (summarized.length) {
    out.push({
      ...seg(
        fenced('与结论无关的证据卡（摘要：判定正常或无法判定、不在候选根因上，按证据链计数）', summaryView(summarized)),
        ['metrics'],
        'allow',
      ),
      trim: { rank: TRIM.irrelevantList, label: `与结论无关的证据卡摘要 ${summarized.length} 张`, next: () => null },
    });
  }
  return out;
}

/** 第 2 段：目录（只随领域包与集群配置变化） */
export function catalogSegment(c: ResearchCase): Segment {
  return seg(
    [
      fenced(
        '可用查询模板（next_checks type=query）',
        c.templates.map((t) => ({ id: t.id, description: t.description, args: t.args })),
      ),
      fenced(
        '可用只读工具（next_checks type=tool）',
        c.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      ),
      fenced(
        '可用动作（proposals）',
        c.actions.map((a) => ({
          id: a.id,
          title: a.title,
          level: a.level,
          target_kind: a.target.kind,
          params: a.params,
          undo: a.undo.kind,
        })),
      ),
      fenced('runbook', c.runbooks),
    ].join('\n\n'),
    [],
    'allow',
  );
}

/**
 * 拓扑子图在提示词里的写法（ADR 0129）：由控制器拥有、自身与事件无关的对象（不是根因、候选或事件组件，没有告警，
 * 也不是证据卡的实体）不逐个列出，按 kind 计数记在顶层属主的 owns 上；它们的其他边改记在属主上（去重，置信度取最高）。
 * 几百个 Pod 的子图里，逐个列出的 Pod 与边曾占提示词的大半。
 */
export function topologyView(
  c: ResearchCase,
  nodes: Subgraph['nodes'],
  edges: Subgraph['edges'],
  related: ReadonlySet<string>,
): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } {
  const present = new Set(nodes.map((n) => n.component));
  const owned = new Set(edges.filter((e) => e.relation === 'owned_by').map((e) => e.from));
  const into = new Map<string, string>();
  for (const n of nodes) {
    if (
      !owned.has(n.component) ||
      related.has(n.component) ||
      n.alerts.length ||
      n.role === 'root' ||
      n.role === 'candidate'
    ) {
      continue;
    }
    const top = ownerOf(n.component, c.subgraph);
    if (top !== n.component && present.has(top) && !into.has(top)) {
      into.set(n.component, top);
    }
  }
  const owns = new Map<string, Record<string, number>>();
  for (const n of nodes) {
    const top = into.get(n.component);
    if (top) {
      const o = owns.get(top) ?? {};
      o[n.kind] = (o[n.kind] ?? 0) + 1;
      owns.set(top, o);
    }
  }
  const out = new Map<string, { from: string; to: string; relation: string; confidence: number }>();
  for (const e of edges) {
    const from = into.get(e.from) ?? e.from;
    const to = into.get(e.to) ?? e.to;
    if (from === to) {
      continue;
    }
    const k = `${from}|${e.relation}|${to}`;
    const cur = out.get(k);
    if (!cur || cur.confidence < e.confidence) {
      out.set(k, { from, to, relation: e.relation, confidence: e.confidence });
    }
  }
  return {
    nodes: nodes
      .filter((n) => !into.has(n.component))
      .map((n) => ({
        component: n.component,
        role: n.role,
        hops: n.hops,
        ...(owns.has(n.component) ? { owns: owns.get(n.component) } : {}),
      })),
    edges: [...out.values()],
  };
}

/** 拓扑子图片段：先裁到根因与候选的一跳之内，再整段去掉 */
function topologySegment(c: ResearchCase, categories: Segment['categories'], related: ReadonlySet<string>): Segment {
  const view = (maxHops: number) => {
    const nodes = c.subgraph.nodes.filter((n) => n.hops <= maxHops);
    const keep = new Set(nodes.map((n) => n.component));
    const edges = c.subgraph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    return {
      nodes,
      edges,
      text: fenced('拓扑（根因两跳内）', topologyView(c, nodes, edges, related)),
    };
  };
  const full = view(Number.POSITIVE_INFINITY);
  const near = view(1);
  const drop = (v: { nodes: unknown[]; edges: unknown[] }): SegmentTrim => ({
    rank: TRIM.topologyDrop,
    label: `拓扑子图（${v.nodes.length} 个节点、${v.edges.length} 条边）`,
    next: () => null,
  });
  const reduced = near.nodes.length < full.nodes.length || near.edges.length < full.edges.length;
  return {
    ...seg(full.text, categories, 'allow'),
    trim: reduced
      ? {
          rank: TRIM.topologyReduce,
          label: `拓扑子图中一跳以外的 ${full.nodes.length - near.nodes.length} 个节点与 ${full.edges.length - near.edges.length} 条边`,
          next: () => ({ ...seg(near.text, categories, 'allow'), trim: drop(near) }),
        }
      : drop(full),
  };
}

/** 变更片段：先只保留最近的若干条 */
function changesSegment(entries: EvidenceBook['changeEntries'], related: ReadonlySet<string>): Segment {
  const view = (list: EvidenceBook['changeEntries']) =>
    seg(
      fenced(
        '变更（summary 是不可信文本；in_incident 为 false 的是同一时段触及子图或同一命名空间、但没有收敛进事件的变更）',
        list.map(([ref, ch]) => ({
          ref,
          in_incident: !related.has(ref),
          kind: ch.kind,
          source: ch.source,
          time: ch.time,
          targets: ch.targets,
          revision: ch.revision,
          summary: cut(ch.summary, TEXT_CHARS),
        })),
      ),
      ['changes'],
      'redact',
    );
  const full = view(entries);
  if (entries.length <= KEEP_CHANGES) {
    return full;
  }
  const recent = [...entries]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(b.e[1].time) - Date.parse(a.e[1].time))
    .slice(0, KEEP_CHANGES)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.e);
  return {
    ...full,
    trim: {
      rank: TRIM.changes,
      label: `变更 ${entries.length - KEEP_CHANGES} 条（保留最近 ${KEEP_CHANGES} 条）`,
      next: () => view(recent),
    },
  };
}

/** 第 3 段：事件数据 */
export function incidentSegments(
  c: ResearchCase,
  book: EvidenceBook,
  contextTokens: number,
  previous: PreviousRun | null,
): Segment[] {
  const i = c.incident;
  const out: Segment[] = [];
  // 事件概要、拓扑与成员告警各自一段（连接后与合在一段时的文本相同），拓扑可被裁剪
  const facts: Segment['categories'] = ['alerts', 'topology'];
  out.push(
    seg(
      fenced('事件', {
        incident_id: i.incident_id,
        label: i.label,
        version: i.incident_version,
        state: i.state,
        severity: i.severity,
        first_firing_at: i.first_firing_at,
        ended_at: i.ended_at,
        root: i.root,
        candidates: i.candidates.map((x) => ({
          component: x.component,
          score: x.score,
          source: x.source,
          explains: x.explains.length,
        })),
        observability_blind: i.observability_blind,
        stage_a_disposition: c.stageA.disposition,
        stage_a_reason: c.stageA.disposition_reason,
      }),
      facts,
      'allow',
    ),
  );
  // 与事件有关的组件：根因、候选、事件组件、成员告警的组件与证据卡的实体，拓扑里逐个列出
  const related = new Set<string>([
    ...(i.root.component ? [i.root.component] : []),
    ...i.candidates.map((x) => x.component),
    ...i.components,
    ...book.alertEntries.flatMap(([, m]) => (m.component ? [m.component] : [])),
    ...book.promptCards().flatMap((x) => (x.component ? [x.component] : [])),
  ]);
  out.push(topologySegment(c, facts, related));
  out.push(
    seg(
      fenced(
        '成员告警',
        book.alertEntries.map(([ref, m]) => ({
          ref,
          alertname: m.alertname,
          role: m.role,
          component: m.component,
          severity: m.severity,
          status: m.status,
          starts_at: m.starts_at,
        })),
      ),
      facts,
      'allow',
    ),
  );
  if (book.changeEntries.length) {
    out.push(changesSegment(book.changeEntries, book.related));
  }
  const { included, listed, summarized } = selectCards(book, c, contextTokens);
  out.push(
    ...cardSegments(
      included.filter((x) => x.hypothesisId === null),
      listed,
      '证据卡（阶段 A）',
      c,
      summarized,
    ),
  );
  if (c.knowledge.length || c.cases.length) {
    out.push({
      ...seg(
        fenced(
          '知识条目',
          c.knowledge.map((k) => ({ id: k.id, components: k.components, text: cut(k.text, 600), source: k.source })),
        ),
        ['knowledge'],
        'redact',
      ),
      ...(c.knowledge.length
        ? { trim: { rank: TRIM.knowledge, label: `知识条目 ${c.knowledge.length} 条`, next: () => null } }
        : {}),
    });
    out.push({
      ...seg(
        fenced(
          '参考案例（开始之前已解决）',
          c.cases.map((x) => ({
            incident_id: x.incident_id,
            root_component: x.root_component,
            mechanism: x.mechanism,
            source: x.source,
          })),
        ),
        ['knowledge'],
        'redact',
      ),
      ...(c.cases.length
        ? { trim: { rank: TRIM.cases, label: `参考案例 ${c.cases.length} 条`, next: () => null } }
        : {}),
    });
  }
  if (previous) {
    out.push(
      seg(
        fenced('上一次研判的账本', {
          incident_version: previous.incidentVersion,
          conclusion: previous.output.conclusion,
          hypotheses: previous.output.hypotheses.map((h) => ({
            id: h.id,
            root_component: h.root_component,
            mechanism: h.mechanism,
            status: h.status,
          })),
        }),
        [],
        'redact',
      ),
    );
  }
  const fb = c.feedback.filter((f) => f.linked);
  if (fb.length) {
    out.push(
      seg(
        fenced(
          '人工反馈（新的在前）',
          fb.map((f) => ({
            verdict: f.verdict,
            root_component: f.root_component,
            disposition_verdict: f.disposition_verdict,
            disposition: f.disposition,
            mechanism: f.mechanism,
            at: f.created_at,
          })),
        ),
        [],
        'redact',
      ),
    );
  }
  return out;
}

/**
 * 假设相关、但事件数据段没有完整放入的阶段 A 卡（ADR 0127）：假设引用的卡在前，其次是假设范围（ADR 0121 scopeOf）内的
 * 异常卡与其他卡；最多 MAX_HYPOTHESIS_CARDS 张，表格只保留前几行。
 */
export function hypothesisCards(
  ledger: Ledger,
  book: EvidenceBook,
  c: ResearchCase,
  shown: ReadonlySet<string>,
): CardEntry[] {
  const cited: CardEntry[] = [];
  const scoped: CardEntry[] = [];
  const seen = new Set(shown);
  const stageA = book.promptCards().filter((x) => x.hypothesisId === null);
  for (const e of ledger.ranked()) {
    for (const ref of [...e.supporting, ...e.refuting]) {
      const x = book.card(ref);
      if (x && x.hypothesisId === null && x.result.egress !== 'never' && !seen.has(ref)) {
        seen.add(ref);
        cited.push(x);
      }
    }
    const scope = scopeOf(e.rootComponent, c.subgraph);
    for (const x of stageA) {
      if (x.component !== null && scope.has(x.component) && !seen.has(x.ref)) {
        seen.add(x.ref);
        scoped.push(x);
      }
    }
  }
  const order = (x: CardEntry) => (x.result.verdict === 'abnormal' ? 0 : x.result.verdict === 'normal' ? 1 : 2);
  return [...cited, ...scoped.sort((a, b) => order(a) - order(b))].slice(0, MAX_HYPOTHESIS_CARDS);
}

function ledgerSegment(ledger: Ledger, book: EvidenceBook, p: PromptParts): Segment[] {
  const c = p.rc;
  const checks = book.allCards.filter((x) => x.hypothesisId !== null);
  const extra = hypothesisCards(ledger, book, c, p.fullRefs);
  const extraSegments: Segment[] = [];
  for (const egress of ['allow', 'redact'] as const) {
    const list = extra.filter((x) => x.result.egress === egress);
    if (list.length) {
      extraSegments.push({
        ...seg(
          fenced(
            egress === 'redact'
              ? '假设相关的证据卡（阶段 A，上文未完整列出；脱敏）'
              : '假设相关的证据卡（阶段 A，上文未完整列出）',
            list.map((x) => cardView(x, TRIMMED_TABLE_ROWS)),
          ),
          CARD_CATEGORIES,
          egress,
        ),
        trim: { rank: TRIM.relevantCards, label: `假设相关的证据卡 ${list.length} 张`, next: () => null },
      });
    }
  }
  return [
    seg(
      fenced(
        '假设账本（代码维护）',
        ledger.ranked().map((e) => ({
          id: e.id,
          root_component: e.rootComponent,
          mechanism: e.mechanism,
          status: e.status,
          basis: e.reasons.slice(-3),
          checks_run: e.checksRun,
        })),
      ),
      [],
      'redact',
    ),
    ...extraSegments,
    ...cardSegments(checks, [], '区分性检查产生的证据卡', c),
  ];
}

export interface PromptParts {
  rc: ResearchCase;
  system: Segment;
  catalog: Segment;
  incident: Segment[];
  /** 事件数据段完整放入的卡（selectCards 的 included） */
  fullRefs: ReadonlySet<string>;
}

export function promptParts(
  language: Language,
  c: ResearchCase,
  book: EvidenceBook,
  contextTokens: number,
  previous: PreviousRun | null,
): PromptParts {
  return {
    rc: c,
    system: seg(PROMPTS[language].system, [], 'allow'),
    catalog: catalogSegment(c),
    incident: incidentSegments(c, book, contextTokens, previous),
    fullRefs: new Set(selectCards(book, c, contextTokens).included.map((x) => x.ref)),
  };
}

export function hypothesizeItems(
  language: Language,
  p: PromptParts,
  ledger: Ledger | null,
  book: EvidenceBook,
): Item[] {
  return [
    { type: 'system', segments: [p.system] },
    { type: 'user', segments: [p.catalog, ...p.incident] },
    {
      type: 'user',
      segments: [
        ...(ledger && ledger.list().length ? ledgerSegment(ledger, book, p) : []),
        seg(PROMPTS[language].hypothesize, [], 'allow'),
      ],
    },
  ];
}

export function concludeItems(language: Language, p: PromptParts, ledger: Ledger, book: EvidenceBook): Item[] {
  return [
    { type: 'system', segments: [p.system] },
    { type: 'user', segments: [p.catalog, ...p.incident] },
    { type: 'user', segments: [...ledgerSegment(ledger, book, p), seg(PROMPTS[language].conclude, [], 'allow')] },
  ];
}

export function judgeItems(
  language: Language,
  input: { hypothesis: string; purpose: string; refutesIf: string; tool: string; result: string },
): Item[] {
  return [
    { type: 'system', segments: [seg(PROMPTS[language].judge, [], 'allow')] },
    {
      type: 'user',
      segments: [
        seg(
          fenced('检查', {
            hypothesis: input.hypothesis,
            purpose: input.purpose,
            refutes_if: input.refutesIf,
            tool: input.tool,
          }),
          [],
          'redact',
        ),
        seg(`## 工具结果\n${input.result}`, ['metrics', 'logs', 'events'], 'redact'),
      ],
    },
  ];
}

/** 小模型判定只读工具结果的输出 schema（可移植子集） */
export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'] },
    summary: { type: 'string', maxLength: 400 },
  },
} as const;
