import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { keyringFrom, publicKeyB64u, verifyEnvelope } from '../../src/proposals/assertion.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { until } from '../support/monitoring.js';
import { fileWriter, seedShopTopology, sha256 } from '../support/worker-hub.js';

/**
 * 合规配置 H 档的通行密钥审批（DESIGN §13、ADR 0020 第 4 条）：真实的 server 与 PG，审批人的通行密钥由测试中的
 * 软件认证器（Ed25519，COSE -8）模拟：按 WebAuthn 的格式构造 authenticatorData 与 clientDataJSON 并签名。
 * 外部调用方对 SreNautix 自身依赖的命名空间提议扩容（按不可逆加 H 档），本地管理员审批。
 */
const PUBLIC = 'https://srenautix.example.test';
const RP_ID = 'srenautix.example.test';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `approve-webauthn-${process.pid}`);
const TOKENS = { ingest: 'ingest-token-webauthn-0123456789', external: 'external-token-webauthn-0123456789' };
const file = fileWriter(ROOT);

let db: TestDb;
let srv: ServerHandle;
let cookie = '';
let csrf = '';
let passkey: { id: string; key: KeyObject };
let edKey: { id: string; key: KeyObject };
let keysFile = '';
let replicas = 3;

/** 软件认证器：对 options 的挑战签名，返回 PublicKeyCredential 的 JSON（WebAuthn L3 toJSON）。 */
function authenticate(
  options: { challenge: string; rpId: string },
  over: { origin?: string; flags?: number; id?: string; key?: KeyObject; type?: string; crossOrigin?: boolean } = {},
) {
  const clientData = Buffer.from(
    JSON.stringify({
      type: over.type ?? 'webauthn.get',
      challenge: options.challenge,
      origin: over.origin ?? PUBLIC,
      crossOrigin: over.crossOrigin ?? false,
    }),
  );
  const authData = Buffer.concat([
    createHash('sha256').update(options.rpId).digest(),
    Buffer.from([over.flags ?? 0x05]), // UP | UV
    Buffer.from([0, 0, 0, 7]), // signCount
  ]);
  const key = over.key ?? passkey.key;
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
  // ES256：DER 编码的 ECDSA 签名（平台认证器的格式）；EdDSA：64 字节签名
  const signature =
    key.asymmetricKeyType === 'ec' ? sign('sha256', signed, { key, dsaEncoding: 'der' }) : sign(null, signed, key);
  const id = over.id ?? passkey.id;
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
      userHandle: null,
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const res = await fetch(`${srv.apiUrl}${path}`, {
    method,
    headers: bearer
      ? { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }
      : {
          accept: 'application/json',
          cookie: `__Host-srenautix_session=${cookie}`,
          ...(method === 'GET' ? {} : { origin: PUBLIC, 'x-csrf-token': csrf, 'content-type': 'application/json' }),
        },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

let incidentId = '';

/** 外部调用方提议扩容 shop/api（shop 是 SreNautix 自身依赖的命名空间，按不可逆加 H 档）。 */
async function proposeH(): Promise<{ proposal_id: string; target: { display: string } }> {
  const inc = (await api('GET', `/v1/incidents/${incidentId}`)).body as {
    incident_version: number;
    root: { component: string };
  };
  const sa = (await api('GET', `/v1/incidents/${incidentId}/stage-a`)).body as { evidence_fingerprint: string };
  const r = await api(
    'POST',
    '/v1/proposals',
    {
      incident_id: incidentId,
      binding: {
        incident_version: inc.incident_version,
        root_component: inc.root.component,
        evidence_fingerprint: sa.evidence_fingerprint,
      },
      action: 'workload_scale',
      params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: ++replicas },
      research_run_id: null,
      rule_id: null,
      hypothesis_id: null,
      evidence_refs: [],
      expected_effect: '扩容后错误率下降',
    },
    TOKENS.external,
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body).toMatchObject({ state: 'awaiting_approval', tier: 'H', level: 'irreversible' });
  return r.body as unknown as { proposal_id: string; target: { display: string } };
}

beforeAll(async () => {
  db = await newTestDb();
  await seedShopTopology(db);
  const totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  const signing = generateKeyPairSync('ed25519');
  const checkpoint = generateKeyPairSync('ed25519');
  // 主要的凭据是 ES256（常见的平台通行密钥）；另登记一个 EdDSA 的安全密钥
  const pk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  passkey = { id: Buffer.from('passkey-admin-1').toString('base64url'), key: pk.privateKey };
  const ed = generateKeyPairSync('ed25519');
  edKey = { id: Buffer.from('security-key-admin').toString('base64url'), key: ed.privateKey };
  const point = pk.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  keysFile = file(
    'approver-keys.yaml',
    stringify({
      version: 1,
      webauthn: { rp_id: RP_ID, origins: [PUBLIC] },
      keys: [
        { use: 'service', key_id: 'svc', public_key: publicKeyB64u(signing.publicKey) },
        {
          use: 'webauthn',
          credential_id: passkey.id,
          principal: 'local:admin',
          alg: 'ES256',
          public_key: Buffer.concat([
            Buffer.from([4]),
            Buffer.from(point.x, 'base64url'),
            Buffer.from(point.y, 'base64url'),
          ]).toString('base64url'),
        },
        {
          use: 'webauthn',
          credential_id: edKey.id,
          principal: 'local:admin',
          public_key: publicKeyB64u(ed.publicKey),
        },
      ],
    }),
  );
  srv = await buildServer({
    config: parseServerConfig({
      cluster_id: 'c1',
      profile: 'compliance',
      log_level: 'warn',
      public_url: PUBLIC,
      policies_dir: resolve(
        file(
          'policies/c1.yaml',
          stringify({
            version: 1,
            cluster: 'c1',
            actions: [{ id: 'workload_scale', namespaces: ['shop'] }],
            self_dependencies: { namespaces: ['shop'] },
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
      approvals: {
        signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
        key_id: 'svc',
        approver_keys_file: keysFile,
      },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({
            callers: [
              {
                id: 'ext-api',
                kind: 'external',
                channel: 'api',
                actions: ['workload_scale'],
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
  expect(login.status).toBe(200);
  cookie = /__Host-srenautix_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  csrf = ((await login.json()) as { csrf_token: string }).csrf_token;

  const body = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json'), 'utf8'),
  ) as { alerts: Array<{ startsAt: string }> };
  body.alerts[0]!.startsAt = new Date(Date.now() - 30_000).toISOString();
  const r = await fetch(`${srv.apiUrl}/v1/ingest/am`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKENS.ingest}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  incidentId = await until('事件与阶段 A 报告', async () => {
    const q = await db.admin.query<{ incident_id: string }>(
      'SELECT incident_id FROM server.stage_a_reports ORDER BY incident_version DESC LIMIT 1',
    );
    return q.rows[0]?.incident_id;
  });
}, 120_000);

afterAll(async () => {
  await srv?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('合规配置 H 档的通行密钥审批', () => {
  it('没有通行密钥断言时拒绝；挑战绑定待签名的断言；ES256 软件认证器签名后签发 webauthn 信封，gateway 规则校验通过', async () => {
    const p = await proposeH();
    const approve = (webauthn: unknown) =>
      api('POST', `/v1/proposals/${p.proposal_id}/approve`, { confirm_target: p.target.display, webauthn });

    const without = await approve(null);
    expect(without.status).toBe(403);
    expect(without.body).toMatchObject({ error: 'webauthn_required' });

    const opt = await api('POST', '/v1/auth/webauthn/assertion-options', { proposal_id: p.proposal_id });
    expect(opt.status, JSON.stringify(opt.body)).toBe(200);
    expect(responseErrors('/v1/auth/webauthn/assertion-options', 'post', 200, opt.body)).toBeNull();
    expect(opt.body).toMatchObject({
      rpId: RP_ID,
      userVerification: 'required',
      allowCredentials: [
        { type: 'public-key', id: passkey.id },
        { type: 'public-key', id: edKey.id },
      ],
    });
    const options = opt.body as { challenge: string; rpId: string };
    const stored = await db.admin.query<{ assertion: Record<string, unknown> }>(
      'SELECT assertion FROM server.webauthn_challenges WHERE challenge = $1',
      [options.challenge],
    );
    expect(stored.rows[0]?.assertion).toMatchObject({
      proposal_id: p.proposal_id,
      tier: 'H',
      approver_principal: 'local:admin',
      channel: 'console',
    });

    // 签名与 gateway 同一套规则：来源、UV 标志、未登记的凭据、错误的类型都被拒绝，挑战不因失败作废
    const other = generateKeyPairSync('ed25519');
    for (const [over, code] of [
      [{ origin: 'https://evil.example.test' }, 'webauthn_origin'],
      [{ flags: 0x01 }, 'webauthn_flags'],
      [{ id: Buffer.from('not-registered').toString('base64url') }, 'webauthn_unknown_credential'],
      [{ key: other.privateKey }, 'webauthn_bad_signature'],
      [{ type: 'webauthn.create' }, 'webauthn_bad_client_data'],
      [{ crossOrigin: true }, 'webauthn_cross_origin'],
      // 算法只取自登记的凭据：ES256 凭据上的 EdDSA 签名（来自同一审批人登记的另一把密钥）不能通过
      [{ key: edKey.key }, 'webauthn_bad_signature'],
    ] as const) {
      const r = await approve(authenticate(options, over));
      expect(r.status, code).toBe(403);
      expect(r.body).toMatchObject({ error: code });
    }
    const bad = await approve({ id: passkey.id, type: 'public-key', response: {} });
    expect(bad.status).toBe(400);

    const ok = await approve(authenticate(options));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(responseErrors('/v1/proposals/{proposal_id}/approve', 'post', 200, ok.body)).toBeNull();
    const env = ok.body.envelope as { assertion: Record<string, unknown>; proof: Record<string, unknown> };
    expect(env.proof).toMatchObject({ type: 'webauthn', credential_id: passkey.id });
    expect(env.assertion).toEqual(stored.rows[0]?.assertion);
    expect(ok.body.proposal).toMatchObject({ state: 'approved', approval: { principal_id: 'local:admin' } });
    // gateway 用同一份审批人公钥文件校验：合规配置只接受通行密钥签名的 H 档断言
    const keys = keyringFrom(parseYaml(readFileSync(keysFile, 'utf8')) as Parameters<typeof keyringFrom>[0]);
    expect(() => verifyEnvelope(env, keys, { requireWebAuthnForH: true })).not.toThrow();
    const audit = await db.admin.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'approval.issued' ORDER BY seq DESC LIMIT 1",
    );
    expect(audit.rows[0]?.data).toMatchObject({
      proposal_id: p.proposal_id,
      tier: 'H',
      proof: 'webauthn',
      credential_id: passkey.id,
    });
    const used = await db.admin.query<{ used_at: Date | null }>(
      'SELECT used_at FROM server.webauthn_challenges WHERE challenge = $1',
      [options.challenge],
    );
    expect(used.rows[0]?.used_at).not.toBeNull();
  });

  it('挑战只能用一次：被更新的挑战取代的旧挑战与已用过的挑战都被拒绝', async () => {
    const p = await proposeH();
    const approve = (webauthn: unknown) =>
      api('POST', `/v1/proposals/${p.proposal_id}/approve`, { confirm_target: p.target.display, webauthn });
    const first = (await api('POST', '/v1/auth/webauthn/assertion-options', { proposal_id: p.proposal_id })).body as {
      challenge: string;
      rpId: string;
    };
    // 断言里的 issued_at 到秒；隔一秒再请求，第二个挑战一定不同
    await new Promise((r) => setTimeout(r, 1_100));
    const second = (await api('POST', '/v1/auth/webauthn/assertion-options', { proposal_id: p.proposal_id })).body as {
      challenge: string;
      rpId: string;
    };
    expect(second.challenge).not.toBe(first.challenge);
    const stale = await approve(authenticate(first));
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: 'webauthn_challenge_unknown' });
    // 同一审批人的 EdDSA 安全密钥同样可以审批
    const edOk = await approve(authenticate(second, { id: edKey.id, key: edKey.key }));
    expect(edOk.status, JSON.stringify(edOk.body)).toBe(200);
    expect((edOk.body.envelope as { proof: { type: string; credential_id: string } }).proof).toMatchObject({
      type: 'webauthn',
      credential_id: edKey.id,
    });
    // 提议已批准：同一个签名再提交一次，在挑战之前就因提议状态被拒绝
    const replay = await approve(authenticate(second));
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ error: 'already_decided' });
  });

  it('挑战只发给控制台会话中的审批人；集成页报告通行密钥审批可用', async () => {
    const p = await proposeH();
    // 外部调用方（提议人）没有控制台会话
    const asProposer = await api(
      'POST',
      '/v1/auth/webauthn/assertion-options',
      { proposal_id: p.proposal_id },
      TOKENS.external,
    );
    expect(asProposer.status).toBe(403);
    const unknown = await api('POST', '/v1/auth/webauthn/assertion-options', {
      proposal_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(404);
    const t = await api('POST', '/v1/integrations/approve:console/test', {});
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect((t.body as { results: Array<{ capability: string; ok: boolean }> }).results).toContainEqual(
      expect.objectContaining({ capability: 'approve.h_tier', ok: true }),
    );
  });
});
