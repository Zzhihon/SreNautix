import { generateKeyPairSync } from 'node:crypto';
import { cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { fileWriter, sha256 } from '../support/worker-hub.js';

/**
 * 主动优化的接口（ADR 0146 §5.1）：真实的 server 与 PG，领域包为测试包 optdb。下达目标只能引用领域包的指标与领域，
 * 参数与预算按契约与指标 schema 校验（不能提交自由查询）；每个主体每天最多 5 个目标、每个集群最多 10 个未结束的目标；
 * 取消、运行列表与发现、建议、目录；响应都符合 openapi。
 */
const PUBLIC = 'https://srenautix.example.test';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `optimization-api-${process.pid}`);
const TOKENS = { ingest: 'ingest-token-optimization-0123', external: 'external-token-optimization-012' };
const file = fileWriter(ROOT);
const OPTDB = resolve(import.meta.dirname, '../fixtures/packs/optdb');

let db: TestDb;
let srv: ServerHandle;
let cookie = '';
let csrf = '';

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const res = await fetch(`${srv.apiUrl}${path}`, {
    method,
    headers: bearer
      ? { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }
      : {
          cookie: `__Host-srenautix_session=${cookie}`,
          ...(method === 'GET' ? {} : { origin: PUBLIC, 'x-csrf-token': csrf, 'content-type': 'application/json' }),
        },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

const goal = (over: Record<string, unknown> = {}) => ({
  cluster_id: 'c1',
  subject: {
    type: 'indicator',
    indicator: 'optdb/db-time',
    params: { database: 'cchp' },
    scope: { components: ['Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres'], namespaces: [] },
  },
  objective: { comparator: 'lt', target: 0.3, unit: 'per_second', statistic: 'p95', window: '7d' },
  outputs: ['business_issue'],
  ...over,
});

beforeAll(async () => {
  db = await newTestDb();
  cpSync(OPTDB, join(ROOT, 'packs', 'optdb'), { recursive: true });
  const totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  const ed = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  srv = await buildServer({
    config: parseServerConfig({
      cluster_id: 'c1',
      profile: 'standard',
      log_level: 'warn',
      public_url: PUBLIC,
      policies_dir: resolve(
        file('policies/c1.yaml', stringify({ version: 1, cluster: 'c1', actions: [], approvers: [] })),
        '..',
      ),
      ingest: {
        sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', TOKENS.ingest) }],
        reconcile: { enabled: false },
      },
      packs: { dirs: [join(ROOT, 'packs')], only: ['optdb'] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: { source: 'off' },
      optimization: { enabled: true },
      approvals: { signing_key_file: file('signing.pem', ed()), key_id: 'k' },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({
            callers: [
              {
                id: 'ext-api',
                kind: 'external',
                channel: 'api',
                actions: ['gitops_pr'],
                namespaces: ['shop'],
                token_sha256: sha256(TOKENS.external),
              },
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
            'bindings/b.yaml',
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
      audit: { checkpoint_key_file: file('checkpoint.pem', ed()) },
    }),
    pg: db.serverConfig,
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: 0 },
  });
  const login = await fetch(`${srv.apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery', totp: totp.generate() }),
  });
  cookie = /__Host-srenautix_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  csrf = ((await login.json()) as { csrf_token: string }).csrf_token;
}, 120_000);

afterAll(async () => {
  await srv?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('目标接口', () => {
  let goalId = '';

  it('目录只含领域包的指标与领域', async () => {
    const r = await api('GET', '/v1/optimization/catalog');
    expect(r.status).toBe(200);
    expect(responseErrors('/v1/optimization/catalog', 'get', 200, r.body)).toBeNull();
    expect((r.body.indicators as Array<{ id: string }>).map((x) => x.id)).toEqual(['optdb/db-time', 'optdb/xact']);
  });

  it('下达指标目标：入队、写治理审计与事件；读取、列表与运行列表符合契约', async () => {
    const r = await api('POST', '/v1/goals', goal());
    expect(r.status).toBe(201);
    expect(responseErrors('/v1/goals', 'post', 201, r.body)).toBeNull();
    goalId = r.body.goal_id as string;
    expect(r.body).toMatchObject({
      state: 'queued',
      revision: 1,
      spec: { origin: { kind: 'manual', channel: 'console' }, budget: { tokens: 400000, dbstats_queries: 30 } },
      last_run: { state: 'queued', goal_revision: 1 },
    });
    const one = await api('GET', `/v1/goals/${goalId}`);
    expect(responseErrors('/v1/goals/{goal_id}', 'get', 200, one.body)).toBeNull();
    const list = await api('GET', '/v1/goals?open=true');
    expect(responseErrors('/v1/goals', 'get', 200, list.body)).toBeNull();
    expect((list.body.items as Array<{ goal_id: string }>).map((g) => g.goal_id)).toContain(goalId);
    const runs = await api('GET', `/v1/goals/${goalId}/runs`);
    expect(responseErrors('/v1/goals/{goal_id}/runs', 'get', 200, runs.body)).toBeNull();
    const runId = (runs.body as unknown as Array<{ run_id: string }>)[0]!.run_id;
    const detail = await api('GET', `/v1/goals/${goalId}/runs/${runId}`);
    expect(responseErrors('/v1/goals/{goal_id}/runs/{run_id}', 'get', 200, detail.body)).toBeNull();
    expect(detail.body.output).toBeNull();
    const audit = await db.admin.query(
      "SELECT 1 FROM server.governance_audit WHERE kind = 'optimization.goal_created'",
    );
    expect(audit.rowCount).toBe(1);
    const ev = await db.admin.query("SELECT payload FROM server.outbox WHERE type = 'goal.created'");
    expect(ev.rows[0]?.payload).toMatchObject({ goal_id: goalId });
  });

  it('不能提交自由查询、未知指标或不合法的参数与预算', async () => {
    const subject = goal().subject;
    for (const [body, pattern] of [
      [goal({ subject: { ...subject, indicator: 'optdb/unknown' } }), /没有指标/],
      [goal({ subject: { ...subject, params: { database: 'x"} or vector(1)' } } }), /参数不合法/],
      [goal({ subject: { ...subject, params: { promql: 'up' } } }), /参数不合法/],
      [goal({ query: 'sum(rate(x[5m]))' }), /must NOT have additional properties/],
      [goal({ subject: { ...subject, sql: 'SELECT * FROM usage_logs' } }), /must/],
      [goal({ budget: { dbstats_queries: 1000 } }), /must be <= 60/],
      [goal({ outputs: ['ops_pr', 'shell'] }), /must be equal to one of the allowed values/],
    ] as Array<[unknown, RegExp]>) {
      const r = await api('POST', '/v1/goals', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.message).toMatch(pattern);
    }
  });

  it('外部 API 调用方只能为它的命名空间下达目标', async () => {
    const r = await api('POST', '/v1/goals', goal(), TOKENS.external);
    expect(r.status).toBe(403);
    const ok = await api(
      'POST',
      '/v1/goals',
      goal({
        subject: { type: 'domain', domain: 'database', scope: { components: [], namespaces: ['shop'] } },
        objective: null,
      }),
      TOKENS.external,
    );
    expect(ok.status).toBe(201);
    expect(ok.body.spec).toMatchObject({ origin: { kind: 'manual', channel: 'api', principal: 'ext-api' } });
  });

  it('每个主体每天最多 5 个目标', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await api('POST', '/v1/goals', goal())).status).toBe(201);
    }
    const r = await api('POST', '/v1/goals', goal());
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('goal_limit');
  });

  it('取消未结束的目标：排队的运行一并取消；再取消返回 409', async () => {
    const r = await api('POST', `/v1/goals/${goalId}/cancel`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'cancelled', state_reason: 'user', last_run: { state: 'cancelled' } });
    expect((await api('POST', `/v1/goals/${goalId}/cancel`, {})).status).toBe(409);
  });

  it('发现与建议的列表符合契约', async () => {
    const f = await api('GET', '/v1/findings?domain=database');
    expect(f.status).toBe(200);
    expect(responseErrors('/v1/findings', 'get', 200, f.body)).toBeNull();
    const r = await api('GET', `/v1/recommendations?goal_id=${goalId}`);
    expect(responseErrors('/v1/recommendations', 'get', 200, r.body)).toBeNull();
  });
});
