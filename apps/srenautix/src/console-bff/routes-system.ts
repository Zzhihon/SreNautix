import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Condition, Proposal } from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { badRequest, HttpError, notFound } from '../api/errors.js';
import type { ServerConfig } from '../config/server.js';
import type { Auth } from '../identity/auth.js';
import { ROLE_PERMISSIONS, scopeMatches, tierCeiling } from '../identity/bindings.js';
import { parseDuration } from '../config/files.js';
import { checkBody, openapiValidator } from '../api/openapi-schemas.js';
import type { ServiceCaller } from '../identity/callers.js';
import type { Catalog } from '../proposals/catalog.js';
import type { Policies } from '../proposals/policy.js';
import type { ProposalService, TargetResolver } from '../proposals/service.js';
import { appendAudit, readAudit, verifyRecords, GENESIS_HASH } from '../store/audit.js';
import type { AuditExporter } from '../store/audit-export.js';
import { tx } from '../store/pool.js';
import type { TopologyStore } from '../topology/store.js';
import { subgraphOf } from './routes-incidents.js';

export interface SystemRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  config: ServerConfig;
  catalog: Catalog;
  policies: () => Policies;
  proposals: ProposalService;
  targets: TargetResolver;
  topology: TopologyStore;
  exporter: AuditExporter;
  worker: { url: string; token: string } | null;
}

const fmt = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** 控制台创建的 API token：外部调用方，只能提议（DESIGN §9.3），动作与命名空间不限，每小时 60 个提议。 */
export async function apiTokenCaller(pool: pg.Pool, token: string): Promise<ServiceCaller | null> {
  const sha = createHash('sha256').update(token).digest('hex');
  const r = await pool.query<{ id: string; name: string }>(
    `UPDATE server.api_tokens SET last_used_at = now()
      WHERE token_sha256 = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id, name`,
    [sha],
  );
  const row = r.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: `api-token:${row.id}`,
    kind: 'external',
    channel: 'api',
    actions: ['*'],
    namespaces: ['*'],
    proposals_per_hour: 60,
    token_sha256: sha,
  };
}

