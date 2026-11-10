import type {
  ChangeLink,
  EvidenceResult,
  Feedback,
  FeedbackCreate,
  HubComponents,
  Incident,
  Proposal,
  ReasonStage,
  StageAReport,
} from '@srenautix/contract';
import { reasonEntry, reasonText, validatorFor } from '@srenautix/contract';
import { NAMESPACE_KIND } from '@srenautix/core';
import type { ServiceCatalog } from '@srenautix/packs-sdk/business';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isBusinessImpact, type AlertMatcher } from '../alerts/business-impact.js';
import { badRequest, notFound } from '../kernel/errors.js';
import type { Auth } from '../identity/auth.js';
import { scopeMatches, type RoleBinding, type Target } from '../identity/bindings.js';
import { alertStatement, headlineMember } from '../incident/headline.js';
import { claimEvents, claimIncident, currentClaims, releaseIncident } from '../incident/claims.js';
import { withComponentNames } from '../incident/names.js';
import { incidentConditions, parseClassificationFilters, rowCategories, rowServices } from './incident-filters.js';
import { incidentVersion, latestStageA, resolveIncidentRef, type IncidentRow } from '../incident/read.js';
import { reasonsOf, type IncidentReasonStage } from '../incident/reasons.js';
import { researchRoots } from '../incident/research-root.js';
import { alertsById } from '../ingest/store.js';
import type { FeedbackService } from '../proposals/feedback.js';
import type { EvidenceRunner } from '../stage-a/ports.js';
import type { TopologyStore } from '../topology/store.js';
import { parseStoredKey } from '../topology/keys.js';

/** 组件的授权对象：组件所在的命名空间；没有组件时为集群级对象。 */
export function componentTarget(clusterId: string, key: string | null): Target {
  if (!key) {
    return { cluster: clusterId, namespace: null, labels: {} };
  }
  const k = parseStoredKey(key);
  return { cluster: clusterId, namespace: k.kind === NAMESPACE_KIND ? k.name : k.namespace, labels: {} };
}

/** 事件的授权对象：根因组件（没有时取第一个组件）所在的命名空间。 */
export function incidentTarget(inc: Pick<Incident, 'cluster_id' | 'root' | 'components'>): Target {
  return componentTarget(inc.cluster_id, inc.root.component ?? inc.components[0] ?? null);
}

export function visible(scopes: RoleBinding[] | 'all', t: Target): boolean {
  return scopes === 'all' || scopes.some((b) => scopeMatches(b, t));
}

const VERDICT_ORDER: Record<string, number> = { abnormal: 0, undeterminable: 1, normal: 2 };

export function sortCards(cards: EvidenceResult[]): EvidenceResult[] {
  return [...cards].sort(
    (a, b) => (VERDICT_ORDER[a.verdict] ?? 3) - (VERDICT_ORDER[b.verdict] ?? 3) || a.ref.localeCompare(b.ref),
  );
}

export interface IncidentRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  feedback: FeedbackService;
  topology: TopologyStore;
  evidence: EvidenceRunner;
  worker: { url: string; token: string } | null;
  /** 领域包 business.yaml 的服务目录（ADR 0193） */
  services: () => ServiceCatalog;
  /** 业务影响告警的定义（notify.business_impact_alerts，ADR 0166） */
  businessImpactAlerts: () => readonly AlertMatcher[];
}

/** 收件箱的一行（summaries 的结果） */
type Summary = Awaited<ReturnType<typeof summaries>>[number];

/** GET /v1/incidents 一次从状态库取的事件数上限：筛选、可见性与抑制在这些事件里执行，total 也只统计它们 */
const LIST_SCAN_LIMIT = 2000;

/** 事件列表与导出的翻页位置：上一页最后一个事件的 first_firing_at 与 incident_id */
export interface Cursor {
  t: string;
  id: string;
}

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(raw: string): Cursor {
  const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
  if (typeof c.t !== 'string' || typeof c.id !== 'string') {
    throw badRequest('cursor 不合法');
  }
  return c;
}

