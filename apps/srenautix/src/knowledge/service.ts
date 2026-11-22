import { randomUUID } from 'node:crypto';
import type { Feedback, FeedbackReasonCode, HubComponents, Incident } from '@srenautix/contract';
import { displayKey } from '@srenautix/core';
import type pg from 'pg';
import { badRequest, conflict, notFound } from '../kernel/errors.js';
import type { RoleBinding, Target } from '../identity/bindings.js';
import { componentTarget, visible } from '../incident/target.js';
import { appendAudit } from '../kernel/store/audit.js';
import { tx } from '../kernel/store/pool.js';
import { BENIGN_REASON_CODES } from '../proposals/candidates.js';
import type { KnowledgeItem } from '../research/types.js';
import type { PackRuntime } from '../stage-a/packs.js';
import type { TopologyStore } from '../topology/store.js';

export type PromoteIncidentKnowledgeRequest = HubComponents['schemas']['PromoteIncidentKnowledgeRequest'];
export type LearnedKnowledgeItem = HubComponents['schemas']['LearnedKnowledgeItem'];
export type KnowledgeCatalogItem = HubComponents['schemas']['KnowledgeCatalogItem'];

const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 2000;
const MAX_LIST_SQL_LIMIT = 2000;
export const DEFAULT_RESEARCH_KNOWLEDGE_LIMIT = 8;

interface LearnedRow {
  case_id: string;
  cluster_id: string;
  incident_id: string | null;
  feedback_id: string | null;
  kind: 'incident' | 'benign';
  title: string;
  components: string[];
  alertnames: string[];
  text: string;
  source: 'human' | 'model';
  created_by: string;
  created_at: Date;
}

interface LearnedListRow extends LearnedRow {
  incident_root_component: string | null;
}

interface LatestFeedbackRow {
  feedback_id: string;
  verdict: Feedback['verdict'];
  root_component: string | null;
  disposition_verdict: Feedback['disposition_verdict'];
  disposition: Feedback['disposition'];
  mechanism: string | null;
  reason: string | null;
  reason_code: FeedbackReasonCode | null;
}

interface LatestRunRow {
  disposition: string | null;
  root_component: string | null;
  summary: string | null;
  output: {
    conclusion?: { hypothesis_id?: string | null; root_component?: string | null };
    hypotheses?: Array<{ id: string; mechanism?: string }>;
  } | null;
}

function cutChars(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function uniqueStrings(list: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const v = raw?.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

function allowedClustersFor(scopes: RoleBinding[] | 'all'): string[] | null {
  if (scopes === 'all') {
    return null;
  }
  const out = new Set<string>();
  for (const b of scopes) {
    if (b.scope.clusters.includes('*')) {
      return null;
    }
    for (const c of b.scope.clusters) {
      out.add(c);
    }
  }
  return [...out];
}

function hasUnrestrictedRead(scopes: RoleBinding[] | 'all'): boolean {
  return (
    scopes === 'all' ||
    scopes.some(
      (b) =>
        b.scope.clusters.includes('*') &&
        b.scope.namespaces.includes('*') &&
        Object.keys(b.scope.component_labels).length === 0,
    )
  );
}

/**
 * 人工沉淀知识条目的授权目标：从 components 中的组件键（含 `:`）与关联事件根因组件提取命名空间；
 * 没有具体组件键时按集群级对象处理（fail-closed，仅 namespaces 包含 `*` 的作用域可见）。
 */
export function knowledgeTargets(
  clusterId: string,
  components: readonly string[],
  incidentRootComponent: string | null = null,
): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    const t = componentTarget(clusterId, key);
    const id = t.namespace ?? '*';
    if (!seen.has(id)) {
      seen.add(id);
      targets.push(t);
    }
  };
  for (const c of components) {
    if (c.includes(':')) {
      add(c);
    }
  }
  if (incidentRootComponent && incidentRootComponent.includes(':')) {
    add(incidentRootComponent);
  }
  if (!targets.length) {
    targets.push({ cluster: clusterId, namespace: null, labels: {} });
  }
  return targets;
}

/** 调用方对一条数据库沉淀知识是否可见：条目涉及的全部授权目标都必须被调用方作用域覆盖。 */
export function knowledgeVisible(
  scopes: RoleBinding[] | 'all',
  clusterId: string,
  components: readonly string[],
  incidentRootComponent: string | null = null,
): boolean {
  if (scopes === 'all') {
    return true;
  }
  return knowledgeTargets(clusterId, components, incidentRootComponent).every((t) => visible(scopes, t));
}

