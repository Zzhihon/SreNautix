import type { EvidenceResult, Feedback, FeedbackCreate, Incident, Proposal, StageAReport } from '@srenautix/contract';
import { validatorFor } from '@srenautix/contract';
import { NAMESPACE_KIND } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { badRequest, notFound } from '../api/errors.js';
import type { Auth } from '../identity/auth.js';
import { scopeMatches, type RoleBinding, type Target } from '../identity/bindings.js';
import { withComponentNames } from '../incident/names.js';
import { incidentVersion, latestStageA, resolveIncidentRef, type IncidentRow } from '../incident/read.js';
import { researchRoots } from '../incident/research-root.js';
import { alertsById } from '../ingest/store.js';
import type { FeedbackService } from '../proposals/feedback.js';
import type { EvidenceRunner } from '../stage-a/ports.js';
import type { TopologyStore } from '../topology/store.js';
import { parseStoredKey } from '../topology/keys.js';

/** 事件的授权对象：根因组件（没有时取第一个组件）所在的命名空间。 */
export function incidentTarget(inc: Pick<Incident, 'cluster_id' | 'root' | 'components'>): Target {
  const key = inc.root.component ?? inc.components[0] ?? null;
  if (!key) {
    return { cluster: inc.cluster_id, namespace: null, labels: {} };
  }
  const k = parseStoredKey(key);
  return { cluster: inc.cluster_id, namespace: k.kind === NAMESPACE_KIND ? k.name : k.namespace, labels: {} };
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
}

interface Cursor {
  t: string;
  id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
  if (typeof c.t !== 'string' || typeof c.id !== 'string') {
    throw badRequest('cursor 不合法');
  }
  return c;
}

