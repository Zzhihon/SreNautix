import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { buildMcpRole, parseMcpConfig, type McpHandle } from '../../src/roles/mcp.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { freePort, until } from '../support/monitoring.js';
import { startAs, type TestAs } from '../support/oauth-as.js';

/**
 * mcp 角色：真实 OAuth 授权服务器（client_credentials + RFC 8707）、真实 server 与 PostgreSQL、MCP SDK 客户端。
 * 外部 Agent 只能读取与提议；令牌必须绑定到本服务的受众；每个调用方独立限速与熔断。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `mcp-${process.pid}`);
const TOKENS = {
  ingest: 'ingest-token-mcp-0123456789abcdef',
  holmes: 'holmes-hub-token-0123456789abcdef',
  other: 'other-hub-token-0123456789abcdef',
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let db: TestDb;
let srv: ServerHandle;
let as: TestAs;
let mcp: McpHandle;
let resourceUrl = '';
let incidentId = '';

const file = (name: string, content: string) => {
  const p = join(ROOT, name);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

async function connect(token: string | null, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resourceUrl), {
      requestInit: { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const text = ((r.content as Array<{ text?: string }>)[0]?.text ?? '') as string;
  return { isError: r.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const at = new Date(Date.now() - 3600_000);
  await topo.apply('c1', [
    {
      op: 'node_upsert',
      at,
      source: 'informer',
      node: {
        key: 'Deployment:shop/api',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'api',
        uid: 'uid-deploy-api',
        labels: {},
        component_type: null,
        hub: false,
      },
    },
    {
      op: 'node_upsert',
      at,
      source: 'informer',
      node: {
        key: 'Pod:shop/api-7d9f8-x2k4p',
        kind: 'Pod',
        namespace: 'shop',
        name: 'api-7d9f8-x2k4p',
        uid: 'uid-pod-api',
        labels: {},
        component_type: null,
        hub: false,
      },
    },
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
  const signing = generateKeyPairSync('ed25519');
  const checkpoint = generateKeyPairSync('ed25519');
  srv = await buildServer({
    config: parseServerConfig({
      cluster_id: 'c1',
      profile: 'standard',
      log_level: 'warn',
      public_url: 'https://srenautix.example.test',
      policies_dir: resolve(
        file(
          'policies/c1.yaml',
          stringify({
            version: 1,
            cluster: 'c1',
            actions: [{ id: 'workload_scale', namespaces: ['shop'] }],
            approvers: [],
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
      approvals: {
        signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
        key_id: 'mcp-test',
      },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({
            callers: [
              {
                id: 'holmes',
                kind: 'external',
                channel: 'mcp',
                actions: ['workload_scale'],
                namespaces: ['shop'],
                proposals_per_hour: 30,
                token_sha256: sha(TOKENS.holmes),
              },
              {
                id: 'other',
                kind: 'external',
                channel: 'mcp',
                actions: ['workload_scale'],
                namespaces: ['other-ns'],
                proposals_per_hour: 30,
                token_sha256: sha(TOKENS.other),
              },
            ],
          }),
        ),
      },
      identity: {
        local_admin: {
          username: 'admin',
          password_hash_file: file('admin.hash', await hashPassword('correct horse battery')),
          totp_secret_file: file('admin.totp', 'JBSWY3DPEHPK3PXP'),
        },
        bindings_dir: resolve(file('bindings/x.yaml', stringify({ bindings: [] })), '..'),
      },
      audit: {
        checkpoint_key_file: file(
          'checkpoint.pem',
          checkpoint.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        ),
      },
    }),
    pg: db.serverConfig,
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: 0 },
  });
  const body = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json'), 'utf8'),
  ) as { alerts: Array<{ startsAt: string }> };
  (body.alerts[0] as { startsAt: string }).startsAt = new Date(Date.now() - 30_000).toISOString();
  await fetch(`${srv.apiUrl}/v1/ingest/am`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKENS.ingest}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  incidentId = await until('事件出现', async () => {
    const r = await db.admin.query<{ incident_id: string }>('SELECT incident_id FROM server.stage_a_reports LIMIT 1');
    return r.rows[0]?.incident_id;
  });

  const port = await freePort();
  resourceUrl = `http://127.0.0.1:${port}/mcp`;
  as = await startAs(
    [
      { client_id: 'holmes', client_secret: 'holmes-client-secret-for-tests-0123' },
      { client_id: 'other', client_secret: 'other-client-secret-for-tests-01234' },
      { client_id: 'stranger', client_secret: 'stranger-client-secret-for-tests-01' },
    ],
    [resourceUrl, 'http://127.0.0.1:1/another-api'],
  );
  mcp = await buildMcpRole(
    parseMcpConfig({
      enabled: true,
      log_level: 'warn',
      public_url: resourceUrl,
      authorization_server: as.issuer,
      allowed_origins: ['https://console.example.test'],
      hub_url: srv.apiUrl,
      clients: [
        {
          client_id: 'holmes',
          hub_token_file: file('holmes-token', TOKENS.holmes),
          reads_per_minute: 30,
          proposals_per_hour: 20,
          rejection_threshold: 3,
        },
        {
          client_id: 'other',
          hub_token_file: file('other-token', TOKENS.other),
          reads_per_minute: 2,
          proposals_per_hour: 20,
        },
      ],
    }),
    { host: '127.0.0.1', port },
    true,
  );
}, 120_000);

afterAll(async () => {
  await mcp?.stop();
  await as?.close();
  await srv?.stop();
  await db?.close();
});

describe('mcp 角色', () => {
  it('没有令牌：401，WWW-Authenticate 指向受保护资源元数据；元数据给出授权服务器', async () => {
    const r = await fetch(resourceUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    const h = r.headers.get('www-authenticate') ?? '';
    expect(h).toMatch(
      /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    const meta = (await (await fetch(/resource_metadata="([^"]+)"/.exec(h)?.[1] as string)).json()) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      resource: resourceUrl,
      authorization_servers: [as.issuer],
      scopes_supported: ['srenautix:read', 'srenautix:propose'],
    });
  });

  it('受众绑定：签给其他资源的令牌被拒绝；未登记的客户端被拒绝', async () => {
    const wrongAud = await as.token('holmes', 'http://127.0.0.1:1/another-api', 'srenautix:read');
    await expect(connect(wrongAud)).rejects.toThrow();
    const stranger = await as.token('stranger', resourceUrl, 'srenautix:read');
    const r = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stranger}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(403);
  });

  it('不允许的 Origin：403', async () => {
    const t = await as.token('holmes', resourceUrl, 'srenautix:read');
    const r = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('工具只有读取与提议，名称带版本号；读取结果把文本移入 untrusted_text', async () => {
    const t = await as.token('holmes', resourceUrl, 'srenautix:read');
    const c = await connect(t);
    const tools = (await c.listTools()).tools.map((x) => x.name).sort();
    expect(tools).toEqual(['get_incident_v1', 'list_actions_v1', 'list_incidents_v1', 'propose_action_v1']);
    const r = await call(c, 'get_incident_v1', { incident: incidentId });
    expect(r.isError).toBe(false);
    const untrusted = r.body.untrusted_text as Array<{ path: string; text: string }>;
    // 时间线文字含告警名（来自告警源，不可信）：移入 untrusted_text，原位置是引用
    const tl = untrusted.find((u) => u.path === '/stage_a/timeline/0/text');
    expect(tl?.text).toContain('DemoPodCrashLooping');
    const data = r.body.data as {
      stage_a: { timeline: Array<{ text: unknown }> };
      research: Array<{ reason: string }>;
    };
    expect(data.stage_a.timeline[0]?.text).toEqual({ untrusted_ref: (tl as { ref: number } & typeof tl).ref });
    expect(data.research[0]?.reason).toBe('new_incident');
    // 只有读取作用域的令牌不能提议
    const p = await call(c, 'propose_action_v1', {
      incident: incidentId,
      action: 'workload_scale',
      params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: 3 },
      expected_effect: 'x',
    }).catch((e: Error) => ({ isError: true, body: { error: e.message } }));
    expect(p.isError).toBe(true);
    expect(JSON.stringify(p.body)).toMatch(/srenautix:propose/);
    await c.close();
  });

  it('提议进入审批流程，同一调用方的重复提议被去重；中心按调用方的命名空间授权', async () => {
    const t = await as.token('holmes', resourceUrl, 'srenautix:read srenautix:propose');
    const c = await connect(t);
    const args = {
      incident: incidentId,
      action: 'workload_scale',
      params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: 3 },
      expected_effect: '扩容后错误率下降',
    };
    const a = await call(c, 'propose_action_v1', args);
    const b = await call(c, 'propose_action_v1', args);
    expect(a.isError).toBe(false);
    const pa = (a.body.data as { proposal: { proposal_id: string; state: string; source: string } }).proposal;
    const pb = (b.body.data as { proposal: { proposal_id: string } }).proposal;
    expect(pa.proposal_id).toBe(pb.proposal_id);
    expect(pa.state).toBe('awaiting_approval');
    const rows = await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM server.proposals');
    expect(rows.rows[0]?.n).toBe(1);
    await c.close();

    const ot = await as.token('other', resourceUrl, 'srenautix:read srenautix:propose');
    const oc = await connect(ot);
    const denied = await call(oc, 'propose_action_v1', args);
    expect(denied.isError).toBe(true);
    expect(String(denied.body.error)).toMatch(/HTTP 40[34]/);
    await oc.close();
  });

  it('每个调用方独立限速；多次被拒绝的调用方被熔断', async () => {
    const ot = await as.token('other', resourceUrl, 'srenautix:read');
    const oc = await connect(ot);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push((await call(oc, 'list_incidents_v1', {})).isError);
    }
    // reads_per_minute=2：桶容量 2，第三次超限
    expect(outcomes).toEqual([false, false, true]);
    await oc.close();

    const t = await as.token('holmes', resourceUrl, 'srenautix:read srenautix:propose');
    const c = await connect(t);
    const bad = {
      incident: incidentId,
      action: 'workload_scale',
      params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: -1 },
      expected_effect: 'x',
    };
    for (let i = 0; i < 3; i++) {
      const r = await call(c, 'propose_action_v1', { ...bad, params: { ...bad.params, replicas: -1 - i } });
      expect(r.isError, JSON.stringify(r.body)).toBe(true);
    }
    const blocked = await call(c, 'list_incidents_v1', {});
    expect(blocked.isError).toBe(true);
    expect(String(blocked.body.error)).toMatch(/熔断/);
    await c.close();
  });
});
