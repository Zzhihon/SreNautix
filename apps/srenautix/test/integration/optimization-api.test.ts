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
 * 主动优化运行时已退役：保留 OpenAPI 兼容的只读空响应与写接口 503/404，保留数据库迁移轨道（optimization v1-v3）与鉴权。
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
      optimization: { enabled: false },
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

describe('目标接口（主动优化退役后的兼容桩）', () => {
  it('保留数据库 optimization 迁移轨道（v1-v3）不破坏历史表结构', async () => {
    const r = await db.admin.query<{ version: number }>(
      "SELECT version FROM server.schema_migrations WHERE track = 'optimization' ORDER BY version",
    );
    expect(r.rows.map((x) => x.version)).toEqual([1, 2, 3]);
  });

  it('未鉴权请求返回 401', async () => {
    const res = await fetch(`${srv.apiUrl}/v1/goals`);
    expect(res.status).toBe(401);
  });

  it('只读列表与目录接口返回空结果且符合 openapi 契约', async () => {
    const cat = await api('GET', '/v1/optimization/catalog');
    expect(cat.status).toBe(200);
    expect(responseErrors('/v1/optimization/catalog', 'get', 200, cat.body)).toBeNull();
    expect(cat.body).toEqual({ indicators: [], domains: [] });

    const goals = await api('GET', '/v1/goals?open=true');
    expect(goals.status).toBe(200);
    expect(responseErrors('/v1/goals', 'get', 200, goals.body)).toBeNull();
    expect(goals.body).toEqual({ items: [], next_cursor: null });

    const findings = await api('GET', '/v1/findings?domain=database');
    expect(findings.status).toBe(200);
    expect(responseErrors('/v1/findings', 'get', 200, findings.body)).toBeNull();
    expect(findings.body).toEqual({ items: [], next_cursor: null });

    const recs = await api('GET', '/v1/recommendations');
    expect(recs.status).toBe(200);
    expect(responseErrors('/v1/recommendations', 'get', 200, recs.body)).toBeNull();
    expect(recs.body).toEqual({ items: [], next_cursor: null });
  });

  it('POST /v1/goals 返回 503，详情与取消/拒绝接口返回 404', async () => {
    const created = await api('POST', '/v1/goals', goal());
    expect(created.status).toBe(503);
    expect(created.body.error).toBe('unavailable');

    const createdExt = await api('POST', '/v1/goals', goal(), TOKENS.external);
    expect(createdExt.status).toBe(503);

    expect((await api('GET', '/v1/goals/g-missing')).status).toBe(404);
    expect((await api('GET', '/v1/goals/g-missing/runs')).status).toBe(404);
    expect((await api('GET', '/v1/goals/g-missing/runs/r-missing')).status).toBe(404);
    expect((await api('POST', '/v1/goals/g-missing/cancel', {})).status).toBe(404);
    expect((await api('POST', '/v1/recommendations/rec-missing/reject', {})).status).toBe(404);
  });
});
