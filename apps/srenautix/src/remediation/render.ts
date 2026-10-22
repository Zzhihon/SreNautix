import type { Alert, EvidenceResult, LocalizedText, RepositoryLayout } from '@srenautix/contract';
import { globToRegExp, type RemediationContext, type RemediationPlan } from '@srenautix/packs-sdk';
import { applyPatch, parsePatch } from 'diff';
import { parseAllDocuments } from 'yaml';

/**
 * 自愈 PR 的上下文、校验与描述（ADR 0108），全部是纯函数：
 * - contextOf：事件、根因、卡片（全局 id → 最严重的结论）与成员告警 → packs-sdk 的 RemediationContext；
 * - validatePlan：server 侧对补丁的校验（镜像里没有 git）——路径在布局里、before 与基准提交逐字节相同、补丁在内存中
 *   应用到 before 得到 after、after 能解析、大小在 gitops_pr 的上限内；
 * - prBody：带 srenautix:pr=<段> 标记的 PR 描述，段落固定为 结论、证据、改了什么、验证计划、回滚、研判运行。
 */

export type Lang = 'zh' | 'en';
const loc = (l: Lang) => (l === 'zh' ? 'zh-CN' : 'en');
export const say = (t: LocalizedText | undefined, l: Lang): string =>
  (t?.[loc(l)] ?? t?.['zh-CN'] ?? t?.en ?? '').trim();

const SEVERITY: Record<string, number> = { abnormal: 0, undeterminable: 1, normal: 2 };

/**
 * 同一张卡在多个实体上执行时取最严重的结论（abnormal > undeterminable > normal）；observations 是这一份结果的
 * let 绑定取值（判定的明细，例如发布卡的 missing），没有时不出现
 */
export function cardsOf(cards: EvidenceResult[]): RemediationContext['cards'] {
  const out: RemediationContext['cards'] = {};
  for (const c of cards) {
    const cur = out[c.card_id];
    if (!cur || (SEVERITY[c.verdict] ?? 3) < (SEVERITY[cur.verdict] ?? 3)) {
      out[c.card_id] = {
        verdict: c.verdict,
        display_state: c.display_state,
        value: c.value === null || c.value === undefined ? null : String(c.value),
        ...(c.reason?.kind ? { reason_kind: c.reason.kind } : {}),
        ...(c.observations ? { observations: { ...c.observations } } : {}),
      };
    }
  }
  return out;
}