function toLearnedItem(r: LearnedRow): LearnedKnowledgeItem {
  return {
    case_id: r.case_id,
    origin: 'learned',
    cluster_id: r.cluster_id,
    incident_id: r.incident_id,
    feedback_id: r.feedback_id,
    kind: r.kind,
    title: r.title,
    components: r.components,
    alertnames: r.alertnames,
    text: r.text,
    source: r.source,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
  };
}

/** 从已加载领域包读取全部静态知识条目（用于 GET /v1/knowledge，不改 stage-a/packs.ts） */
export function packKnowledgeCatalog(packs: PackRuntime, locale: 'zh-CN' | 'en'): KnowledgeCatalogItem[] {
  const other = locale === 'zh-CN' ? 'en' : 'zh-CN';
  const out: KnowledgeCatalogItem[] = [];
  for (const p of packs.set.packs) {
    for (const file of Object.values(p.content.knowledge)) {
      for (const e of file.entries) {
        const text = (e.text[locale] ?? e.text[other] ?? '').trim();
        const caseId = `${p.name}/${e.id}`;
        out.push({
          case_id: caseId,
          origin: 'pack',
          cluster_id: null,
          incident_id: null,
          feedback_id: null,
          kind: 'incident',
          title: e.id,
          components: e.components ?? [],
          alertnames: [],
          text,
          source: e.source,
          created_by: null,
          created_at: e.learned_at ?? null,
        });
      }
    }
  }
  return out.sort((a, b) => (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0));
}

/**
 * 人工沉淀的知识案例服务：支持从事件/反馈一键沉淀、查询（与领域包静态知识合并）、软归档，以及阶段 B 检索。
 * 检索出的条目标注 learned_from 与 learned_at，供 eval/leakage.ts 严格防泄漏。
 */
