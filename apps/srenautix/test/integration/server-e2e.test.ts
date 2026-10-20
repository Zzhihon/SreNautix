import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { validatorFor } from '@srenautix/contract';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { upsertUser } from '../../src/identity/chat-links.js';
import { HubClient } from '../../src/research/hub.js';
import { HubQueryRunner } from '../../src/research/hub-query.js';
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
import { FakeGitHub } from '../support/github.js';
import { exampleWithTemplate } from '../support/packs.js';
import { fixture, FixtureServer } from '../support/fixture-server.js';
import { until } from '../support/monitoring.js';
import { hubTools } from '../../src/tools/hub.js';
import { ToolArgError } from '../../src/tools/limits.js';

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
  grafana: 'grafana-token-e2e-0123456789abcdef',
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
let rolloutSha = '';
let gh: FakeGitHub;

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
  // 控制台构建产物的最小样本：index.html、带哈希的资源、根目录文件
  file('console/index.html', '<!doctype html><title>SreNautix</title><div id="root"></div>');
  file('console/assets/index-3f9a1c.js', 'console.log(1)');
  file('console/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const consoleDir = join(ROOT, 'console');
  // 变更源：告警前 5 分钟的一次发布，触及 Deployment shop/api
  const ghApp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  gh = new FakeGitHub('1001', '2002', ghApp.publicKey, 'acme/gitops');
  await gh.start();
  gh.commit('main', { message: 'init', date: new Date(Date.now() - 3 * 3600_000), files: ['README.md'] });
  rolloutSha = gh.commit('main', {
    message: 'roll out api v2',
    date: new Date(Date.now() - 5 * 60_000),
    files: ['apps/shop/api/deployment.yaml'],
  });
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
    packs: { dirs: [exampleWithTemplate(join(ROOT, 'packs'))], only: ['_example'] },
    console: { dir: consoleDir },
    datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
    topology: { source: 'off' },
    github_app: {
      api_base: gh.url,
      app_id: '1001',
      installation_id: '2002',
      private_key_file: file('github-app.pem', ghApp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
    },
    changes: {
      sources: [
        {
          id: 'gitops',
          kind: 'github',
          repo: 'acme/gitops',
          paths: [
            {
              prefix: 'apps/shop/api/',
              targets: ['Deployment:shop/api', 'Pod:shop/api-7d9f8-x2k4p', 'Namespace:shop'],
              kind: 'gitops_sync',
            },
          ],
        },
      ],
    },
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
            { id: 'grafana', kind: 'grafana', token_sha256: sha(TOKENS.grafana) },
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
              {
                subject: { kind: 'group', name: 'shop-oncall' },
                role: 'responder',
                scope: { clusters: ['*'], namespaces: ['shop'] },
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
    serve: 'all',
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
  await gh?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
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
    // 变更源在启动时同步：告警前 5 分钟的发布进入事件的变更列表
    expect((inc.body as unknown as { changes: Array<{ change_id: string; summary: string }> }).changes).toEqual([
      expect.objectContaining({ change_id: `gitops:${rolloutSha}`, summary: 'roll out api v2' }),
    ]);
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

  it('没有配置 GitHub App 时，覆盖规则的 PR 接口返回 503 并说明原因；请求体不合法时 400', async () => {
    const body = {
      cluster_id: 'c1',
      alertname: 'DemoPodCrashLooping',
      component: 'Deployment:shop/api',
      role: 'cause',
    };
    const r = await api('POST', '/v1/topology/overrides/pr', { session: true, body });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({
      error: 'unavailable',
      message: expect.stringContaining('没有配置 github_app 与 topology.override_pr'),
    });
    const bad = await api('POST', '/v1/topology/overrides/pr', { session: true, body: { ...body, role: 'boss' } });
    expect(bad.status).toBe(400);
  });

  it('集成页列出配置中启用的集成实例；连接测试逐项检查声明的能力，结果进入列表与治理审计', async () => {
    const list = await api('GET', '/v1/integrations', { session: true });
    expect(list.status).toBe(200);
    conform('/v1/integrations', 'get', list);
    type Instance = {
      instance_id: string;
      manifest: { id: string };
      secret_refs: string[];
      last_success_at: string | null;
      capabilities: Array<{ name: string; verified: boolean; verified_at: string | null; error: string | null }>;
    };
    const items = list.body as unknown as Instance[];
    expect(items.map((x) => [x.instance_id, x.manifest.id])).toEqual([
      ['ingest:am', 'alertmanager'],
      ['datasource:prometheus', 'prometheus-api'],
      ['changes:gitops', 'github'],
      ['notify:telegram', 'telegram'],
      ['approve:console', 'console'],
      ['identity:local-admin', 'local-admin'],
    ]);
    // 只有挂载文件的路径，没有内容
    expect(items[0]!.secret_refs).toEqual([join(ROOT, 'ingest-token')]);
    expect(JSON.stringify(list.body)).not.toContain(TOKENS.ingest);
    expect(items[0]!.last_success_at).not.toBeNull();
    expect(items.flatMap((x) => x.capabilities).every((c) => !c.verified && c.verified_at === null)).toBe(true);

    const test = async (id: string) => {
      const r = await api('POST', `/v1/integrations/${encodeURIComponent(id)}/test`, { session: true, body: {} });
      expect(r.status).toBe(200);
      conform('/v1/integrations/{instance_id}/test', 'post', r);
      return r.body as unknown as {
        ok: boolean;
        results: Array<{ capability: string; ok: boolean; error: string | null }>;
      };
    };
    // GitHub 变更源：经 App 令牌读取提交与 diff
    expect(await test('changes:gitops')).toMatchObject({
      ok: true,
      results: [{ capability: 'changes.list', ok: true }],
    });
    // 告警接入：刚收到过告警；没有配置对账地址，alerts.reconcile 没有服务端探测
    const am = await test('ingest:am');
    expect(am.results.map((x) => [x.capability, x.ok])).toEqual([
      ['alerts.webhook', true],
      ['alerts.reconcile', false],
    ]);
    expect(am.results[1]!.error).toBe('这项能力没有服务端探测');
    // 指标数据源不可达：每项能力都给出失败原因
    const prom = await test('datasource:prometheus');
    expect(prom.ok).toBe(false);
    expect(prom.results.every((x) => !x.ok && x.error)).toBe(true);
    // Telegram 的 updates 为 none：不接收按钮回调与 /link
    const tgr = await test('notify:telegram');
    expect(tgr.results.find((x) => x.capability === 'notify.callback_verify')).toMatchObject({ ok: false });
    expect(tgr.results.find((x) => x.capability === 'approve.l_tier')).toMatchObject({ ok: true });
    expect((await test('approve:console')).results.find((x) => x.capability === 'approve.h_tier')).toMatchObject({
      ok: true,
    });

    const after = (await api('GET', '/v1/integrations', { session: true })).body as unknown as Instance[];
    expect(after.find((x) => x.instance_id === 'changes:gitops')!.capabilities[0]).toMatchObject({
      name: 'changes.list',
      verified: true,
      error: null,
    });
    expect(after.find((x) => x.instance_id === 'datasource:prometheus')!.capabilities[0]!.verified).toBe(false);
    expect((await api('POST', '/v1/integrations/nope/test', { session: true, body: {} })).status).toBe(404);
    const audit = await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.governance_audit WHERE kind = 'integration.test'",
    );
    expect(audit.rows[0]!.n).toBe(5);
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
      knowledge: unknown[];
      cases: unknown[];
      templates: Array<{ id: string; description: string; args: Record<string, unknown> }>;
      pack_lock: string;
      topology: { nodes: Array<{ key: string }> };
    };
    // 领域包材料：查询模板（由 server 执行）、pack.lock 摘要；子图中没有 example.web 组件，知识条目为空；没有参考案例
    expect(c.templates).toEqual([
      expect.objectContaining({ id: '_example/memory-ratio', args: expect.objectContaining({ type: 'object' }) }),
    ]);
    expect(c.pack_lock).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(c.knowledge).toEqual([]);
    expect(c.cases).toEqual([]);
    const query = (body: unknown) =>
      api('POST', `/v1/research/tasks/${task.run_id}/query`, { token: TOKENS.worker, body });
    const component = c.incident.root.component;
    expect((await query({ template: '_example/nope', args: {}, component })).status).toBe(404);
    expect((await query({ template: '_example/memory-ratio', args: { limit_ratio: 2 }, component })).status).toBe(400);
    expect(
      (await query({ template: '_example/memory-ratio', args: { limit_ratio: 0.5 }, component: 'Node:elsewhere' }))
        .status,
    ).toBe(400);
    // 证据数据源不可达：卡照常返回，结论为无法判定
    const card = await query({ template: '_example/memory-ratio', args: { limit_ratio: 0.5 }, component });
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ card_id: '_example/templates/memory-ratio', verdict: 'undeterminable' });
    expect(validatorFor('schemas/evidence-result.schema.json')(card.body)).toBe(true);
    // worker 侧的查询执行器经同一接口执行；server 拒绝的请求成为无法判定的卡，原因写进卡的说明
    const runner = new HubQueryRunner(new HubClient(srv.apiUrl, TOKENS.worker), task.run_id);
    const t = c.templates[0]!;
    const rctx = {
      hypothesisId: 'h1',
      rootComponent: component,
      bounds: { from: 0, to: Date.now() },
      signal: AbortSignal.timeout(30_000),
    };
    expect(await runner.run(t, { limit_ratio: 0.5 }, rctx)).toMatchObject({
      card_id: '_example/templates/memory-ratio',
    });
    const refused = await runner.run(t, { limit_ratio: 2 }, rctx);
    expect(refused).toMatchObject({ verdict: 'undeterminable', reason: { kind: 'evaluation_error' } });
    expect(refused.reason.text).toContain('参数不符合模板');
    expect(validatorFor('schemas/evidence-result.schema.json')(refused)).toBe(true);
    // 研判前报告用的是旧的 pack.lock（领域包变化）：先按当前领域包重算阶段 A（ADR 0107）
    const lockOf = async () =>
      (
        await db.server.query<{ pack_lock: string | null }>(
          'SELECT pack_lock FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2',
          [incidentId, c.incident.incident_version],
        )
      ).rows[0]?.pack_lock;
    expect(await lockOf()).toBe((c as unknown as { pack_lock: string }).pack_lock);
    await db.server.query(
      'UPDATE server.stage_a_reports SET pack_lock = $3 WHERE incident_id = $1 AND incident_version = $2',
      [incidentId, c.incident.incident_version, 'sha256:old'],
    );
    expect((await api('GET', `/v1/research/tasks/${task.run_id}/context`, { token: TOKENS.worker })).status).toBe(200);
    expect(await lockOf()).toBe((c as unknown as { pack_lock: string }).pack_lock);
    // Kubernetes 只读检查（ADR 0106）：kube_reads 关闭时不提供工具，调用返回 409；worker 侧按参数错误记录
    expect((c as unknown as { hub_tools: unknown[] }).hub_tools).toEqual([]);
    expect((c as unknown as { related_changes: unknown[] }).related_changes).toEqual([]);
    const tool = await api('POST', `/v1/research/tasks/${task.run_id}/tool`, {
      token: TOKENS.worker,
      body: { name: 'kube_pod_status', args: { namespace: 'shop', pod: 'x' } },
    });
    expect(tool.status).toBe(409);
    expect(tool.body).toMatchObject({ error: 'kube_unavailable' });
    const [ht] = hubTools(new HubClient(srv.apiUrl, TOKENS.worker), task.run_id, [
      { name: 'kube_pod_status', description: 'x', parameters: {} },
    ]);
    await expect(
      ht!.run(
        { namespace: 'shop', pod: 'x' },
        { bounds: { from: 0, to: Date.now() }, signal: AbortSignal.timeout(10_000) },
      ),
    ).rejects.toBeInstanceOf(ToolArgError);
    // 研判队列接口只对 worker 开放
    expect((await api('POST', `/v1/research/tasks/${task.run_id}/query`, { session: true, body: {} })).status).toBe(
      403,
    );
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
    // 冻结期间 gateway 只拉 gitops_pr（冻结只约束集群写入，ADR 0025）：集群写入的工单留在队列中
    const frozen = await api('GET', '/v1/spoke/tickets?wait=0&actions=gitops_pr', {
      token: TOKENS.gateway,
      headers: H,
    });
    expect((frozen.body as unknown as { tickets: unknown[] }).tickets).toEqual([]);
    const bad = await api('GET', '/v1/spoke/tickets?wait=0&actions=Gitops-PR', { token: TOKENS.gateway, headers: H });
    expect(bad.status).toBe(400);
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

  it('Grafana 插件按邮箱映射到已登录的用户授权，只放行读取与 createFeedback', async () => {
    // 两个用户经 OIDC 登录过：alice 在 shop-oncall 组；bob 没有任何角色绑定
    await upsertUser(db.server, { id: 'oidc:alice', display_name: 'Alice', groups: ['shop-oncall'] }, 'oidc', {
      email: 'Alice@Example.test',
    });
    await upsertUser(db.server, { id: 'oidc:bob', display_name: 'Bob', groups: [] }, 'oidc', {
      email: 'bob@example.test',
    });
    const as = (email: string | null) => {
      const headers: Record<string, string> = {};
      if (email) {
        headers['x-srenautix-on-behalf-of'] = email;
      }
      return { token: TOKENS.grafana, headers };
    };
    const got = await api('GET', `/v1/incidents/${incidentId}`, as('alice@example.test'));
    expect(got.status).toBe(200);
    conform('/v1/incidents/{incident_ref}', 'get', got);
    expect((await api('GET', `/v1/incidents/${incidentId}`, as(null))).status).toBe(403);
    expect((await api('GET', `/v1/incidents/${incidentId}`, as('nobody@example.test'))).status).toBe(403);
    // 映射到的用户没有读取权限
    expect((await api('GET', `/v1/incidents/${incidentId}`, as('bob@example.test'))).status).toBe(403);

    const inc = got.body as unknown as { components: string[] };
    const fb = await api('POST', `/v1/incidents/${incidentId}/feedback`, {
      ...as('alice@example.test'),
      body: {
        research_run_id: null,
        verdict: 'confirmed',
        root_component: inc.components[0],
        disposition_verdict: null,
        disposition: null,
        mechanism: null,
        reason: null,
      },
    });
    expect(fb.status).toBe(201);
    conform('/v1/incidents/{incident_ref}/feedback', 'post', fb);
    expect(fb.body).toMatchObject({ channel: 'grafana', principal_id: 'oidc:alice' });
    // 其余写操作一律拒绝，即使用户的角色允许
    const research = await api('POST', `/v1/incidents/${incidentId}/research`, {
      ...as('alice@example.test'),
      body: {},
    });
    expect(research.status).toBe(403);
  });

  it('控制台静态文件：资源长期缓存，前端路由返回 index.html 并带 CSP，接口路径不回落到前端', async () => {
    const asset = await fetch(`${srv.apiUrl}/assets/index-3f9a1c.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await asset.text()).toBe('console.log(1)');

    const icon = await fetch(`${srv.apiUrl}/favicon.svg`);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('no-cache');

    for (const path of ['/', `/incidents/${incidentId}`, '/settings/packs?tab=lock']) {
      const page = await fetch(`${srv.apiUrl}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('content-security-policy')).toContain("style-src 'self' 'unsafe-inline'");
      expect(await page.text()).toContain('<div id="root">');
    }
    expect((await fetch(`${srv.apiUrl}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${srv.apiUrl}/assets/..%2f..%2fcallers.yaml`)).status).toBe(404);
    const unknownApi = await fetch(`${srv.apiUrl}/v1/no-such-endpoint`);
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers.get('content-type')).toMatch(/^application\/json/);
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