export function alertsOf(alerts: Alert[]): RemediationContext['alerts'] {
  const str = (l: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(l ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return alerts.map((a) => ({
    alertname: a.alertname,
    labels: str(a.labels),
    annotations: str(a.annotations),
    role: a.classification.role,
    source: a.classification.source,
    catalog_entry: a.classification.catalog_entry ?? null,
    chronic: a.classification.chronic === true,
    entity: a.entity ? { ...a.entity } : null,
  }));
}

export interface PlanProblem {
  path: string | null;
  message: string;
}

/** gitops_pr 的 params.patch 上限（动作目录） */
export const MAX_PATCH = 65536;

function formatOf(path: string, layout: RepositoryLayout): 'json' | 'yaml' | null {
  for (const f of Object.values(layout)) {
    if (f && (f.path === path || (/[*?]/.test(f.path) && globToRegExp(f.path).test(path)))) {
      return f.format;
    }
  }
  return null;
}

const stripAB = (p: string | undefined) => (p ?? '').replace(/^[ab]\//, '');

export async function validatePlan(
  plan: RemediationPlan,
  layout: RepositoryLayout,
  readBase: (path: string) => Promise<string | null>,
): Promise<PlanProblem[]> {
  const out: PlanProblem[] = [];
  if (!plan.files.length || !plan.patch) {
    return [{ path: null, message: '补丁为空' }];
  }
  if (plan.patch.length > MAX_PATCH) {
    out.push({ path: null, message: `补丁 ${plan.patch.length} 字符，超过 gitops_pr 的上限 ${MAX_PATCH}` });
  }
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(plan.patch);
  } catch (e) {
    return [...out, { path: null, message: `补丁不是 unified diff：${(e as Error).message}` }];
  }
  const byPath = new Map(parsed.map((p) => [stripAB(p.newFileName ?? p.oldFileName), p]));
  if (byPath.size !== plan.files.length) {
    out.push({ path: null, message: `补丁涉及 ${byPath.size} 个文件，计划列出 ${plan.files.length} 个` });
  }
  for (const f of plan.files) {
    const fmt = formatOf(f.path, layout);
    if (!fmt) {
      out.push({ path: f.path, message: '路径不在仓库布局的任何文件角色里' });
      continue;
    }
    const base = await readBase(f.path);
    if (base !== f.before) {
      out.push({ path: f.path, message: `修改前的内容与基准提交 ${plan.base.slice(0, 12)} 不一致` });
      continue;
    }
    const p = byPath.get(f.path);
    const applied = p ? applyPatch(f.before, p) : false;
    if (applied === false || applied !== f.after) {
      out.push({ path: f.path, message: '补丁应用到基准内容后与计划的结果不一致' });
    }
    try {
      if (fmt === 'json') {
        JSON.parse(f.after);
      } else {
        const bad = parseAllDocuments(f.after)
          .flatMap((d) => ('errors' in d ? d.errors : []))
          .map((e) => e.message);
        if (bad.length) {
          throw new Error(bad[0]);
        }
      }
    } catch (e) {
      out.push({ path: f.path, message: `修改后的 ${fmt.toUpperCase()} 不能解析：${(e as Error).message}` });
    }
  }
  return out;
}

export interface PrBodyInput {
  lang: Lang;
  plan: RemediationPlan;
  incidentId: string;
  incidentLabel: string;
  root: string | null;
  run: { runId: string; summary: string | null; level: string };
  /** 关键证据卡：支持结论的在前，其次异常的，最多 6 张 */
  cards: EvidenceResult[];
  consoleUrl: string;
  /** 事件 issue 的引用（#n 或 owner/name#n）；没有时省略 */
  refs: string | null;
}

const marker = (s: string) => `<!-- srenautix:pr=${s} -->`;
const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 200);

const L = {
  zh: {
    summary: '结论',
    evidence: '证据',
    change: '改了什么',
    verify: '验证计划',
    rollback: '回滚',
    run: '研判运行',
    root: '根因',
    level: { likely: '可能', evidence_consistent: '证据一致', inconclusive: '无法判定' } as Record<string, string>,
    card: '证据卡',
    verdict: '判定',
    value: '值',
    note: '说明',
    noCards: '没有证据卡',
    template: (key: string, cat: string, base: string) => `模板 \`${key}\`（${cat}），基于提交 \`${base}\`。`,
    within: (w: string) => `合并并同步后 ${w} 内核对：`,
    cardsToCheck: '应判为正常的证据卡',
    links: (run: string, inc: string) => `研判运行：${run} · 事件：${inc}`,
    footer: '由 SreNautix 根据研判结论与领域包的修复模板生成；SreNautix 从不合并，合并与否由审阅者决定。',
  },
  en: {
    summary: 'Conclusion',
    evidence: 'Evidence',
    change: 'What changes',
    verify: 'Verification plan',
    rollback: 'Rollback',
    run: 'Research run',
    root: 'Root cause',
    level: { likely: 'likely', evidence_consistent: 'evidence consistent', inconclusive: 'inconclusive' } as Record<
      string,
      string
    >,
    card: 'Card',
    verdict: 'Verdict',
    value: 'Value',
    note: 'Note',
    noCards: 'No evidence cards',
    template: (key: string, cat: string, base: string) => `Template \`${key}\` (${cat}) against commit \`${base}\`.`,
    within: (w: string) => `Within ${w} after the merge and sync:`,
    cardsToCheck: 'Cards expected to read normal',
    links: (run: string, inc: string) => `Research run: ${run} · Incident: ${inc}`,
    footer:
      'Generated by SreNautix from the research conclusion and a pack remediation template. SreNautix never merges; reviewers decide.',
  },
};

/** PR 描述；超过 limit 时先截短证据表，再截短改动说明 */
export function prBody(i: PrBodyInput, limit = 7600): string {
  const t = L[i.lang];
  const base = i.consoleUrl.replace(/\/+$/, '');
  const runUrl = `${base}/runs/${i.run.runId}`;
  const incUrl = `${base}/incidents/${i.incidentId}`;
  const build = (cards: EvidenceResult[], changeChars: number) => {
    const lines: string[] = [
      marker('summary'),
      `## ${t.summary}`,
      '',
      `${i.run.summary ?? '-'}（${t.level[i.run.level] ?? i.run.level}）`,
      '',
      `**${t.root}**：${i.root ?? '-'} · ${i.incidentLabel}`,
      '',
      marker('evidence'),
      `## ${t.evidence}`,
      '',
    ];
    if (cards.length) {
      lines.push(`| ${t.card} | ${t.verdict} | ${t.value} | ${t.note} |`, '|---|---|---|---|');
      for (const c of cards) {
        const title = say(c.title as LocalizedText, i.lang) || c.card_id;
        const value = c.value === null || c.value === undefined ? '-' : String(c.value);
        lines.push(
          `| ${cell(title)} | ${cell(c.display_state ?? c.verdict)} | ${cell(value)} | ${cell(c.reason?.text ?? '')} |`,
        );
      }
    } else {
      lines.push(t.noCards);
    }
    const change = say(i.plan.change, i.lang);
    lines.push(
      '',
      marker('change'),
      `## ${t.change}`,
      '',
      change.length > changeChars ? `${change.slice(0, changeChars)}…` : change,
      '',
      ...i.plan.files.map((f) => `- \`${f.path}\``),
      '',
      t.template(i.plan.key, i.plan.category, i.plan.base.slice(0, 12)),
      '',
      marker('verify'),
      `## ${t.verify}`,
      '',
      ...(i.plan.verify.within ? [t.within(i.plan.verify.within)] : []),
      say(i.plan.verify.say, i.lang),
      ...(i.plan.verify.cards.length
        ? ['', `${t.cardsToCheck}：${i.plan.verify.cards.map((c) => `\`${c}\``).join('、')}`]
        : []),
      '',
      marker('rollback'),
      `## ${t.rollback}`,
      '',
      say(i.plan.rollback.say, i.lang),
      '',
      marker('run'),
      `## ${t.run}`,
      '',
      t.links(`[${i.run.runId}](${runUrl})`, `[${i.incidentId}](${incUrl})`),
      '',
      `_${t.footer}_`,
      '',
      ...(i.refs ? [`Refs ${i.refs}`] : []),
      `<!-- srenautix:incident=${i.incidentId} -->`,
    );
    return lines.join('\n');
  };
  let body = build(i.cards, 2000);
  for (let n = i.cards.length - 1; body.length > limit && n >= 0; n--) {
    body = build(i.cards.slice(0, n), 2000);
  }
  if (body.length > limit) {
    body = build([], 400);
  }
  return body;
}

/** 关键证据卡：结论假设的支持卡在前，其次异常的、无法判定的，最多 n 张 */
export function keyCards(cards: EvidenceResult[], supporting: ReadonlySet<string>, n = 6): EvidenceResult[] {
  const rank = (c: EvidenceResult) =>
    (supporting.has(c.ref) ? 0 : 3) + (c.verdict === 'abnormal' ? 0 : c.verdict === 'normal' ? 2 : 1);
  return [...cards].sort((a, b) => rank(a) - rank(b)).slice(0, n);
}

/** 分支名：srenautix/<事件前 8 位>-<类别>-<补丁摘要前 6 位> */
export function branchOf(incidentId: string, category: string, digest: string): string {
  return `srenautix/${incidentId.slice(0, 8)}-${category.replace(/_/g, '-')}-${digest.slice(0, 6)}`;
}