export class LearnedKnowledgeService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly topology?: Pick<TopologyStore, 'componentType'>,
  ) {}

  async promoteIncident(
    principalId: string,
    incident: Incident,
    req: PromoteIncidentKnowledgeRequest = {},
  ): Promise<{ item: LearnedKnowledgeItem; created: boolean }> {
    let fb: LatestFeedbackRow | null = null;
    if (req.feedback_id !== undefined && req.feedback_id !== null) {
      const r = await this.pool.query<LatestFeedbackRow>(
        `SELECT feedback_id, verdict, root_component, disposition_verdict, disposition, mechanism, reason, reason_code
           FROM server.feedback
          WHERE feedback_id = $1 AND incident_id = $2`,
        [req.feedback_id, incident.incident_id],
      );
      if (!r.rows[0]) {
        throw badRequest(`反馈 ${req.feedback_id} 不属于这个事件`);
      }
      fb = r.rows[0];
    } else if (req.feedback_id === undefined) {
      const r = await this.pool.query<LatestFeedbackRow>(
        `SELECT feedback_id, verdict, root_component, disposition_verdict, disposition, mechanism, reason, reason_code
           FROM server.feedback
          WHERE incident_id = $1 AND linked = true
            AND (implicit IS NULL OR implicit NOT IN ('approved', 'pr_closed', 'issue_not_planned'))
          ORDER BY created_at DESC, feedback_id DESC
          LIMIT 1`,
        [incident.incident_id],
      );
      fb = r.rows[0] ?? null;
    }

    const runRes = await this.pool.query<LatestRunRow>(
      `SELECT disposition, root_component, summary, output
         FROM server.research_runs
        WHERE incident_id = $1 AND state = 'completed'
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1`,
      [incident.incident_id],
    );
    const run = runRes.rows[0] ?? null;

    const kind: 'incident' | 'benign' =
      req.kind ??
      (fb?.reason_code && BENIGN_REASON_CODES.has(fb.reason_code)
        ? 'benign'
        : fb?.disposition === 'ignore' || (fb === null && run?.disposition === 'ignore')
          ? 'benign'
          : 'incident');

    const activeMembers = incident.members.filter((m) => m.left_version === null);
    const members = activeMembers.length ? activeMembers : incident.members;
    const derivedAlertnames = uniqueStrings(members.map((m) => m.alertname)).sort();
    const alertnames = req.alertnames !== undefined ? uniqueStrings(req.alertnames) : derivedAlertnames;

    const effectiveRoot =
      (fb?.verdict === 'rejected' && fb.root_component) ||
      fb?.root_component ||
      run?.root_component ||
      incident.root.component ||
      null;

    let components: string[];
    if (req.components !== undefined) {
      components = uniqueStrings(req.components);
    } else {
      const compType =
        effectiveRoot && this.topology
          ? await this.topology.componentType(incident.cluster_id, effectiveRoot).catch(() => null)
          : null;
      components = uniqueStrings([compType, effectiveRoot]);
    }

    const title = cutChars(
      req.title?.trim() ||
        (effectiveRoot && alertnames[0]
          ? `${alertnames[0]} (${displayKey(effectiveRoot)})`
          : alertnames[0] || incident.label),
      MAX_TITLE_CHARS,
    );

    const chosenHyp = run?.output?.conclusion?.hypothesis_id
      ? run.output.hypotheses?.find((h) => h.id === run.output?.conclusion?.hypothesis_id)?.mechanism
      : undefined;
    const derivedParts = uniqueStrings([
      fb?.mechanism,
      fb?.reason,
      fb?.reason_code ? `原因码：${fb.reason_code}` : null,
      chosenHyp,
      run?.summary,
    ]);
    const fallbackText =
      kind === 'benign'
        ? `历史人工确认的良性/误报模式：${title}`
        : `事件 ${incident.label}${effectiveRoot ? `，根因组件 ${displayKey(effectiveRoot)}` : ''}`;
    const text = cutChars(req.text?.trim() || derivedParts.join('；') || fallbackText, MAX_TEXT_CHARS);
    const feedbackId = req.feedback_id === null ? null : (fb?.feedback_id ?? null);

    return tx(this.pool, async (c) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const caseId = randomUUID();
        const inserted = await c.query<LearnedRow>(
          `INSERT INTO server.learned_knowledge
             (case_id, cluster_id, incident_id, feedback_id, kind, title, components, alertnames, text, source, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'human', $10)
           ON CONFLICT (cluster_id, incident_id, kind) WHERE incident_id IS NOT NULL AND archived_at IS NULL
           DO NOTHING
           RETURNING case_id, cluster_id, incident_id, feedback_id, kind, title, components, alertnames, text, source, created_by, created_at`,
          [
            caseId,
            incident.cluster_id,
            incident.incident_id,
            feedbackId,
            kind,
            title,
            components,
            alertnames,
            text,
            principalId,
          ],
        );
        if (inserted.rows[0]) {
          const item = toLearnedItem(inserted.rows[0]);
          await appendAudit(c, 'knowledge.promoted', principalId, {
            case_id: item.case_id,
            cluster_id: item.cluster_id,
            incident_id: item.incident_id,
            feedback_id: item.feedback_id,
            kind: item.kind,
            title: item.title,
            components: item.components,
            alertnames: item.alertnames,
          });
          return { item, created: true };
        }
        const existing = await c.query<LearnedRow>(
          `SELECT case_id, cluster_id, incident_id, feedback_id, kind, title, components, alertnames, text, source, created_by, created_at
             FROM server.learned_knowledge
            WHERE cluster_id = $1 AND incident_id = $2 AND kind = $3 AND archived_at IS NULL
            LIMIT 1`,
          [incident.cluster_id, incident.incident_id, kind],
        );
        if (existing.rows[0]) {
          return { item: toLearnedItem(existing.rows[0]), created: false };
        }
      }
      throw conflict('knowledge_conflict', '知识案例正在被并发归档或修改，请重试');
    });
  }

  async list(
    opts: {
      origin?: 'all' | 'learned' | 'pack';
      kind?: 'incident' | 'benign';
      q?: string;
      limit?: number;
      scopes?: RoleBinding[] | 'all';
    },
    packItems: readonly KnowledgeCatalogItem[],
  ): Promise<KnowledgeCatalogItem[]> {
    const origin = opts.origin ?? 'all';
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const scopes = opts.scopes ?? 'all';
    const query = opts.q?.trim().toLowerCase() ?? '';
    const like = query ? `%${escapeLike(query)}%` : null;
    const items: KnowledgeCatalogItem[] = [];

    if (origin === 'all' || origin === 'learned') {
      const clusters = allowedClustersFor(scopes);
      const sqlLimit = hasUnrestrictedRead(scopes) ? limit : Math.min(Math.max(limit * 5, 200), MAX_LIST_SQL_LIMIT);
      const r = await this.pool.query<LearnedListRow>(
        `SELECT k.case_id, k.cluster_id, k.incident_id, k.feedback_id, k.kind, k.title,
                k.components, k.alertnames, k.text, k.source, k.created_by, k.created_at,
                COALESCE(i.root_component, i.body->'components'->>0) AS incident_root_component
           FROM server.learned_knowledge k
           LEFT JOIN server.incidents i ON i.incident_id = k.incident_id
          WHERE k.archived_at IS NULL
            AND ($1::text IS NULL OR k.kind = $1)
            AND ($2::text[] IS NULL OR k.cluster_id = ANY($2::text[]))
            AND (
              $3::text IS NULL
              OR k.case_id::text ILIKE $3 ESCAPE '\\'
              OR k.title ILIKE $3 ESCAPE '\\'
              OR k.text ILIKE $3 ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM unnest(k.components) AS c WHERE c ILIKE $3 ESCAPE '\\')
              OR EXISTS (SELECT 1 FROM unnest(k.alertnames) AS a WHERE a ILIKE $3 ESCAPE '\\')
            )
          ORDER BY k.created_at DESC, k.case_id ASC
          LIMIT $4`,
        [opts.kind ?? null, clusters, like, sqlLimit],
      );
      for (const row of r.rows) {
        if (knowledgeVisible(scopes, row.cluster_id, row.components, row.incident_root_component)) {
          items.push(toLearnedItem(row));
          if (items.length >= limit) {
            break;
          }
        }
      }
    }

    if ((origin === 'all' || origin === 'pack') && items.length < limit) {
      for (const p of packItems) {
        if (opts.kind && p.kind !== opts.kind) {
          continue;
        }
        if (
          query &&
          !(
            p.case_id.toLowerCase().includes(query) ||
            p.title.toLowerCase().includes(query) ||
            p.text.toLowerCase().includes(query) ||
            p.components.some((c) => c.toLowerCase().includes(query)) ||
            p.alertnames.some((a) => a.toLowerCase().includes(query))
          )
        ) {
          continue;
        }
        items.push(p);
        if (items.length >= limit) {
          break;
        }
      }
    }

    return items;
  }

  async archive(principalId: string, caseId: string): Promise<void> {
    await tx(this.pool, async (c) => {
      const r = await c.query<{ case_id: string; incident_id: string | null; kind: string; title: string }>(
        `UPDATE server.learned_knowledge
            SET archived_at = now()
          WHERE case_id = $1 AND archived_at IS NULL
          RETURNING case_id, incident_id, kind, title`,
        [caseId],
      );
      const row = r.rows[0];
      if (!row) {
        throw notFound(`没有知识案例 ${caseId}`);
      }
      await appendAudit(c, 'knowledge.archived', principalId, {
        case_id: row.case_id,
        incident_id: row.incident_id,
        kind: row.kind,
        title: row.title,
      });
    });
  }

  /**
   * 阶段 B 检索人工沉淀的知识案例：按组件类型/组件键或成员告警名重合检索，排除本事件自身与未来条目，
   * 按重合得分降序、创建时间降序、case_id 升序取前 limit 条（默认 8 条）。
   */
  async retrieveForResearch(opts: {
    clusterId: string;
    incidentId: string;
    componentKeys: readonly string[];
    componentTypes: readonly string[];
    alertnames: readonly string[];
    before?: Date;
    limit?: number;
  }): Promise<KnowledgeItem[]> {
    const components = uniqueStrings([...opts.componentTypes, ...opts.componentKeys]);
    const alertnames = uniqueStrings(opts.alertnames);
    if (!components.length && !alertnames.length) {
      return [];
    }
    const before = opts.before ?? new Date();
    const limit = opts.limit ?? DEFAULT_RESEARCH_KNOWLEDGE_LIMIT;
    const r = await this.pool.query<LearnedRow>(
      `SELECT case_id, cluster_id, incident_id, feedback_id, kind, title, components, alertnames, text, source, created_by, created_at
         FROM server.learned_knowledge
        WHERE cluster_id = $1
          AND incident_id IS DISTINCT FROM $2
          AND archived_at IS NULL
          AND created_at <= $3
          AND (components && $4::text[] OR alertnames && $5::text[])
        ORDER BY
          (
            (SELECT count(*)::int FROM unnest(components) AS c WHERE c = ANY($4::text[])) +
            (SELECT count(*)::int FROM unnest(alertnames) AS a WHERE a = ANY($5::text[]))
          ) DESC,
          created_at DESC,
          case_id ASC
        LIMIT $6`,
      [opts.clusterId, opts.incidentId, before, components, alertnames, limit],
    );
    return r.rows.map((row) => ({
      id: `learned/${row.case_id}`,
      components: row.components,
      text: `[${row.kind}] ${row.title}: ${row.text}`,
      learned_from: [row.incident_id ?? `manual/${row.case_id}`],
      learned_at: row.created_at.toISOString(),
      source: row.source,
    }));
  }
}
