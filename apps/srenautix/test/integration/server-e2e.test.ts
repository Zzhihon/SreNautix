import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { SESSION_COOKIE } from '../../src/identity/sessions.js';
import { hashPassword } from '../../src/identity/password.js';
import {
  checkBinding,
  executionId,
  keyringFrom,
  publicKeyB64u,
  verifyEnvelope,
} from '../../src/proposals/assertion.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fixture, FixtureServer } from '../support/fixture-server.js';
import { until } from '../support/monitoring.js';

/**
 * server 角色端到端：真实 PostgreSQL、真实 HTTP。告警 webhook → 事件与阶段 A → 消息发出 → worker 认领与提议 →
 * 控制台审批签发断言 → gateway 拉取工单并推送执行事件 → 反馈 → 事件流。每个控制台接口的响应按 contract/openapi.yaml 校验。
 */
const PUBLIC = 'https://srenautix.example.test';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `e2e-${process.pid}`);
const TOKENS = {
  ingest: 'ingest-token-e2e-0123456789abcdef',
  worker: 'worker-token-e2e-0123456789abcdef',
  gateway: 'gateway-token-e2e-0123456789abcdef',
  bot: '123456:TEST-bot-token',
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let db: TestDb;
let srv: ServerHandle;
let tg: FixtureServer;
let totp: TOTP;
let signingPub = '';
let cookie = '';
let csrf = '';

const file = (name: string, content: string) => {
  const p = join(ROOT, name);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; session?: boolean; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  if (opts.session) {
    headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    if (method !== 'GET') {
      headers.origin = PUBLIC;
      headers['x-csrf-token'] = csrf;
    }
  }
  const res = await fetch(`${srv.apiUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown> & unknown[]) : null };
}

function conform(path: string, method: string, r: { status: number; body: unknown }) {
  expect(responseErrors(path, method, r.status, r.body)).toBeNull();
}

beforeAll(async () => {
  db = await newTestDb();
  // 拓扑：shop/api Deployment 与它的 Pod（目标解析要用 UID）
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const at = new Date(Date.now() - 3600_000);
  const node = (kind: string, ns: string | null, name: string, uid: string) => ({
    key: ns ? `${kind}:${ns}/${name}` : `${kind}:${name}`,
    kind,
    namespace: ns,
    name,
    uid,
    labels: {},
    component_type: null,
    hub: false,
  });
  await topo.apply('c1', [
    { op: 'node_upsert', at, source: 'informer', node: node('Deployment', 'shop', 'api', 'uid-deploy-api') },
    { op: 'node_upsert', at, source: 'informer', node: node('Pod', 'shop', 'api-7d9f8-x2k4p', 'uid-pod-api') },
    {
      op: 'edge_upsert',
      at,
      source: 'informer',
      edge: {
        from: 'Pod:shop/api-7d9f8-x2k4p',
        to: 'Deployment:shop/api',
        relation: 'owned_by',
        provenance: 'structural',
        confidence: 1,
        scope: 'instance',
        evidence: 'ownerReference',
      },
    },
  ]);

  tg = new FixtureServer();
  await tg.start();
  tg.on('POST', `/bot${TOKENS.bot}/sendMessage`, [fixture('telegram', 'send-message.ok')]);
  tg.on('POST', `/bot${TOKENS.bot}/editMessageText`, [fixture('telegram', 'edit-message-text.ok')]);

  totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  const signing = generateKeyPairSync('ed25519');
  signingPub = publicKeyB64u(signing.publicKey);
  const checkpoint = generateKeyPairSync('ed25519');
  const config = parseServerConfig({
    cluster_id: 'c1',
    profile: 'standard',
    log_level: 'warn',
    public_url: PUBLIC,
    policies_dir: resolve(
      file(
        'policies/c1.yaml',
        stringify({
          version: 1,
          cluster: 'c1',
          actions: [{ id: 'workload_scale', namespaces: ['shop'] }],
          approvers: [{ principal: 'local:admin', namespaces: ['*'], max_tier: 'H' }],
        }),
      ),
      '..',
    ),
    ingest: {
      sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', TOKENS.ingest) }],
      reconcile: { enabled: false },
    },
    packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
    datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
    topology: { source: 'off' },
    notify: {
      prefix: '[影子]',
      telegram: {
        enabled: true,
        bot_token_file: file('bot-token', TOKENS.bot),
        api_base: tg.url,
        chats: [{ id: -1001234567890 }],
        updates: 'none',
      },
    },
    approvals: {
      signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
      key_id: 'e2e-service',
    },
    callers: {
      tokens_file: file(
        'callers.yaml',
        stringify({
          callers: [
            { id: 'worker', kind: 'worker', token_sha256: sha(TOKENS.worker) },
            { id: 'gw-c1', kind: 'spoke', role: 'gateway', cluster_id: 'c1', token_sha256: sha(TOKENS.gateway) },
          ],
        }),
      ),
    },
    identity: {
      local_admin: {
        username: 'admin',
        password_hash_file: file('admin.hash', await hashPassword('correct horse battery')),
        totp_secret_file: file('admin.totp', totp.secret.base32),
      },
      bindings_dir: resolve(
        file(
          'bindings/admin.yaml',
          stringify({
            bindings: [
              {
                subject: { kind: 'group', name: 'srenautix:local-admin' },
                role: 'admin',
                scope: { clusters: ['*'], namespaces: ['*'] },
              },
            ],
          }),
        ),
        '..',
      ),
    },
    audit: {
      checkpoint_key_file: file(
        'checkpoint.pem',
        checkpoint.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
      ),
    },
  });
  srv = await buildServer({
    config,
    pg: db.serverConfig,
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: 0 },
  });
  const login = await fetch(`${srv.apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery', totp: totp.generate() }),
  });
  expect(login.status).toBe(200);
  cookie = /__Host-srenautix_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  csrf = ((await login.json()) as { csrf_token: string }).csrf_token;
}, 120_000);