async function summaries(pool: pg.Pool, feedback: FeedbackService, topology: TopologyStore, rows: IncidentRow[]) {
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
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT DISTINCT ON (incident_id) incident_id, state, disposition, conclusion_level, started_at, finished_at FROM server.research_runs
      WHERE incident_id = ANY($1::uuid[]) AND state = 'completed' ORDER BY incident_id, started_at DESC`,
    [ids],
  );
  const pending = await pool.query<{ incident_id: string; n: number }>(
    "SELECT incident_id, count(*)::int AS n FROM server.proposals WHERE incident_id = ANY($1::uuid[]) AND state = 'awaiting_approval' GROUP BY incident_id",
    [ids],
  );
  const aliases = await pool.query<{ into_incident_id: string; n: number }>(
    'SELECT into_incident_id, count(*)::int AS n FROM server.incident_aliases WHERE into_incident_id = ANY($1::uuid[]) GROUP BY into_incident_id',
    [ids],
  );
  const fbs = await feedback.latest(pool, ids);
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
      state: r.state,
      severity: r.body.severity,
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
    };
  });
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
    if (q.cluster_id) add('cluster_id = :p', q.cluster_id);
    if (q.severity) add('severity = :p', q.severity);
    if (q.from) add('coalesce(ended_at, now()) >= :p::timestamptz', q.from);
    if (q.to) add('first_firing_at <= :p::timestamptz', q.to);
    if (q.component) add("(root_component = :p OR jsonb_exists(body->'components', :p))", q.component);
    if (q.q)
      add(
        "(label ILIKE '%' || :p || '%' OR root_component ILIKE '%' || :p || '%' OR body::text ILIKE '%' || :p || '%')",
        q.q,
      );
    const suppressedWanted = q.suppressed === 'true';
    const r = await d.pool.query<IncidentRow>(
      `SELECT * FROM server.incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY first_firing_at DESC, incident_id DESC LIMIT 2000`,
      params,
    );
    let rows = r.rows.filter((x) => visible(scopes, incidentTarget(x.body)));
    const suppressedCount = rows.filter((x) => x.suppressed).length;
    if (!suppressedWanted) {
      rows = rows.filter((x) => !x.suppressed);
    }
    if (cursor) {
      rows = rows.filter(
        (x) =>
          x.first_firing_at.toISOString() < cursor.t ||
          (x.first_firing_at.toISOString() === cursor.t && x.incident_id < cursor.id),
      );
    }
    let items = await summaries(d.pool, d.feedback, d.topology, rows);
    if (q.disposition) {
      items = items.filter((x) => x.disposition === q.disposition);
    }
    if (q.feedback === 'pending') {
      items = items.filter((x) => x.feedback === null || x.feedback.stale);
    } else if (q.feedback === 'given') {
      items = items.filter((x) => x.feedback !== null && !x.feedback.stale);
    }
    const page = items.slice(0, limit);
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
      next_cursor:
        items.length > limit && last ? encodeCursor({ t: last.first_firing_at, id: last.incident_id }) : null,
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
    // 最新版本附上研判根因与是否不一致（ADR 0104 §14）；历史版本不附
    const rr = (await researchRoots(d.pool, (c, k, at) => d.topology.ownerOf(c, k, at), [row])).get(row.incident_id);
    const named = await withComponentNames(d.pool, row.body);
    return rr ? { ...named, research_root: rr } : named;
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

/** 时间线（一条泳道）：告警、变更、异常卡、合并与拆分、阶段 A、研判、提议、执行、反馈。 */
export async function timelineOf(pool: pg.Pool, row: IncidentRow) {
  const out: Array<{ at: string; kind: string; text: string; ref: string | null; untrusted: boolean }> = [];
  const inc = row.body;
  const alerts = await alertsById(
    pool,
    inc.members.map((m) => m.alert_id),
  );
  for (const a of alerts) {
    out.push({
      at: a.starts_at,
      kind: 'alert_firing',
      text: `${a.alertname}${a.annotations.summary ? `：${a.annotations.summary}` : ''}`,
      ref: a.alert_id,
      untrusted: true,
    });
    if (a.ends_at) {
      out.push({ at: a.ends_at, kind: 'alert_resolved', text: a.alertname, ref: a.alert_id, untrusted: true });
    }
  }
  for (const c of inc.changes) {
    out.push({
      at: c.time,
      kind: 'change',
      text: `${c.source} ${c.kind}：${c.summary}`,
      ref: c.change_id,
      untrusted: true,
    });
  }
  for (const a of inc.aliases) {
    out.push({
      at: a.merged_at,
      kind: 'incident_merged',
      text: `并入 ${a.from_label}`,
      ref: a.from_incident_id,
      untrusted: false,
    });
  }
  if (inc.split_from) {
    out.push({
      at: inc.created_at,
      kind: 'incident_split',
      text: '由另一个事件拆分而来',
      ref: inc.split_from,
      untrusted: false,
    });
  }
  const reports = await pool.query<{ body: StageAReport }>(
    'SELECT body FROM server.stage_a_reports WHERE incident_id = $1 ORDER BY incident_version',
    [row.incident_id],
  );
  for (const { body: r } of reports.rows) {
    out.push({
      at: r.rendered_at,
      kind: 'stage_a',
      text: `阶段 A（版本 ${r.incident_version}）：${r.disposition}`,
      ref: r.report_id,
      untrusted: false,
    });
    for (const c of r.cards.filter((x) => x.verdict === 'abnormal')) {
      out.push({
        at: c.anomaly_started_at ?? c.evaluated_at,
        kind: 'card_abnormal',
        text: `${c.card_id}${c.value ? `：${c.value}` : ''}`,
        ref: c.ref,
        untrusted: false,
      });
    }
  }
  const runs = await pool.query<{
    run_id: string;
    finished_at: Date | null;
    conclusion_level: string | null;
    root_component: string | null;
  }>(
    "SELECT run_id, finished_at, conclusion_level, root_component FROM server.research_runs WHERE incident_id = $1 AND state = 'completed'",
    [row.incident_id],
  );
  for (const r of runs.rows) {
    out.push({
      at: (r.finished_at ?? new Date()).toISOString(),
      kind: 'research_concluded',
      text: `研判结论：${r.conclusion_level ?? '-'} · ${r.root_component ?? '-'}`,
      ref: r.run_id,
      untrusted: false,
    });
  }
  const props = await pool.query<{ body: Proposal }>('SELECT body FROM server.proposals WHERE incident_id = $1', [
    row.incident_id,
  ]);
  for (const { body: p } of props.rows) {
    out.push({
      at: p.created_at,
      kind: 'proposal',
      text: `${p.action} → ${p.target.display}（${p.state}）`,
      ref: p.proposal_id,
      untrusted: false,
    });
  }
  const execs = await pool.query<{ proposal_id: string; phase: string; at: Date; reason: string }>(
    'SELECT e.proposal_id, e.phase, e.at, e.reason FROM server.execution_events e JOIN server.proposals p USING (proposal_id) WHERE p.incident_id = $1',
    [row.incident_id],
  );
  for (const e of execs.rows) {
    out.push({
      at: e.at.toISOString(),
      kind: 'execution',
      text: `${e.phase}（${e.reason}）`,
      ref: e.proposal_id,
      untrusted: false,
    });
  }
  const fbs = await pool.query<{
    feedback_id: string;
    created_at: Date;
    verdict: string | null;
    disposition_verdict: string | null;
    implicit: string | null;
    principal_id: string;
  }>(
    'SELECT feedback_id, created_at, verdict, disposition_verdict, implicit, principal_id FROM server.feedback WHERE incident_id = $1',
    [row.incident_id],
  );
  for (const f of fbs.rows) {
    out.push({
      at: f.created_at.toISOString(),
      kind: 'feedback',
      text: `${f.principal_id}：${f.verdict ?? f.disposition_verdict ?? f.implicit ?? ''}`,
      ref: f.feedback_id,
      untrusted: false,
    });
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