async function summaries(d: IncidentRouteDeps, rows: IncidentRow[]) {
  const { pool, feedback, topology } = d;
  const ids = rows.map((r) => r.incident_id);
  if (!ids.length) {
    return [];
  }
  const roots = await researchRoots(pool, (c, k, at) => topology.ownerOf(c, k, at), rows);
  const stage = await pool.query<{ incident_id: string; disposition: string; rendered_at: Date }>(
    'SELECT DISTINCT ON (incident_id) incident_id, disposition, rendered_at FROM server.stage_a_reports WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, incident_version DESC',
    [ids],
  );
  const runs = await pool.query<{
    incident_id: string;
    state: string;
    disposition: string | null;
    conclusion_level: string | null;
    summary: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT DISTINCT ON (incident_id) incident_id, state, disposition, conclusion_level, summary, started_at, finished_at FROM server.research_runs
      WHERE incident_id = ANY($1::uuid[]) AND state = 'completed' ORDER BY incident_id, started_at DESC`,
    [ids],
  );
  const headlines = await incidentHeadlines(pool, rows, new Map(runs.rows.map((x) => [x.incident_id, x.summary])));
  const pending = await pool.query<{ incident_id: string; n: number }>(
    "SELECT incident_id, count(*)::int AS n FROM server.proposals WHERE incident_id = ANY($1::uuid[]) AND state = 'awaiting_approval' GROUP BY incident_id",
    [ids],
  );
  const aliases = await pool.query<{ into_incident_id: string; n: number }>(
    'SELECT into_incident_id, count(*)::int AS n FROM server.incident_aliases WHERE into_incident_id = ANY($1::uuid[]) GROUP BY into_incident_id',
    [ids],
  );
  const fbs = await feedback.latest(pool, ids);
  const impact = await businessImpactOf(pool, rows, d.businessImpactAlerts());
  const claims = await currentClaims(pool, ids);
  const names = await pool.query<{ cluster_id: string; component: string; display_name: string }>(
    `SELECT n.cluster_id, n.component, n.display_name FROM server.component_names n
      JOIN unnest($1::text[], $2::text[]) AS w(cluster_id, component) USING (cluster_id, component)`,
    [rows.map((r) => r.cluster_id), rows.map((r) => r.root_component ?? '')],
  );
  const nm = new Map(names.rows.map((x) => [`${x.cluster_id}\0${x.component}`, x.display_name]));
  const st = new Map(stage.rows.map((x) => [x.incident_id, x]));
  const rr = new Map(runs.rows.map((x) => [x.incident_id, x]));
  const pc = new Map(pending.rows.map((x) => [x.incident_id, x.n]));
  const al = new Map(aliases.rows.map((x) => [x.into_incident_id, x.n]));
  return rows.map((r) => {
    const s = st.get(r.incident_id);
    const run = rr.get(r.incident_id);
    const fresh = [s?.rendered_at, run?.finished_at ?? undefined]
      .filter((x): x is Date => !!x)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const fb: Feedback | undefined = fbs.get(r.incident_id);
    return {
      incident_id: r.incident_id,
      cluster_id: r.cluster_id,
      label: r.label,
      incident_version: r.version,
      headline: headlines.get(r.incident_id) ?? null,
      state: r.state,
      severity: r.body.severity,
      ...rowCategories(r),
      ...rowServices(r),
      root_component: r.root_component,
      ambiguous: r.body.root.ambiguous,
      first_firing_at: r.first_firing_at.toISOString(),
      ended_at: r.ended_at?.toISOString() ?? null,
      disposition: run?.disposition ?? s?.disposition ?? null,
      conclusion_level: run?.conclusion_level ?? null,
      research_fresh_at: fresh?.toISOString() ?? null,
      pending_approvals: pc.get(r.incident_id) ?? 0,
      feedback: fb ?? null,
      merged_from_count: al.get(r.incident_id) ?? 0,
      split_from: r.split_from,
      suppressed: r.suppressed,
      observability_blind: r.observability_blind,
      updated_at: r.updated_at.toISOString(),
      component_names: ((name) => (name && r.root_component ? { [r.root_component]: name } : {}))(
        nm.get(`${r.cluster_id}\0${r.root_component ?? ''}`),
      ),
      research_root: roots.get(r.incident_id) ?? null,
      business_impact: impact.get(r.incident_id) ?? [],
      claim: claims.get(r.incident_id) ?? null,
    };
  });
}

/**
 * 每个事件仍在其中的成员告警里属于业务影响告警（ADR 0166）的告警名，去重排序。告警已经不在告警状态表时按不上标签，不计
 */
async function businessImpactOf(
  pool: pg.Pool,
  rows: readonly IncidentRow[],
  matchers: readonly AlertMatcher[],
): Promise<Map<string, string[]>> {
  if (!matchers.length) {
    return new Map();
  }
  const current = rows.flatMap((r) =>
    r.body.members.filter((m) => m.left_version === null).map((m) => ({ id: r.incident_id, alertId: m.alert_id })),
  );
  const impacting = new Set(
    (await alertsById(pool, [...new Set(current.map((c) => c.alertId))]))
      .filter((a) => isBusinessImpact(a.labels, matchers))
      .map((a) => a.alert_id),
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const m of r.body.members) {
      if (m.left_version === null && impacting.has(m.alert_id)) {
        out.set(r.incident_id, (out.get(r.incident_id) ?? new Set()).add(m.alertname));
      }
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * 事件的问题陈述（ADR 0190），收件箱与事件详情共用：头条告警、它的注解（告警已不在告警状态表时没有注解）与最近一次完成的
 * 研判的一句话结论（research 以 incident_id 为键）
 */
export async function incidentHeadlines(
  pool: pg.Pool,
  rows: ReadonlyArray<Pick<IncidentRow, 'incident_id' | 'cluster_id' | 'body'>>,
  research: ReadonlyMap<string, string | null>,
): Promise<Map<string, IncidentHeadline | null>> {
  const heads = new Map(rows.map((r) => [r.incident_id, headlineMember(r.body)]));
  const headAlerts = await alertsById(
    pool,
    [...heads.values()].flatMap((m) => (m ? [m.alert_id] : [])),
  );
  const ha = new Map(headAlerts.map((a) => [`${a.cluster_id}\0${a.alert_id}`, a]));
  return new Map(
    rows.map((r) => {
      const head = heads.get(r.incident_id) ?? null;
      const a = head ? ha.get(`${r.cluster_id}\0${head.alert_id}`) : undefined;
      return [
        r.incident_id,
        head
          ? {
              alert_id: head.alert_id,
              alertname: head.alertname,
              summary: a ? alertStatement(a) : null,
              started_at: head.starts_at,
              research_summary: research.get(r.incident_id) || null,
            }
          : null,
      ];
    }),
  );
}

/** 事件收件箱与事件详情（contract/openapi.yaml 的 incidents、evidence、feedback 标签）。 */
export function registerIncidentRoutes(app: FastifyInstance, d: IncidentRouteDeps): void {
  const fbBody = validatorFor<FeedbackCreate>('schemas/feedback.schema.json#/$defs/FeedbackCreate');

  const load = async (scopes: RoleBinding[] | 'all', ref: string): Promise<IncidentRow> => {
    const row = await resolveIncidentRef(d.pool, decodeURIComponent(ref));
    if (!row || !visible(scopes, incidentTarget(row.body))) {
      throw notFound('没有这个事件');
    }
    return row;
  };

  // 业务领域与服务，每个服务带读取作用域内正在触发、没有被抑制的事件数（按主服务计，ADR 0193）。正在触发的事件
  // 数量有限，按与收件箱相同的可见性在内存里过滤
  app.get('/v1/business-domains', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const q = req.query as Record<string, string | undefined>;
    const rows = await d.pool.query<{ primary_service: string | null; body: Incident }>(
      `SELECT primary_service, body FROM server.incidents
        WHERE state = 'firing' AND NOT suppressed AND ($1::text IS NULL OR cluster_id = $1)`,
      [q.cluster_id ?? null],
    );
    const firing = new Map<string, number>();
    let unassigned = 0;
    for (const r of rows.rows) {
      if (!visible(scopes, incidentTarget(r.body))) {
        continue;
      }
      const s = r.primary_service ?? r.body.primary_service ?? null;
      if (s === null) {
        unassigned++;
      } else {
        firing.set(s, (firing.get(s) ?? 0) + 1);
      }
    }
    const domains = new Map<string, BusinessDomainStatus>();
    for (const s of d.services().services()) {
      const dom = domains.get(s.business_domain) ?? {
        id: s.business_domain,
        title: s.business_domain_title,
        tier: s.tier,
        services: [],
      };
      dom.services.push({ id: s.id, title: s.title, firing: firing.get(s.id) ?? 0 });
      domains.set(s.business_domain, dom);
    }
    return { items: [...domains.values()], unassigned_firing: unassigned };
  });

  app.get('/v1/incidents', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const q = req.query as Record<string, string | undefined>;
    const state = q.state ?? 'firing';
    if (!['firing', 'resolved', 'all'].includes(state)) {
      throw badRequest('state 只能是 firing、resolved 或 all');
    }
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100)));
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    // 条件里用 :p 表示本条件的参数（可以出现多次）
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll(':p', `$${params.length}`));
    };
    if (state === 'all') {
      where.push("state <> 'merged'");
    } else {
      add('state = :p', state);
    }
    const filters = incidentConditions({
      ...parseClassificationFilters(req.query as Record<string, unknown>),
      clusterId: q.cluster_id ?? null,
      severity: q.severity ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      component: q.component ?? null,
    });
    for (const c of filters) {
      add(c.sql, c.value);
    }
    if (q.q)
      add(
        "(label ILIKE '%' || :p || '%' OR root_component ILIKE '%' || :p || '%' OR body::text ILIKE '%' || :p || '%')",
        q.q,
      );
    const suppressedWanted = q.suppressed === 'true';
    const r = await d.pool.query<IncidentRow>(
      `SELECT * FROM server.incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY first_firing_at DESC, incident_id DESC LIMIT ${LIST_SCAN_LIMIT}`,
      params,
    );
    let matched = r.rows.filter((x) => visible(scopes, incidentTarget(x.body)));
    const suppressedCount = matched.filter((x) => x.suppressed).length;
    if (!suppressedWanted) {
      matched = matched.filter((x) => !x.suppressed);
    }
    const afterCursor = <T extends { first_firing_at: string | Date; incident_id: string }>(xs: T[]): T[] =>
      cursor
        ? xs.filter((x) => {
            const t = typeof x.first_firing_at === 'string' ? x.first_firing_at : x.first_firing_at.toISOString();
            return t < cursor.t || (t === cursor.t && x.incident_id < cursor.id);
          })
        : xs;
    const rows = afterCursor(matched);
    // 处置与反馈是摘要里求出的字段：按它们筛选时要先求全部摘要；不按它们筛选时只求这一页的摘要
    const bySummary = Boolean(q.disposition) || q.feedback === 'pending' || q.feedback === 'given';
    let total: number;
    let page: Summary[];
    let more: boolean;
    if (bySummary) {
      let items = await summaries(d, matched);
      if (q.disposition) {
        items = items.filter((x) => x.disposition === q.disposition);
      }
      if (q.feedback === 'pending') {
        items = items.filter((x) => x.feedback === null || x.feedback.stale);
      } else if (q.feedback === 'given') {
        items = items.filter((x) => x.feedback !== null && !x.feedback.stale);
      }
      total = items.length;
      const rest = afterCursor(items);
      page = rest.slice(0, limit);
      more = rest.length > limit;
    } else {
      total = matched.length;
      page = await summaries(d, rows.slice(0, limit));
      more = rows.length > limit;
    }
    const last = page[page.length - 1];
    const spans = await d.pool.query<{
      cluster_id: string;
      type: string;
      started_at: Date;
      ended_at: Date | null;
      reason: string;
      subject: string;
    }>(
      `SELECT cluster_id, type, started_at, ended_at, reason, subject FROM server.condition_spans
        WHERE type IN ('IngestSilent', 'StateStoreDegraded') AND ($1::text IS NULL OR cluster_id = $1)
          AND coalesce(ended_at, now()) >= coalesce($2::timestamptz, now() - interval '7 days') AND started_at <= coalesce($3::timestamptz, now())
        ORDER BY started_at`,
      [q.cluster_id ?? null, q.from ?? null, q.to ?? null],
    );
    const blind = rows.filter((x) => x.observability_blind);
    return {
      items: page,
      suppressed_count: suppressedWanted ? 0 : suppressedCount,
      blind_spans: [
        ...spans.rows.map((s) => ({
          cluster_id: s.cluster_id,
          kind: s.type === 'IngestSilent' ? ('ingest_silent' as const) : ('state_store_degraded' as const),
          from: s.started_at.toISOString(),
          to: s.ended_at?.toISOString() ?? null,
          reason: s.subject ? `${s.reason}: ${s.subject}` : s.reason,
        })),
        ...blind.map((x) => ({
          cluster_id: x.cluster_id,
          kind: 'observability_blind' as const,
          from: x.first_firing_at.toISOString(),
          to: x.ended_at?.toISOString() ?? null,
          reason: x.label,
        })),
      ],
      next_cursor: more && last ? encodeCursor({ t: last.first_firing_at, id: last.incident_id }) : null,
      total,
      total_truncated: r.rows.length >= LIST_SCAN_LIMIT,
    };
  });

  app.get('/v1/incidents/:ref', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const v = (req.query as { version?: string }).version;
    if (v !== undefined) {
      const body = await incidentVersion(d.pool, row.incident_id, Number(v));
      if (!body) {
        throw notFound(`事件没有版本 ${v}`);
      }
      return withComponentNames(d.pool, body);
    }
    // 最新版本附上研判根因与是否不一致（ADR 0104 §14）与问题陈述（ADR 0190）；历史版本不附
    const rr = (await researchRoots(d.pool, (c, k, at) => d.topology.ownerOf(c, k, at), [row])).get(row.incident_id);
    const run = await d.pool.query<{ summary: string | null }>(
      `SELECT summary FROM server.research_runs WHERE incident_id = $1 AND state = 'completed'
        ORDER BY started_at DESC LIMIT 1`,
      [row.incident_id],
    );
    const headline =
      (await incidentHeadlines(d.pool, [row], new Map([[row.incident_id, run.rows[0]?.summary ?? null]]))).get(
        row.incident_id,
      ) ?? null;
    const named = await withComponentNames(d.pool, row.body);
    const claim = (await currentClaims(d.pool, [row.incident_id])).get(row.incident_id) ?? null;
    return { ...named, headline, claim, ...(rr ? { research_root: rr } : {}) };
  });

  app.get('/v1/incidents/:ref/stage-a', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const r = await latestStageA(d.pool, row.incident_id);
    if (!r) {
      throw notFound('事件还没有阶段 A 报告');
    }
    return r;
  });

  app.get('/v1/incidents/:ref/evidence', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const runId = (req.query as { run_id?: string }).run_id;
    if (!runId) {
      const r = await latestStageA(d.pool, row.incident_id);
      if (!r) {
        throw notFound('事件还没有阶段 A 报告');
      }
      return sortCards(r.cards);
    }
    if (!d.worker) {
      throw notFound('研判明细不可用（没有配置 worker）');
    }
    const res = await fetch(`${d.worker.url}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${d.worker.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      throw notFound(`没有研判 ${runId}`);
    }
    const run = (await res.json()) as { incident_id: string; evidence: EvidenceResult[] };
    if (run.incident_id !== row.incident_id) {
      throw notFound(`研判 ${runId} 不属于这个事件`);
    }
    return sortCards(run.evidence);
  });

  app.post('/v1/incidents/:ref/evidence/rerun', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    await d.auth.user(req, 'evidence.rerun', incidentTarget(row.body));
    const body = (req.body ?? {}) as { run_id?: string | null; refs?: string[]; window_to?: string };
    if (!Array.isArray(body.refs) || !body.refs.length || body.refs.length > 50 || !body.window_to) {
      throw badRequest('需要 refs（1–50 个）与 window_to');
    }
    const windowTo = new Date(body.window_to);
    if (Number.isNaN(windowTo.getTime()) || windowTo.getTime() > Date.now()) {
      throw badRequest('window_to 不得晚于当前时间');
    }
    let declared: EvidenceResult[];
    if (body.run_id) {
      if (!d.worker) {
        throw notFound('研判明细不可用（没有配置 worker）');
      }
      const res = await fetch(`${d.worker.url}/v1/runs/${encodeURIComponent(body.run_id)}`, {
        headers: { authorization: `Bearer ${d.worker.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      declared = ((await res.json()) as { evidence: EvidenceResult[] }).evidence;
    } else {
      declared = (await latestStageA(d.pool, row.incident_id))?.cards ?? [];
    }
    const wanted = declared.filter((x) => body.refs?.includes(x.ref));
    if (wanted.length !== body.refs.length) {
      throw badRequest('refs 中有本次研判没有声明过的卡');
    }
    return d.evidence.rerun(row.body, wanted, windowTo, AbortSignal.timeout(30_000));
  });

  app.get('/v1/incidents/:ref/timeline', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    return timelineOf(d.pool, row);
  });

  app.get('/v1/incidents/:ref/subgraph', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const q = req.query as { hops?: string; version?: string };
    const inc = q.version ? await incidentVersion(d.pool, row.incident_id, Number(q.version)) : row.body;
    if (!inc) {
      throw notFound('没有这个版本');
    }
    const hops = Math.min(2, Math.max(1, Number(q.hops ?? 2)));
    return subgraphOf(d.topology, inc, hops);
  });

  app.get('/v1/incidents/:ref/feedback', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    return d.feedback.list(row.incident_id);
  });

  // 认领与放下（ADR 0195）：有 claim 权限的人都可以认领（已有处理人时接手）或放下，每次都记录
  app.post('/v1/incidents/:ref/claim', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const c = await d.auth.user(req, 'claim', incidentTarget(row.body));
    return claimIncident(d.pool, row.incident_id, c.subject.id, c.channel);
  });

  app.delete('/v1/incidents/:ref/claim', async (req, reply) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const c = await d.auth.user(req, 'claim', incidentTarget(row.body));
    await releaseIncident(d.pool, row.incident_id, c.subject.id, c.channel);
    return reply.code(204).send();
  });

  app.post('/v1/incidents/:ref/feedback', async (req, reply) => {
    const { scopes } = await d.auth.reader(req);
    const row = await load(scopes, (req.params as { ref: string }).ref);
    const c = await d.auth.user(req, 'feedback', incidentTarget(row.body));
    if (!fbBody(req.body)) {
      throw badRequest(
        (fbBody.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；'),
      );
    }
    const fb = await d.feedback.create(
      { principalId: c.subject.id, channel: c.channel, linked: true },
      row.body,
      req.body,
    );
    return reply.code(201).send(fb);
  });
}

type TimelineEntry = HubComponents['schemas']['TimelineEntry'];
type BusinessDomainStatus = HubComponents['schemas']['BusinessDomainStatus'];
type IncidentHeadline = HubComponents['schemas']['IncidentHeadline'];
type TimelineKind = TimelineEntry['kind'];

/** 带原因码的条目种类 → 原因码所属的阶段（ADR 0172；反馈的原因码见 ADR 0174） */
const KIND_STAGE: Partial<Record<TimelineKind, ReasonStage>> = {
  stage_a_missing: 'stage_a',
  research_concluded: 'research',
  research_ended: 'research',
  remediation_attempt: 'remediation',
  notify: 'notify',
  issue: 'issue',
  incident_state: 'incident',
  feedback: 'feedback',
};

/** server.incident_reasons 的阶段 → 时间线条目种类（反馈的原因码在 server.feedback，不写入 incident_reasons） */
const RECORD_KIND: Record<IncidentReasonStage, TimelineKind> = {
  notify: 'notify',
  stage_a: 'stage_a_missing',
  research: 'research_ended',
  remediation: 'remediation_attempt',
  issue: 'issue',
  incident: 'incident_state',
  feedback: 'feedback',
};

/** 一条时间线条目；code 不为空时按条目种类的阶段在登记表中查出级别，未登记的原因码抛出 */
function entry(
  at: string,
  kind: TimelineKind,
  text: string,
  ref: string | null,
  untrusted: boolean,
  code: string | null = null,
  changeLink?: ChangeLink,
): TimelineEntry {
  const stage = KIND_STAGE[kind];
  if (code !== null && stage === undefined) {
    throw new Error(`时间线条目 ${kind} 没有原因码阶段，不能带原因码 ${code}`);
  }
  return {
    at,
    kind,
    text,
    ref,
    untrusted,
    code,
    level: code === null ? null : reasonEntry(stage!, code).level,
    ...(changeLink ? { change_link: changeLink } : {}),
  };
}

const zh = (stage: ReasonStage, code: string) => reasonText(stage, code, 'zh-CN');

/**
 * 时间线（一条泳道）：告警、变更、异常卡、合并与拆分、阶段 A、研判、自愈 PR、提议、执行、反馈，以及带原因码的终态
 * （ADR 0172）：阶段 A 失败与缺失、研判没有结论（失败、只出阶段 A、入队跳过、被取代、不进入阶段 B）、通知的送达、
 * 最后一次编辑、放弃与不推送、事件 issue、事件的恢复、重开、抑制与写入失败。
 */
export async function timelineOf(pool: pg.Pool, row: IncidentRow): Promise<TimelineEntry[]> {
  const out: TimelineEntry[] = [];
  const inc = row.body;
  const alerts = await alertsById(
    pool,
    inc.members.map((m) => m.alert_id),
  );
  for (const a of alerts) {
    out.push(
      entry(
        a.starts_at,
        'alert_firing',
        `${a.alertname}${a.annotations.summary ? `：${a.annotations.summary}` : ''}`,
        a.alert_id,
        true,
      ),
    );
    if (a.ends_at) {
      out.push(entry(a.ends_at, 'alert_resolved', a.alertname, a.alert_id, true));
    }
  }
  // 变更带上与事件关联的分级与依据（ADR 0169）；契约 2.37.0 之前算出的事件没有
  const links = new Map((inc.change_links ?? []).map((l) => [l.change_id, l]));
  for (const c of inc.changes) {
    out.push(
      entry(c.time, 'change', `${c.source} ${c.kind}：${c.summary}`, c.change_id, true, null, links.get(c.change_id)),
    );
  }
  for (const a of inc.aliases) {
    out.push(entry(a.merged_at, 'incident_merged', `并入 ${a.from_label}`, a.from_incident_id, false));
  }
  if (inc.split_from) {
    out.push(entry(inc.created_at, 'incident_split', '由另一个事件拆分而来', inc.split_from, false));
  }
  const reports = await pool.query<{ body: StageAReport }>(
    'SELECT body FROM server.stage_a_reports WHERE incident_id = $1 ORDER BY incident_version',
    [row.incident_id],
  );
  for (const { body: r } of reports.rows) {
    out.push(
      entry(r.rendered_at, 'stage_a', `阶段 A（版本 ${r.incident_version}）：${r.disposition}`, r.report_id, false),
    );
    for (const c of r.cards.filter((x) => x.verdict === 'abnormal')) {
      out.push(
        entry(
          c.anomaly_started_at ?? c.evaluated_at,
          'card_abnormal',
          `${c.card_id}${c.value ? `：${c.value}` : ''}`,
          c.ref,
          false,
        ),
      );
    }
  }
  // 研判的结局：给出结论的带停止原因；失败与只出阶段 A 的带失败类型（含 server 判定的租约过期）
  const runs = await pool.query<{
    run_id: string;
    state: 'completed' | 'failed' | 'stage_a_only';
    started_at: Date;
    finished_at: Date | null;
    conclusion_level: string | null;
    root_component: string | null;
    stop_reason: string | null;
    error: { kind?: string; message?: string } | null;
  }>(
    `SELECT run_id, state, started_at, finished_at, conclusion_level, root_component, output->>'stop_reason' AS stop_reason, error
       FROM server.research_runs WHERE incident_id = $1 AND state IN ('completed', 'failed', 'stage_a_only')`,
    [row.incident_id],
  );
  for (const r of runs.rows) {
    const at = (r.finished_at ?? r.started_at).toISOString();
    if (r.state === 'completed') {
      out.push(
        entry(
          at,
          'research_concluded',
          `研判结论：${r.conclusion_level ?? '-'} · ${r.root_component ?? '-'}${r.stop_reason ? `（停止原因：${zh('research', r.stop_reason)}）` : ''}`,
          r.run_id,
          false,
          r.stop_reason,
        ),
      );
      continue;
    }
    const kind = r.error?.kind;
    if (!kind) {
      throw new Error(`研判 ${r.run_id} 的状态为 ${r.state}，镜像里没有失败类型`);
    }
    const message = r.error?.message ? r.error.message.slice(0, 300) : '';
    out.push(
      entry(
        at,
        'research_ended',
        `${r.state === 'failed' ? '研判失败' : '只出阶段 A'}：${zh('research', kind)}${message ? `（${message}）` : ''}`,
        r.run_id,
        // 失败说明里可能有模型输出与数据源错误的原文
        message !== '',
        kind,
      ),
    );
  }
  // 入队时跳过（只出阶段 A）与被同一事件更新的触发取代
  const queued = await pool.query<{
    run_id: string;
    state: 'skipped' | 'superseded';
    skip_reason: string | null;
    enqueued_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT run_id, state, skip_reason, enqueued_at, finished_at FROM server.research_queue
      WHERE incident_id = $1 AND subject_type = 'incident' AND state IN ('skipped', 'superseded')`,
    [row.incident_id],
  );
  for (const q of queued.rows) {
    const at = (q.finished_at ?? q.enqueued_at).toISOString();
    if (q.state === 'superseded') {
      out.push(entry(at, 'research_ended', zh('research', 'superseded'), q.run_id, false, 'superseded'));
      continue;
    }
    if (!q.skip_reason) {
      throw new Error(`研判队列 ${q.run_id} 为 skipped，没有跳过原因`);
    }
    out.push(
      entry(
        at,
        'research_ended',
        `入队时跳过，只出阶段 A：${zh('research', q.skip_reason)}`,
        q.run_id,
        false,
        q.skip_reason,
      ),
    );
  }
  // 自愈 PR 对每次研判的处理结果（ADR 0170）：模板、结果与原因；key 为 '-' 时整次研判没有可处理的模板
  const attempts = await pool.query<{
    run_id: string;
    key: string;
    outcome: string;
    code: string | null;
    reason: string | null;
    created_at: Date;
  }>('SELECT run_id, key, outcome, code, reason, created_at FROM server.remediation_attempts WHERE incident_id = $1', [
    row.incident_id,
  ]);
  for (const a of attempts.rows) {
    out.push(
      entry(
        a.created_at.toISOString(),
        'remediation_attempt',
        `自愈 PR${a.key === '-' ? '' : ` ${a.key}`}：${a.outcome}${a.reason ? `：${a.reason}` : ''}`,
        a.run_id,
        // 原因里有告警名、标签值与仓库内容等外部来源的原文
        true,
        a.code,
      ),
    );
  }
  // 终态记录：阶段 A、通知、不进入阶段 B、事件 issue、事件状态（ADR 0172、0173）
  for (const r of await reasonsOf(pool, row.incident_id)) {
    const where = r.stage === 'notify' && r.ref ? `（${r.ref}）` : '';
    out.push(
      entry(
        r.at.toISOString(),
        RECORD_KIND[r.stage],
        `${zh(r.stage, r.code)}${where}${r.detail ? `：${r.detail}` : ''}`,
        r.ref,
        // 说明里可能有错误信息与渠道应答的原文
        r.detail !== null,
        r.code,
      ),
    );
  }
  const props = await pool.query<{ body: Proposal }>('SELECT body FROM server.proposals WHERE incident_id = $1', [
    row.incident_id,
  ]);
  for (const { body: p } of props.rows) {
    out.push(entry(p.created_at, 'proposal', `${p.action} → ${p.target.display}（${p.state}）`, p.proposal_id, false));
  }
  const execs = await pool.query<{ proposal_id: string; phase: string; at: Date; reason: string }>(
    'SELECT e.proposal_id, e.phase, e.at, e.reason FROM server.execution_events e JOIN server.proposals p USING (proposal_id) WHERE p.incident_id = $1',
    [row.incident_id],
  );
  for (const e of execs.rows) {
    out.push(entry(e.at.toISOString(), 'execution', `${e.phase}（${e.reason}）`, e.proposal_id, false));
  }
  const fbs = await pool.query<{
    feedback_id: string;
    created_at: Date;
    verdict: string | null;
    disposition_verdict: string | null;
    implicit: string | null;
    reason_code: string | null;
    principal_id: string;
  }>(
    'SELECT feedback_id, created_at, verdict, disposition_verdict, implicit, reason_code, principal_id FROM server.feedback WHERE incident_id = $1',
    [row.incident_id],
  );
  for (const f of fbs.rows) {
    // 原因码（ADR 0174）放在 code，说明跟在评价之后
    const why = f.reason_code === null ? null : `原因：${zh('feedback', f.reason_code)}`;
    out.push(
      entry(
        f.created_at.toISOString(),
        'feedback',
        `${f.principal_id}：${[f.verdict ?? f.disposition_verdict ?? f.implicit, why].filter(Boolean).join('，')}`,
        f.feedback_id,
        false,
        f.reason_code,
      ),
    );
  }
  // 认领与放下（ADR 0195）
  for (const e of await claimEvents(pool, row.incident_id)) {
    out.push(
      entry(
        e.at.toISOString(),
        'claim',
        e.action === 'claim' ? `${e.principal_id} 认领（${e.channel}）` : `${e.principal_id} 放下（${e.channel}）`,
        e.principal_id,
        false,
        null,
      ),
    );
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * 根因子图：根因（没有时取候选与组件）加不超过 hops 跳的邻居，取该事件版本使用的拓扑版本。
 * 只按跳取相连的边，不取整张拓扑（通知与事件 issue 每一轮为每个事件调用一次，ADR 0144）。
 */
export async function subgraphOf(topology: TopologyStore, inc: Incident, hops: number) {
  const seeds = inc.root.component
    ? [inc.root.component]
    : inc.candidates.length
      ? inc.candidates.map((c) => c.component)
      : inc.components;
  const all = await topology.subgraph(
    inc.cluster_id,
    seeds,
    new Date(inc.updated_at),
    inc.topology_version || null,
    hops,
  );
  const dist = all.hops;
  const memberComponents = new Map<string, string[]>();
  for (const m of inc.members.filter((x) => x.left_version === null)) {
    if (m.component) {
      memberComponents.set(m.component, [...(memberComponents.get(m.component) ?? []), m.alert_id]);
    }
  }
  const candidates = new Set(inc.candidates.map((c) => c.component));
  const byKey = new Map<string, (typeof all.nodes)[number]>();
  for (const n of all.nodes) {
    if (!byKey.has(n.key)) {
      byKey.set(n.key, n);
    }
  }
  const nodes = [...dist.entries()].map(([key, h]) => {
    const n = byKey.get(key);
    const k = parseStoredKey(key);
    return {
      component: key,
      kind: n?.kind ?? k.kind,
      namespace: n?.namespace ?? k.namespace,
      name: n?.name ?? k.name,
      role:
        key === inc.root.component
          ? ('root' as const)
          : candidates.has(key)
            ? ('candidate' as const)
            : memberComponents.has(key)
              ? ('member' as const)
              : ('neighbor' as const),
      alerts: memberComponents.get(key) ?? [],
      hops: h,
    };
  });
  const edges = all.edges.map((e) => ({
    from: e.from,
    to: e.to,
    relation: e.relation,
    provenance: e.provenance,
    confidence: e.confidence,
    scope: e.scope,
  }));
  return { topology_version: all.version, root: inc.root.component, nodes, edges };
}