afterAll(async () => {
  await srv?.stop();
  await tg?.stop();
  await db?.close();
});

describe('server 端到端', () => {
  let incidentId = '';
  let proposalId = '';
  let ticket: {
    ticket_id: string;
    envelope: { assertion: { proposal_id: string } };
    proposal: Record<string, unknown>;
  } | null = null;

  it('Alertmanager webhook 生成事件与阶段 A 报告，消息带前缀发出', async () => {
    const body = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json'),
        'utf8',
      ),
    ) as { alerts: Array<{ startsAt: string; labels: Record<string, string> }> };
    body.alerts[0]!.startsAt = new Date(Date.now() - 30_000).toISOString();
    const r = await api('POST', '/v1/ingest/am', { body, token: TOKENS.ingest });
    expect(r.status).toBe(200);
    conform('/v1/ingest/{source_id}', 'post', r);
    const list = await until('事件出现', async () => {
      const l = await api('GET', '/v1/incidents', { session: true });
      return (l.body as unknown as { items: Array<{ incident_id: string; disposition: string | null }> }).items.find(
        (x) => x.disposition !== null,
      )
        ? l
        : null;
    });
    conform('/v1/incidents', 'get', list);
    incidentId = (list.body as unknown as { items: Array<{ incident_id: string }> }).items[0]!.incident_id;
    const inc = await api('GET', `/v1/incidents/${incidentId}`, { session: true });
    conform('/v1/incidents/{incident_ref}', 'get', inc);
    const byLabel = await api(
      'GET',
      `/v1/incidents/${encodeURIComponent((inc.body as unknown as { label: string }).label)}`,
      { session: true },
    );
    expect((byLabel.body as unknown as { incident_id: string }).incident_id).toBe(incidentId);
    const sa = await api('GET', `/v1/incidents/${incidentId}/stage-a`, { session: true });
    conform('/v1/incidents/{incident_ref}/stage-a', 'get', sa);
    conform(
      '/v1/incidents/{incident_ref}/timeline',
      'get',
      await api('GET', `/v1/incidents/${incidentId}/timeline`, { session: true }),
    );
    conform(
      '/v1/incidents/{incident_ref}/subgraph',
      'get',
      await api('GET', `/v1/incidents/${incidentId}/subgraph`, { session: true }),
    );
    const sent = await until('消息发出', async () => tg.calls('POST', `/bot${TOKENS.bot}/sendMessage`)[0]);
    const text = (sent.body as { text: string }).text;
    expect(text.startsWith('[影子]')).toBe(true);
    expect(text).toContain('api 重启');
  });

  it('worker 认领阶段 B 任务，取得输入，提交带幂等键的提议', async () => {
    const claim = await api('POST', '/v1/research/claim', { token: TOKENS.worker, body: { worker_id: 'w1' } });
    expect(claim.status).toBe(200);
    const task = (claim.body as unknown as { task: { run_id: string; worker_id: string; incident_id: string } }).task;
    expect(task.incident_id).toBe(incidentId);
    const ctx = await api('GET', `/v1/research/tasks/${task.run_id}/context`, { token: TOKENS.worker });
    const c = ctx.body as unknown as {
      incident: { incident_version: number; root: { component: string } };
      stage_a: { evidence_fingerprint: string };
    };
    const create = {
      incident_id: incidentId,
      binding: {
        incident_version: c.incident.incident_version,
        root_component: c.incident.root.component,
        evidence_fingerprint: c.stage_a.evidence_fingerprint,
      },
      action: 'workload_scale',
      params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: 3 },
      research_run_id: task.run_id,
      rule_id: null,
      hypothesis_id: 'h1',
      evidence_refs: [],
      expected_effect: '扩容后错误率下降',
    };
    const p1 = await api('POST', '/v1/proposals', {
      token: TOKENS.worker,
      body: create,
      headers: { 'idempotency-key': 'e2e-proposal-0001' },
    });
    expect(p1.status).toBe(201);
    const p2 = await api('POST', '/v1/proposals', {
      token: TOKENS.worker,
      body: create,
      headers: { 'idempotency-key': 'e2e-proposal-0001' },
    });
    expect(p2.body).toEqual(p1.body);
    const p = p1.body as unknown as { proposal_id: string; state: string; tier: string; target: { uid: string } };
    expect(p).toMatchObject({ state: 'awaiting_approval', tier: 'L', target: { uid: 'uid-deploy-api' } });
    proposalId = p.proposal_id;
    const stale = await api('POST', '/v1/proposals', {
      token: TOKENS.worker,
      body: { ...create, binding: { ...create.binding, incident_version: 99 } },
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await api('POST', `/v1/research/tasks/${task.run_id}/finish`, {
          token: TOKENS.worker,
          body: { worker_id: task.worker_id, state: 'completed' },
        })
      ).status,
    ).toBe(204);
    const detail = await api('GET', `/v1/proposals/${proposalId}`, { session: true });
    conform('/v1/proposals/{proposal_id}', 'get', detail);
  });

  it('控制台审批签发服务签名断言，gateway 能校验签名与绑定', async () => {
    const r = await api('POST', `/v1/proposals/${proposalId}/approve`, {
      session: true,
      body: { confirm_target: null },
    });
    expect(r.status).toBe(200);
    conform('/v1/proposals/{proposal_id}/approve', 'post', r);
    const env = (r.body as unknown as { envelope: unknown }).envelope;
    const keys = keyringFrom({ version: 1, keys: [{ use: 'service', key_id: 'e2e-service', public_key: signingPub }] });
    const v = verifyEnvelope(env, keys, { requireWebAuthnForH: false });
    expect(v.envelope.assertion).toMatchObject({
      proposal_id: proposalId,
      action: 'workload_scale',
      cluster: 'c1',
      approver_principal: 'local:admin',
      channel: 'console',
      tier: 'L',
      target_uid: 'uid-deploy-api',
    });
    const again = await api('POST', `/v1/proposals/${proposalId}/approve`, {
      session: true,
      body: { confirm_target: null },
    });
    expect(again.status).toBe(409);
  });

  it('gateway 拉取工单、复核绑定、推送执行事件；集群头与 token 不一致时拒绝', async () => {
    const H = { 'x-srenautix-cluster': 'c1' };
    const wrong = await api('GET', '/v1/spoke/tickets?wait=0', {
      token: TOKENS.gateway,
      headers: { 'x-srenautix-cluster': 'c2' },
    });
    expect(wrong.status).toBe(403);
    const t = await api('GET', '/v1/spoke/tickets?wait=0', { token: TOKENS.gateway, headers: H });
    const tickets = (t.body as unknown as { tickets: Array<NonNullable<typeof ticket>> }).tickets;
    expect(tickets).toHaveLength(1);
    ticket = tickets[0]!;
    const env = ticket.envelope as unknown as Parameters<typeof verifyEnvelope>[0];
    const keys = keyringFrom({ version: 1, keys: [{ use: 'service', key_id: 'e2e-service', public_key: signingPub }] });
    const v = verifyEnvelope(env, keys, { requireWebAuthnForH: false });
    const tp = ticket.proposal as {
      params: unknown;
      target: { uid: string };
      incident_version: number;
      root_component: string;
      evidence_fingerprint: string;
      proposal_expires_at: string;
      proposal_id: string;
      action: string;
    };
    checkBinding(
      v.envelope.assertion,
      { ...tp, target_uid: tp.target.uid, cluster: 'c1', proposal_expires_at: new Date(tp.proposal_expires_at) },
      new Date(),
      null,
    );
    const b = await api('GET', `/v1/spoke/proposals/${proposalId}/binding`, { token: TOKENS.gateway, headers: H });
    expect((b.body as unknown as { state: string }).state).toBe('current');
    const exec = executionId(proposalId, v.hash);
    const ev = (seq: number, phase: string, extra: Record<string, unknown> = {}) => ({
      event_id: createHash('sha256').update(`srenautix-event-v1\n${exec}\n${seq}`).digest('hex').slice(0, 32),
      execution_id: exec,
      ticket_id: ticket!.ticket_id,
      proposal_id: proposalId,
      seq,
      phase,
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      reason: phase,
      ...extra,
    });
    const pushed = await api('POST', '/v1/spoke/events', {
      token: TOKENS.gateway,
      headers: H,
      body: { events: [ev(1, 'pulled', { queue_position: 1 }), ev(2, 'executing'), ev(3, 'verified')] },
    });
    expect(pushed.status).toBe(200);
    const dup = await api('POST', '/v1/spoke/events', {
      token: TOKENS.gateway,
      headers: H,
      body: { events: [ev(1, 'pulled', { queue_position: 1 })] },
    });
    expect((dup.body as unknown as { duplicates: string[] }).duplicates).toHaveLength(1);
    const again = await api('GET', '/v1/spoke/tickets?wait=0', { token: TOKENS.gateway, headers: H });
    expect((again.body as unknown as { tickets: unknown[] }).tickets).toHaveLength(0);
    const p = await api('GET', `/v1/proposals/${proposalId}`, { session: true });
    expect((p.body as unknown as { proposal: { state: string; execution: { phase: string } } }).proposal).toMatchObject(
      { state: 'dispatched', execution: { phase: 'verified' } },
    );
    const hb = await api('POST', '/v1/spoke/heartbeat', {
      token: TOKENS.gateway,
      headers: H,
      body: {
        gateway_id: 'gw-0',
        version: '0.1.0',
        leader: true,
        propose_only: false,
        conditions: [
          {
            type: 'AdmissionSelfCheck',
            status: 'True',
            reason: 'Denied',
            since: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          },
        ],
        queue: [],
        clock_skew_seconds: { apiserver: 0.1 },
      },
    });
    expect(hb.status).toBe(200);
    const clusters = await api('GET', '/v1/clusters', { session: true });
    conform('/v1/clusters', 'get', clusters);
    expect(
      (clusters.body as unknown as Array<{ cluster_id: string; proposal_only: boolean }>).find(
        (x) => x.cluster_id === 'c1',
      )?.proposal_only,
    ).toBe(false);
  });

  it('反馈两个维度；根因必须来自事件的拓扑组件', async () => {
    const inc = (await api('GET', `/v1/incidents/${incidentId}`, { session: true })).body as unknown as {
      components: string[];
    };
    const bad = await api('POST', `/v1/incidents/${incidentId}/feedback`, {
      session: true,
      body: {
        research_run_id: null,
        verdict: 'rejected',
        root_component: 'Node:elsewhere',
        disposition_verdict: null,
        disposition: null,
        mechanism: null,
        reason: null,
      },
    });
    expect(bad.status).toBe(400);
    const ok = await api('POST', `/v1/incidents/${incidentId}/feedback`, {
      session: true,
      body: {
        research_run_id: null,
        verdict: 'rejected',
        root_component: inc.components[0],
        disposition_verdict: 'rejected',
        disposition: 'escalate',
        mechanism: null,
        reason: '实际是上游',
      },
    });
    expect(ok.status).toBe(201);
    conform('/v1/incidents/{incident_ref}/feedback', 'post', ok);
    expect(ok.body).toMatchObject({ channel: 'console', linked: true, implicit: null });
    const list = await api('GET', `/v1/incidents/${incidentId}/feedback`, { session: true });
    conform('/v1/incidents/{incident_ref}/feedback', 'get', list);
    // 批准产生了一条隐式反馈
    expect((list.body as unknown as Array<{ implicit: string | null }>).map((x) => x.implicit)).toContain('approved');
  });

  it('事件流按游标返回全部类型，长轮询在没有新事件时等待', async () => {
    const r = await api('GET', '/v1/events?after=server:0&limit=500', { session: true });
    const types = new Set((r.body as unknown as { events: Array<{ type: string }> }).events.map((e) => e.type));
    for (const t of [
      'incident.created',
      'stage_a.reported',
      'research.queued',
      'proposal.created',
      'approval.issued',
      'execution.updated',
      'feedback.recorded',
    ]) {
      expect(types).toContain(t);
    }
    const next = (r.body as unknown as { next: string }).next;
    const started = Date.now();
    const empty = await api('GET', `/v1/events?after=${next}&wait=1`, { session: true });
    expect((empty.body as unknown as { events: unknown[] }).events).toHaveLength(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('状态条件、软暂停、设置与 API token 的响应符合契约', async () => {
    conform('/v1/conditions', 'get', await api('GET', '/v1/conditions', { session: true }));
    const paused = await api('PUT', '/v1/pause', {
      session: true,
      body: { paused: true, reason: '演练', expires_at: null },
    });
    conform('/v1/pause', 'put', paused);
    expect((paused.body as unknown as { paused: boolean }).paused).toBe(true);
    await api('PUT', '/v1/pause', { session: true, body: { paused: false, reason: null, expires_at: null } });
    conform('/v1/settings', 'get', await api('GET', '/v1/settings', { session: true }));
    const tok = await api('POST', '/v1/api-tokens', { session: true, body: { name: 'holmes', expires_at: null } });
    expect(tok.status).toBe(201);
    conform('/v1/api-tokens', 'post', tok);
    // API token 只能提议：读接口可用，审批被拒绝
    const token = (tok.body as unknown as { token: string }).token;
    expect((await api('GET', '/v1/incidents', { token })).status).toBe(200);
    expect(
      (await api('POST', `/v1/proposals/${proposalId}/approve`, { token, body: { confirm_target: null } })).status,
    ).toBe(403);
    conform('/v1/audit/chains', 'get', await api('GET', '/v1/audit/chains', { session: true }));
    conform('/v1/search', 'get', await api('GET', '/v1/search?q=api', { session: true }));
    conform('/v1/policies', 'get', await api('GET', '/v1/policies?cluster_id=c1', { session: true }));
    const sim = await api('POST', '/v1/policies/simulate', {
      session: true,
      body: {
        cluster_id: 'c1',
        action: 'workload_scale',
        target: { kind: 'Deployment', namespace: 'shop', name: 'api' },
        params: {},
      },
    });
    conform('/v1/policies/simulate', 'post', sim);
    expect(sim.body).toMatchObject({ allowed: true, tier: 'L', level: 'reversible' });
    void randomUUID;
  });
});