/** 控制台的系统与治理页面（contract/openapi.yaml 的 health、system、governance 部分）。 */
export function registerSystemRoutes(app: FastifyInstance, d: SystemRouteDeps): void {
  app.get('/v1/conditions', async (req) => {
    await d.auth.reader(req);
    const q = req.query as { cluster_id?: string };
    const r = await d.pool.query<{
      role: Condition['role'];
      cluster_id: string;
      type: Condition['type'];
      subject: string;
      status: 'true' | 'false';
      reason: string;
      message: string;
      since: Date;
    }>(
      "SELECT * FROM server.conditions WHERE ($1::text IS NULL OR cluster_id = $1 OR cluster_id = '') ORDER BY role, type, subject",
      [q.cluster_id ?? null],
    );
    return r.rows.map((c) => ({
      type: c.type,
      status: c.status,
      role: c.role,
      cluster_id: c.cluster_id || null,
      subject: c.subject || null,
      reason: c.reason,
      message: c.message,
      since: c.since.toISOString(),
    }));
  });

  const clusterOf = async (id: string) => {
    const gw = await d.pool.query<{
      version: string;
      propose_only: boolean;
      conditions: Array<{ type: string; status: string }>;
      received_at: Date;
      stale: boolean;
    }>("SELECT *, received_at < now() - interval '2 minutes' AS stale FROM server.spoke_status WHERE cluster_id = $1", [
      id,
    ]);
    const rd = await d.pool.query<{
      version: string;
      received_at: Date;
      stale: boolean;
      conditions: Array<{ type: string; status: string }>;
    }>(
      "SELECT version, received_at, received_at < now() - interval '2 minutes' AS stale, conditions FROM server.reader_status WHERE cluster_id = $1",
      [id],
    );
    const conds = await d.pool.query<{
      role: Condition['role'];
      type: Condition['type'];
      subject: string;
      status: 'true' | 'false';
      reason: string;
      message: string;
      since: Date;
    }>('SELECT * FROM server.conditions WHERE cluster_id = $1', [id]);
    const topo = await d.pool.query<{ last: Date | null }>(
      "SELECT max(valid_from) AS last FROM server.topology_events WHERE cluster_id = $1 AND source = 'informer'",
      [id],
    );
    const g = gw.rows[0];
    const r = rd.rows[0];
    const selfCheck = g?.conditions.find((c) => c.type === 'AdmissionSelfCheck');
    const frozen = g?.conditions.find((c) => c.type === 'Freeze')?.status === 'True';
    const singleCluster = id === d.config.cluster_id && d.config.topology.source === 'informer';
    return {
      cluster_id: id,
      display_name: id,
      reader: singleCluster
        ? { connected: true, version: null, last_seen_at: fmt(topo.rows[0]?.last), admission_selfcheck: null }
        : {
            connected: !!r && !r.stale,
            version: r?.version ?? null,
            last_seen_at: fmt(r?.received_at),
            admission_selfcheck: null,
          },
      gateway: g
        ? {
            connected: !g.stale,
            version: g.version,
            last_seen_at: g.received_at.toISOString(),
            admission_selfcheck: selfCheck
              ? selfCheck.status === 'True'
                ? 'passed'
                : selfCheck.status === 'False'
                  ? 'failed'
                  : 'unknown'
              : 'unknown',
          }
        : null,
      freeze: { frozen, observed_at: (g?.received_at ?? new Date()).toISOString() },
      // 多集群：reader 心跳报告 informer 新鲜（InformersFresh=True）时以心跳时间为准
      informer_synced_at: singleCluster
        ? fmt(topo.rows[0]?.last)
        : r?.conditions.some((c) => c.type === 'InformersFresh' && c.status === 'True')
          ? fmt(r.received_at)
          : null,
      proposal_only: !g || g.propose_only || g.stale || frozen || selfCheck?.status !== 'True',
      conditions: conds.rows.map((c) => ({
        type: c.type,
        status: c.status,
        role: c.role,
        cluster_id: id,
        subject: c.subject || null,
        reason: c.reason,
        message: c.message,
        since: c.since.toISOString(),
      })),
    };
  };

  const clusterIds = async (): Promise<string[]> => {
    const r = await d.pool.query<{ cluster_id: string }>(
      `SELECT cluster_id FROM server.spoke_status UNION SELECT DISTINCT cluster_id FROM server.incidents UNION SELECT $1`,
      [d.config.cluster_id],
    );
    return r.rows.map((x) => x.cluster_id).sort();
  };

  app.get('/v1/clusters', async (req) => {
    await d.auth.reader(req);
    return Promise.all((await clusterIds()).map(clusterOf));
  });

  app.get('/v1/clusters/:id', async (req) => {
    await d.auth.reader(req);
    const id = (req.params as { id: string }).id;
    if (!(await clusterIds()).includes(id)) {
      throw notFound(`没有集群 ${id}`);
    }
    return clusterOf(id);
  });

  app.get('/v1/search', async (req) => {
    await d.auth.reader(req);
    const q = (req.query as { q?: string; limit?: string }).q ?? '';
    if (!q.trim()) {
      throw badRequest('q 不能为空');
    }
    const limit = Math.min(50, Math.max(1, Number((req.query as { limit?: string }).limit ?? 20)));
    const inc = await d.pool.query<{ incident_id: string; label: string; cluster_id: string }>(
      "SELECT incident_id, label, cluster_id FROM server.incidents WHERE label ILIKE '%' || $1 || '%' OR root_component ILIKE '%' || $1 || '%' ORDER BY first_firing_at DESC LIMIT $2",
      [q, limit],
    );
    const comp = await d.pool.query<{ key: string; cluster_id: string }>(
      "SELECT DISTINCT key, cluster_id FROM server.topology_events WHERE item = 'node' AND valid_to IS NULL AND key ILIKE '%' || $1 || '%' LIMIT $2",
      [q, limit],
    );
    const prop = await d.pool.query<{ proposal_id: string; body: Proposal }>(
      "SELECT proposal_id, body FROM server.proposals WHERE action ILIKE '%' || $1 || '%' OR body->'target'->>'display' ILIKE '%' || $1 || '%' ORDER BY created_at DESC LIMIT $2",
      [q, limit],
    );
    return [
      ...inc.rows.map((x) => ({
        kind: 'incident' as const,
        id: x.incident_id,
        title: x.label,
        cluster_id: x.cluster_id,
      })),
      ...comp.rows.map((x) => ({ kind: 'component' as const, id: x.key, title: x.key, cluster_id: x.cluster_id })),
      ...prop.rows.map((x) => ({
        kind: 'proposal' as const,
        id: x.proposal_id,
        title: `${x.body.action} → ${x.body.target.display}`,
        cluster_id: x.body.cluster_id,
      })),
    ].slice(0, limit);
  });

  const pauseState = async () => {
    const r = await d.pool.query<{
      value: {
        paused: boolean;
        reason: string | null;
        by: string | null;
        since: string | null;
        expires_at: string | null;
      };
    }>("SELECT value FROM server.system_state WHERE key = 'soft_pause'");
    const v = r.rows[0]?.value ?? { paused: false, reason: null, by: null, since: null, expires_at: null };
    const expired = v.paused && v.expires_at !== null && new Date(v.expires_at).getTime() <= Date.now();
    const held = await d.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.approval_assertions a JOIN server.proposals p USING (proposal_id) WHERE a.pulled_at IS NULL AND p.state = 'approved'",
    );
    return {
      paused: v.paused && !expired,
      reason: v.reason,
      by: v.by,
      since: v.since,
      expires_at: v.expires_at,
      held_count: v.paused && !expired ? (held.rows[0]?.n ?? 0) : 0,
    };
  };

  app.get('/v1/pause', async (req) => {
    await d.auth.reader(req);
    return pauseState();
  });

  app.put('/v1/pause', async (req) => {
    const c = await d.auth.user(req, 'pause.write');
    const b = (req.body ?? {}) as { paused?: boolean; reason?: string | null; expires_at?: string | null };
    if (typeof b.paused !== 'boolean') {
      throw badRequest('paused 必须是布尔值');
    }
    await tx(d.pool, async (cl) => {
      await cl.query(
        `INSERT INTO server.system_state (key, value, updated_at) VALUES ('soft_pause', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [
          JSON.stringify({
            paused: b.paused,
            reason: b.reason ?? null,
            by: c.subject.id,
            since: new Date().toISOString(),
            expires_at: b.expires_at ?? null,
          }),
        ],
      );
      await appendAudit(cl, 'pause.set', c.subject.id, {
        paused: b.paused,
        reason: b.reason ?? null,
        expires_at: b.expires_at ?? null,
      });
    });
    return pauseState();
  });

  app.get('/v1/freeze', async (req) => {
    await d.auth.reader(req);
    const id = (req.query as { cluster_id?: string }).cluster_id ?? d.config.cluster_id;
    const g = await d.pool.query<{ conditions: Array<{ type: string; status: string }>; received_at: Date }>(
      'SELECT conditions, received_at FROM server.spoke_status WHERE cluster_id = $1',
      [id],
    );
    const row = g.rows[0];
    return {
      cluster_id: id,
      frozen: row?.conditions.find((c) => c.type === 'Freeze')?.status === 'True',
      configmap: 'srenautix-freeze',
      observed_at: (row?.received_at ?? new Date()).toISOString(),
      instructions: {
        kubectl:
          'kubectl -n <srenautix 命名空间> patch configmap srenautix-freeze --type merge -p \'{"data":{"frozen":"true"}}\'',
        gitops_path: 'deploy/helm/srenautix 的 values 中 freeze.frozen',
      },
    };
  });

  app.get('/v1/policies', async (req) => {
    await d.auth.reader(req);
    const id = (req.query as { cluster_id?: string }).cluster_id ?? d.config.cluster_id;
    const p = d.policies().get(id);
    if (!p) {
      throw notFound(`集群 ${id} 没有 gateway 策略`);
    }
    return {
      repo: d.config.policies_dir ?? '',
      sha: d.policies().revision,
      drift: { in_sync: true, live_sha: d.policies().revision, detail: null },
      rendered: p,
    };
  });

  app.post('/v1/policies/simulate', async (req) => {
    await d.auth.reader(req);
    const b = (req.body ?? {}) as {
      cluster_id?: string;
      action?: string;
      target?: { kind: string; namespace: string | null; name: string };
      params?: Record<string, unknown>;
    };
    if (!b.cluster_id || !b.action || !b.target) {
      throw badRequest('需要 cluster_id、action、target');
    }
    const a = d.catalog.get(b.action);
    const reasons: string[] = [];
    if (!a) {
      return {
        allowed: false,
        level: null,
        tier: null,
        auto: false,
        approvers: [],
        rules: [],
        reasons: [`动作 ${b.action} 不在目录中`],
      };
    }
    const pol = d.policies().check(b.cluster_id, a.id, b.target.namespace);
    if (pol) {
      reasons.push(pol);
    }
    const info = await d.targets.resolve(b.cluster_id, b.target.kind, b.target.namespace, b.target.name);
    if (!info.uid) {
      reasons.push('拓扑中没有目标对象');
    }
    const self = d.policies().selfDependency(b.cluster_id, b.target.kind, b.target.namespace, b.target.name);
    const { level, tier } = d.proposals.levelAndTier(a, self, info);
    const rules =
      d
        .policies()
        .get(b.cluster_id)
        ?.actions.find((x) => x.id === a.id)?.auto_execution?.rules ?? [];
    const target = { cluster: b.cluster_id, namespace: b.target.namespace, labels: {} };
    // 能审批的绑定：角色含 approve、风险上限覆盖档位、作用域覆盖目标
    const approvers = d.auth.currentBindings.entries
      .filter((e) => {
        const ceil = tierCeiling(e.binding);
        return (
          ROLE_PERMISSIONS[e.binding.role].includes('approve') &&
          ceil !== null &&
          (ceil === 'H' || tier === 'L') &&
          scopeMatches(e.binding, target)
        );
      })
      .map((e) => ({ subject: `${e.binding.subject.kind}:${e.binding.subject.name}`, role: e.binding.role }));
    const auto =
      !self &&
      a.auto_execution === 'allowed' &&
      (level === 'reversible' || level === 'reversible_recreatable') &&
      rules.length > 0;
    return { allowed: reasons.length === 0, level, tier, auto, approvers, rules, reasons };
  });

  app.get('/v1/topology/neighborhood', async (req) => {
    await d.auth.reader(req);
    const q = req.query as { cluster_id?: string; component?: string; at?: string; hops?: string };
    if (!q.component) {
      throw badRequest('需要 component');
    }
    const cluster = q.cluster_id ?? d.config.cluster_id;
    const at = q.at ? new Date(q.at) : new Date();
    const hops = Math.min(2, Math.max(1, Number(q.hops ?? 2)));
    const pseudo = {
      cluster_id: cluster,
      root: { component: q.component, entity: null, ambiguous: false, margin: null, silent_root: false },
      candidates: [],
      members: [],
      components: [q.component],
      updated_at: at.toISOString(),
      topology_version: 0,
    } as unknown as Parameters<typeof subgraphOf>[1];
    return subgraphOf(d.topology, pseudo, hops);
  });

  app.get('/v1/topology/diff', async (req) => {
    await d.auth.reader(req);
    const q = req.query as { cluster_id?: string; from?: string; to?: string };
    const cluster = q.cluster_id ?? d.config.cluster_id;
    const from = Number(q.from);
    const to = Number(q.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
      throw badRequest('from、to 是拓扑版本号，from ≤ to');
    }
    const now = new Date();
    const a = await d.topology.at(cluster, now, from);
    const b = await d.topology.at(cluster, now, to);
    const nk = (x: { key: string }) => x.key;
    const ek = (x: { from: string; relation: string; to: string }) => `${x.from}|${x.relation}|${x.to}`;
    const aN = new Set(a.nodes.map(nk));
    const bN = new Set(b.nodes.map(nk));
    const aE = new Set(a.edges.map(ek));
    const bE = new Set(b.edges.map(ek));
    return {
      added_nodes: b.nodes.filter((x) => !aN.has(nk(x))),
      removed_nodes: a.nodes.filter((x) => !bN.has(nk(x))),
      added_edges: b.edges.filter((x) => !aE.has(ek(x))),
      removed_edges: a.edges.filter((x) => !bE.has(ek(x))),
    };
  });

  app.get('/v1/topology/coverage', async (req) => {
    await d.auth.reader(req);
    const cluster = (req.query as { cluster_id?: string }).cluster_id ?? d.config.cluster_id;
    const topo = await d.topology.at(cluster, new Date());
    const nodes = await d.pool.query<{ key: string; source: string; component_type: string | null }>(
      "SELECT DISTINCT ON (key) key, source, body->>'component_type' AS component_type FROM server.topology_events WHERE cluster_id = $1 AND item = 'node' AND valid_to IS NULL ORDER BY key, seq DESC",
      [cluster],
    );
    const mapped = await d.pool.query<{ component: string; names: string[] }>(
      "SELECT component, array_agg(DISTINCT alertname) AS names FROM server.alert_state WHERE cluster_id = $1 AND component IS NOT NULL AND starts_at > now() - interval '14 days' GROUP BY component",
      [cluster],
    );
    const unmapped = await d.pool.query<{ alertname: string; n: number; role: string; confidence: number }>(
      `SELECT alertname, count(*)::int AS n, (array_agg(classification->>'role'))[1] AS role, max((classification->>'confidence')::float8) AS confidence
         FROM server.alert_state WHERE cluster_id = $1 AND starts_at > now() - interval '14 days' AND (component IS NULL OR component LIKE 'Namespace:%')
        GROUP BY alertname ORDER BY n DESC LIMIT 200`,
      [cluster],
    );
    const byComp = new Map(mapped.rows.map((x) => [x.component, x.names]));
    const comps = nodes.rows.filter((n) => n.component_type !== null || byComp.has(n.key));
    return {
      topology_version: topo.version,
      components: comps.map((n) => ({
        component: n.key,
        type: n.component_type,
        discovered_by: n.source as 'informer',
        chains: [],
        mapped_alerts: byComp.get(n.key) ?? [],
      })),
      unmapped_alerts: unmapped.rows.map((u) => ({
        alertname: u.alertname,
        count_14d: u.n,
        suggested_role: (u.role ?? 'symptom') as 'symptom',
        confidence: u.confidence ?? 0,
        suggested_component: null,
        expr: null,
      })),
      components_without_chains: comps.map((n) => n.key),
      suggestions: [],
    };
  });

  app.post('/v1/topology/overrides/pr', async (req) => {
    await d.auth.user(req, 'settings.write');
    throw new HttpError(
      503,
      'unavailable',
      '没有配置 Git 仓库凭证，不能发起覆盖规则的 PR；在 Git 中直接修改拓扑覆盖文件',
    );
  });

  app.get('/v1/audit/chains', async (req) => {
    await d.auth.user(req, 'audit.read');
    const head = await d.pool.query<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM server.governance_audit ORDER BY seq DESC LIMIT 1',
    );
    const recent = await readAudit(d.pool, Math.max(0, (head.rows[0]?.seq ?? 0) - 1000), 1000);
    const anchor = recent.length
      ? { seq: (recent[0]?.seq ?? 1) - 1, hash: recent[0]?.prev_hash ?? GENESIS_HASH }
      : { seq: 0, hash: GENESIS_HASH };
    const err = verifyRecords(recent, anchor);
    const st = await d.exporter.status();
    const s3 = d.config.audit.s3;
    return [
      {
        chain: 'governance' as const,
        cluster_id: null,
        sink: s3
          ? {
              kind: s3.endpoint.includes('amazonaws.com') ? ('s3' as const) : ('minio' as const),
              location: `${s3.bucket}/${s3.prefix}`,
              worm: d.config.profile === 'compliance',
              retention_days: d.config.profile === 'compliance' ? 180 : null,
            }
          : { kind: 'pg' as const, location: 'server.governance_audit', worm: false, retention_days: null },
        head_seq: head.rows[0]?.seq ?? 0,
        head_hash: head.rows[0]?.hash ?? null,
        verified: { ok: err === null, at: new Date().toISOString(), error: err },
        export_lag_seconds: s3 ? st.lagSeconds : null,
        lag_threshold_seconds: parseDuration('audit.export_lag_threshold', d.config.audit.export_lag_threshold) / 1000,
      },
    ];
  });

  app.get('/v1/audit/records', async (req) => {
    await d.auth.user(req, 'audit.read');
    const q = req.query as { chain?: string; cursor?: string; limit?: string };
    if (q.chain && q.chain !== 'governance') {
      throw notFound('执行链由各集群的 gateway 写入审计汇，中心只保存治理链');
    }
    const after = q.cursor ? Number(q.cursor) : 0;
    const limit = Math.min(1000, Math.max(1, Number(q.limit ?? 100)));
    const items = await readAudit(d.pool, after, limit);
    return { items, next_cursor: items.length === limit ? String(items[items.length - 1]?.seq) : null };
  });

  const defaultSettings = () => ({
    channels: [
      ...(d.config.notify.telegram?.enabled
        ? d.config.notify.telegram.chats.map((c) => ({
            id: `telegram:${c.id}`,
            kind: 'telegram' as const,
            target: String(c.id),
            enabled: true,
            rate_per_min: d.config.notify.telegram?.messages_per_minute ?? 20,
          }))
        : []),
      ...(d.config.notify.feishu?.enabled
        ? d.config.notify.feishu.chats.map((c) => ({
            id: `feishu:${c.chat_id}`,
            kind: 'feishu' as const,
            target: c.chat_id,
            enabled: true,
            rate_per_min: d.config.notify.feishu?.messages_per_minute ?? 100,
          }))
        : []),
    ],
    retention: { incidents_days: 365, research_days: 180, raw_prompt_days: 30 },
    locale: d.config.stage_a.language === 'en' ? ('en' as const) : ('zh-CN' as const),
    time_zone: 'UTC',
    subscriptions: [],
  });

  app.get('/v1/settings', async (req) => {
    await d.auth.reader(req);
    const r = await d.pool.query<{ value: unknown }>("SELECT value FROM server.system_state WHERE key = 'settings'");
    return r.rows[0]?.value ?? defaultSettings();
  });

  app.put('/v1/settings', async (req) => {
    const c = await d.auth.user(req, 'settings.write');
    const v = assertValidSettings(req.body);
    await tx(d.pool, async (cl) => {
      await cl.query(
        `INSERT INTO server.system_state (key, value, updated_at) VALUES ('settings', $1, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [JSON.stringify(v)],
      );
      await appendAudit(cl, 'settings.update', c.subject.id, v);
    });
    return v;
  });

  const tokenView = (r: {
    id: string;
    name: string;
    created_by: string;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date | null;
  }) => ({
    id: r.id,
    name: r.name,
    scopes: ['propose' as const],
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    last_used_at: fmt(r.last_used_at),
    expires_at: fmt(r.expires_at),
  });

  app.get('/v1/api-tokens', async (req) => {
    await d.auth.user(req, 'api_tokens.write');
    const r = await d.pool.query<{
      id: string;
      name: string;
      created_by: string;
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date | null;
    }>('SELECT * FROM server.api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC');
    return r.rows.map(tokenView);
  });

  app.post('/v1/api-tokens', async (req, reply) => {
    const c = await d.auth.user(req, 'api_tokens.write');
    const b = (req.body ?? {}) as { name?: string; expires_at?: string | null };
    if (!b.name || b.name.length > 100) {
      throw badRequest('name 必须是 1–100 个字符');
    }
    const token = `srn_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const row = await tx(d.pool, async (cl) => {
      const r = await cl.query<{
        id: string;
        name: string;
        created_by: string;
        created_at: Date;
        last_used_at: Date | null;
        expires_at: Date | null;
      }>(
        'INSERT INTO server.api_tokens (id, name, token_sha256, created_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [id, b.name, createHash('sha256').update(token).digest('hex'), c.subject.id, b.expires_at ?? null],
      );
      await appendAudit(cl, 'api_token.create', c.subject.id, { id, name: b.name, expires_at: b.expires_at ?? null });
      return r.rows[0] as {
        id: string;
        name: string;
        created_by: string;
        created_at: Date;
        last_used_at: Date | null;
        expires_at: Date | null;
      };
    });
    return reply.code(201).send({ token, api_token: tokenView(row) });
  });

  app.delete('/v1/api-tokens/:id', async (req, reply) => {
    const c = await d.auth.user(req, 'api_tokens.write');
    const id = (req.params as { id: string }).id;
    const n = await tx(d.pool, async (cl) => {
      const r = await cl.query('UPDATE server.api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
        id,
      ]);
      await appendAudit(cl, 'api_token.revoke', c.subject.id, { id });
      return r.rowCount ?? 0;
    });
    if (!n) {
      throw notFound('没有这个 API token');
    }
    return reply.code(204).send();
  });

  app.get('/v1/packs', async (req) => {
    await d.auth.reader(req);
    const lockFile = d.config.packs.lock_file;
    const lock =
      lockFile && existsSync(lockFile)
        ? assertValid('schemas/pack.schema.json#/$defs/PackLock', parseYaml(readFileSync(lockFile, 'utf8')))
        : { api_version: 'srenautix.io/pack-lock/v1', packs: [], layers: [] };
    return { pack_lock: lock, packs: [] };
  });

  app.get('/v1/integrations', async (req) => {
    await d.auth.reader(req);
    return [];
  });

  app.post('/v1/integrations/:id/test', async (req) => {
    await d.auth.user(req, 'settings.write');
    throw notFound(`没有集成实例 ${(req.params as { id: string }).id}`);
  });

  /** worker 持有的页面数据：研判明细、评测、Agent 健康与成本、出境账本、模型路由。server 按角色授权后转发。 */
  const proxy = async (req: FastifyRequest, path: string, method: 'GET' | 'POST') => {
    if (!d.worker) {
      throw new HttpError(503, 'unavailable', '没有配置 worker');
    }
    const res = await fetch(`${d.worker.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${d.worker.token}`,
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.text() };
  };
  const forward = (method: 'GET' | 'POST', route: string, check: (req: FastifyRequest) => Promise<unknown>) =>
    app.route({
      method,
      url: route,
      handler: async (req, reply) => {
        await check(req);
        const r = await proxy(req, req.url, method);
        return reply.code(r.status).type('application/json').send(r.body);
      },
    });
  const read = (req: FastifyRequest) => d.auth.reader(req);
  forward('GET', '/v1/runs/:run_id/prompts', read);
  forward('POST', '/v1/runs/:run_id/eval-case', (req) => d.auth.user(req, 'eval.write'));
  forward('GET', '/v1/eval/reports', read);
  forward('GET', '/v1/eval/reports/:report_id', read);
  forward('GET', '/v1/eval/cases', read);
  forward('GET', '/v1/eval/trend', read);
  forward('POST', '/v1/eval/estimate', (req) => d.auth.user(req, 'research.request'));
  forward('GET', '/v1/agent/health', read);
  forward('GET', '/v1/agent/cost', read);
  forward('GET', '/v1/egress/ledger', (req) => d.auth.user(req, 'audit.read'));
  forward('GET', '/v1/models/routes', read);
}

function assertValidSettings(v: unknown) {
  return checkBody(openapiValidator<Record<string, unknown>>('openapi.yaml', 'Settings'), v);
}
