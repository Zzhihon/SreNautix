import type { Item, Segment } from '../llm/types.js';
import type { Language } from '../prompts/index.js';
import type { CardEntry, EvidenceBook } from '../research/evidence.js';
import type { Ledger } from '../research/ledger.js';
import { OPTIMIZE_PROMPTS } from './prompts.js';
import type { GoalRunContext } from './runner.js';

// 主动优化的提示词片段（ADR 0146 §2.3），与事件研判一样按稳定前缀排列：
// 1. 固定指令；2. 查询模板目录；3. 目标、基线、差距、候选发现、拓扑与证据卡；4. 步骤相关的账本与检查卡、本步骤的任务说明。
// 出境类别（§3.6）：规范化语句文本（候选实体的显示名、语句类卡片的表格）带 sql 类别，单独成段，
// 没有在 llm.egress.categories 列出时只删掉这些片段，卡片的判定与数值照常出境。

const TABLE_ROWS = 8;
const CELL_CHARS = 160;
const TEXT_CHARS = 300;
const MAX_TOPOLOGY_NODES = 40;
const MAX_TOPOLOGY_EDGES = 60;
const MAX_OTHER_CANDIDATES = 10;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function fenced(title: string, value: unknown): string {
  return `## ${title}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function seg(text: string, categories: Segment['categories'], egress: Segment['egress']): Segment {
  return { text, categories, egress };
}

/** 表头含这些词的卡片表格带规范化语句文本 */
const SQL_COLUMN = /query|statement|sql|语句/i;

/**
 * 发现实体的 statement 标签是 server 经 dbstats statements.text 取得的规范化语句（slow-statement 的 sql 锚点），
 * 带 sql 类别单独成段
 */
function withoutStatement(labels: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(labels).filter(([k]) => k !== 'statement'));
}

function cardBody(c: CardEntry): Record<string, unknown> {
  const r = c.result;
  return {
    ref: c.ref,
    card: r.card_id,
    entity: c.component,
    verdict: r.verdict,
    value: r.value,
    reason: cut(r.reason.text, TEXT_CHARS),
    anomaly_started_at: r.anomaly_started_at ?? null,
    window: r.window,
    ...(c.hypothesisId ? { check_for: c.hypothesisId, judged_by: c.judgedBy } : {}),
  };
}

function cardTable(c: CardEntry): Record<string, unknown> | null {
  const t = c.result.table;
  if (!t || !t.rows.length) {
    return null;
  }
  return {
    ref: c.ref,
    head: t.head,
    rows: t.rows.slice(0, TABLE_ROWS).map((row) => row.map((x) => cut(x, CELL_CHARS))),
  };
}

/** 卡片：判定与数值一段（metrics），表格按是否带语句文本分段 */
export function cardSegments(cards: readonly CardEntry[], title: string): Segment[] {
  const out: Segment[] = [];
  for (const egress of ['allow', 'redact'] as const) {
    const list = cards.filter((c) => c.result.egress === egress);
    if (!list.length) {
      continue;
    }
    const suffix = egress === 'redact' ? '（脱敏）' : '';
    out.push(seg(fenced(`${title}${suffix}`, list.map(cardBody)), ['metrics'], egress));
    const tables = list.map((c) => ({ c, t: cardTable(c) })).filter((x) => x.t !== null);
    const sql = tables.filter((x) => x.c.result.table!.head.some((h) => SQL_COLUMN.test(h)));
    const plain = tables.filter((x) => !sql.includes(x));
    if (plain.length) {
      out.push(
        seg(
          fenced(
            `${title}的表格${suffix}`,
            plain.map((x) => x.t),
          ),
          ['metrics'],
          egress,
        ),
      );
    }
    if (sql.length) {
      out.push(
        seg(
          fenced(
            `${title}的表格（含规范化语句）${suffix}`,
            sql.map((x) => x.t),
          ),
          ['metrics', 'sql'],
          egress,
        ),
      );
    }
  }
  return out;
}

export interface OptimizeParts {
  system: Segment;
  catalog: Segment;
  goal: Segment[];
}

export function optimizeParts(language: Language, ctx: GoalRunContext, book: EvidenceBook): OptimizeParts {
  const selected = ctx.candidates.filter((c) => c.selected);
  const others = ctx.candidates.filter((c) => !c.selected).slice(0, MAX_OTHER_CANDIDATES);
  const spec = ctx.goal.spec;
  const goal: Segment[] = [
    seg(
      [
        fenced('目标', {
          goal_id: ctx.goal.goal_id,
          domain: ctx.domain,
          subject: spec.subject,
          objective: spec.objective,
        }),
        fenced('基线（按小时取值之后的统计）', {
          window: ctx.baseline.window,
          sufficient: ctx.baseline.sufficient,
          indicators: ctx.baseline.indicators.map(({ hourly: _hourly, ...rest }) => rest),
        }),
        fenced('差距（代码计算）', ctx.gap),
      ].join('\n\n'),
      ['metrics'],
      'allow',
    ),
    seg(
      [
        fenced(
          '进入分析的发现（finding 为发现指纹，按份额 × 差距排序）',
          selected.map((c) => ({
            finding: c.finding,
            kind: c.kind,
            entity_type: c.entity.type,
            entity: c.entity.key,
            labels: withoutStatement(c.entity.labels),
            display: c.entity.display,
            component: c.component,
            diagnostic: c.diagnostic,
            card_ref: c.card_ref,
            share: c.share,
            share_ref: c.share_ref,
            gap: c.gap,
            symptoms: ctx.symptoms[c.finding] ?? [],
          })),
        ),
        ...(others.length
          ? [
              fenced(
                '未进入分析的候选',
                others.map((c) => ({ kind: c.kind, entity: c.entity.key, skipped_reason: c.skipped_reason })),
              ),
            ]
          : []),
      ].join('\n\n'),
      ['metrics'],
      'allow',
    ),
  ];
  const statements = selected.filter((c) => typeof c.entity.labels.statement === 'string');
  if (statements.length) {
    goal.push(
      seg(
        fenced(
          '发现实体的规范化语句（常量已替换为 $n）',
          statements.map((c) => ({ finding: c.finding, statement: cut(c.entity.labels.statement as string, 600) })),
        ),
        ['sql'],
        'redact',
      ),
    );
  }
  goal.push(
    seg(
      fenced('拓扑（范围内的组件与一跳邻居）', {
        nodes: ctx.topology.nodes.slice(0, MAX_TOPOLOGY_NODES).map((n) => ({ key: n.key, kind: n.kind })),
        edges: ctx.topology.edges
          .slice(0, MAX_TOPOLOGY_EDGES)
          .map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
      }),
      ['topology'],
      'allow',
    ),
    ...cardSegments(
      book.promptCards().filter((c) => c.hypothesisId === null),
      '诊断卡与份额卡',
    ),
  );
  return {
    system: seg(OPTIMIZE_PROMPTS[language].system, [], 'allow'),
    catalog: seg(
      fenced(
        '可用查询模板（区分性检查只能从这里选；参数按 args 的 schema 填写）',
        ctx.templates.map((t) => ({ id: t.id, description: t.description, args: t.args })),
      ),
      [],
      'allow',
    ),
    goal,
  };
}

function ledgerSegments(ledger: Ledger, book: EvidenceBook): Segment[] {
  return [
    seg(
      fenced(
        '假设账本（代码维护）',
        ledger.ranked().map((e) => ({
          id: e.id,
          finding: e.group,
          entity: e.rootComponent,
          mechanism: e.mechanism,
          symptoms: e.symptoms ?? [],
          status: e.status,
          basis: e.reasons.slice(-3),
          checks_run: e.checksRun,
        })),
      ),
      [],
      'redact',
    ),
    ...cardSegments(
      book.promptCards().filter((c) => c.hypothesisId !== null),
      '区分性检查产生的证据卡',
    ),
  ];
}

export function optimizeHypothesizeItems(
  language: Language,
  p: OptimizeParts,
  ledger: Ledger | null,
  book: EvidenceBook,
): Item[] {
  return [
    { type: 'system', segments: [p.system] },
    { type: 'user', segments: [p.catalog, ...p.goal] },
    {
      type: 'user',
      segments: [
        ...(ledger && ledger.list().length ? ledgerSegments(ledger, book) : []),
        seg(OPTIMIZE_PROMPTS[language].hypothesize, [], 'allow'),
      ],
    },
  ];
}

export function optimizeConcludeItems(
  language: Language,
  p: OptimizeParts,
  ledger: Ledger,
  book: EvidenceBook,
): Item[] {
  return [
    { type: 'system', segments: [p.system] },
    { type: 'user', segments: [p.catalog, ...p.goal] },
    {
      type: 'user',
      segments: [...ledgerSegments(ledger, book), seg(OPTIMIZE_PROMPTS[language].conclude, [], 'allow')],
    },
  ];
}
