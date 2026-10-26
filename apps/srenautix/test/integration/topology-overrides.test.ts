import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AlertCatalog } from '@srenautix/core';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { HttpError } from '../../src/api/errors.js';
import { fingerprint, identityLabels } from '../../src/ingest/normalize.js';
import { IngestService } from '../../src/ingest/service.js';
import { activeAlerts } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { applyPatch } from 'diff';
import type { Incident } from '@srenautix/contract';
import { GitHubApp } from '../../src/github/app.js';
import { planOverridePr, type OverrideRepo } from '../../src/topology/override-pr.js';
import { parseOverridesFile, TopologyOverrides } from '../../src/topology/overrides.js';
import { TopologyStore } from '../../src/topology/store.js';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { buildServer } from '../../src/roles/server.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { incident, stageA } from '../support/scenario.js';

/**
 * 拓扑覆盖：为未映射的告警开 PR（GitHub App 身份，内存中的 GitHub REST API），合并后 server 加载覆盖目录，
 * 告警按覆盖规则归属组件与角色（真实 PostgreSQL 与接入服务）。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `topology-overrides-${process.pid}`);
const REPO = 'acme/gitops';
const DIR = 'srenautix/topology-overrides';
const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = app.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const override = {
  cluster_id: 'prod',
  alertname: 'KafkaConsumerLag',
  component: 'Deployment:shop/orders-consumer',
  role: 'cause' as const,
};

let gh: FakeGitHub;
let db: TestDb;

const client = (over: Partial<ConstructorParameters<typeof GitHubApp>[0]> = {}) =>
  new GitHubApp({
    apiBase: gh.url,
    appId: '123456',
    installationId: '7890',
    privateKey: pem,
    ...over,
  });
const target = (over: Partial<OverrideRepo> = {}): OverrideRepo => ({
  repo: REPO,
  baseBranch: 'main',
  dir: DIR,
  ...over,
});

beforeAll(async () => {
  gh = new FakeGitHub('123456', '7890', app.publicKey, REPO);
  await gh.start();
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  mkdirSync(ROOT, { recursive: true });
});

afterAll(async () => {
  await gh?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const INCIDENT_ID = '7a1b2c3d-0000-4000-8000-0000000000e1';

/** 一个包含告警 alertname 的事件与它当前版本的阶段 A 报告 */
async function seedIncident(t: TestDb, alertname: string): Promise<void> {
  const base = incident();
  const inc: Incident = {
    ...base,
    incident_id: INCIDENT_ID,
    cluster_id: 'prod',
    label: `Deployment:edge/nginx:${base.first_firing_at}`,
    root: { ...base.root, component: 'Deployment:edge/nginx', entity: null },
    members: base.members.map((m) => ({ ...m, alertname })),
  };
  await t.admin.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, 'firing', $5, $6, $7, $8)`,
    [
      inc.incident_id,
      inc.cluster_id,
      inc.label,
      inc.incident_version,
      inc.severity,
      inc.first_firing_at,
      inc.root.component,
      JSON.stringify(inc),
    ],
  );
  const report = { ...stageA(), incident_id: inc.incident_id, incident_version: inc.incident_version };
  await t.admin.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body, first_firing_at, rendered_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, false, $5, $6, now())`,
    [
      inc.incident_id,
      inc.incident_version,
      report.disposition,
      report.evidence_fingerprint,
      JSON.stringify(report),
      inc.first_firing_at,
    ],
  );
}

/** 不是取令牌的请求里有没有写请求（server 对 Git 只读，ADR 0025、0108） */
const writes = (from = 0) => gh.requests.slice(from).filter((r) => r.method !== 'GET' && !r.path.startsWith('/app/'));

/** 把补丁应用到 main（模拟 gateway 开出 PR、审阅者合并） */
function merge(patch: string, path: string): void {
  const before = gh.branches.get('main')!.get(path) ?? '';
  const after = applyPatch(before, patch);
  expect(after).not.toBe(false);
  gh.write('main', { [path]: after as string }, { message: 'merge override PR' });
}

describe('拓扑覆盖 PR 的计划', () => {
  const PATH = `${DIR}/prod.yaml`;

  it('新文件：只读地生成新建文件的补丁与 srenautix/* 分支名，补丁应用后是合法的覆盖文件；不写 Git', async () => {
    const before = gh.requests.length;
    const plan = await planOverridePr(client(), target(), override, 'oidc:alice');
    expect(plan.branch).toMatch(/^srenautix\/topology-override-prod-kafkaconsumerlag-[0-9a-f]{8}$/);
    expect(plan.base).toBe(gh.heads.get('main'));
    expect(plan.patch).toContain('new file mode 100644\n--- /dev/null\n');
    expect(plan.body).toContain('oidc:alice');
    const file = applyPatch('', plan.patch) as string;
    expect(parseOverridesFile('prod.yaml', file)).toEqual({
      api_version: 'srenautix.io/topology-overrides/v1',
      alerts: [override],
    });
    expect(writes(before)).toEqual([]);
    expect(gh.branches.get('main')!.has(PATH)).toBe(false);
    merge(plan.patch, PATH);
  });

  it('基础分支已有这条规则：409；已有文件：追加规则，补丁基于当前内容', async () => {
    await expect(planOverridePr(client(), target(), override, 'oidc:alice')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('已有集群 prod'),
    });
    const second = {
      ...override,
      alertname: 'RedisEvictions',
      component: 'StatefulSet:cache/redis',
      role: 'symptom' as const,
    };
    const plan = await planOverridePr(client(), target(), second, 'oidc:bob');
    expect(plan.patch).not.toContain('new file mode');
    merge(plan.patch, PATH);
    const file = parseOverridesFile('prod.yaml', gh.branches.get('main')!.get(PATH)!);
    expect(file.alerts.map((a) => a.alertname)).toEqual(['KafkaConsumerLag', 'RedisEvictions']);
  });

  it('App 身份不对、没有仓库权限或 GitHub 不可达：503，说明原因', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;
    const third = { ...override, alertname: 'Third' };
    const cases: Array<[Partial<ConstructorParameters<typeof GitHubApp>[0]>, Partial<OverrideRepo>, RegExp]> = [
      [{ privateKey: other }, {}, /GitHub App 身份无效或没有安装到仓库/],
      [{ installationId: '1' }, {}, /GitHub App 身份无效或没有安装到仓库/],
      [{}, { repo: 'acme/other' }, /没有仓库 acme\/other 的权限/],
      [{}, { baseBranch: 'release' }, /分支 release 不存在/],
      [{ apiBase: 'http://127.0.0.1:9' }, {}, /GitHub 不可达/],
    ];
    for (const [over, repoOver, why] of cases) {
      const p = planOverridePr(client(over), target(repoOver), third, 'oidc:alice');
      await expect(p).rejects.toBeInstanceOf(HttpError);
      await expect(p).rejects.toMatchObject({ status: 503, message: expect.stringMatching(why) });
    }
  });
});

describe('控制台接口 POST /v1/topology/overrides/pr', () => {
  it('admin 发起：生成 gitops_pr 提议并由发起人批准，server 不写 Git；重复发起返回同一个提议；没有事件 409；未登录 401', async () => {
    const PUBLIC = 'https://srenautix.example.test';
    const file = (name: string, content: string) => {
      const p = join(ROOT, 'srv', name);
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, content);
      return p;
    };
    const totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
    const ed = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const srvDb = await newTestDb();
    const config = parseServerConfig({
      cluster_id: 'prod',
      profile: 'standard',
      log_level: 'warn',
      public_url: PUBLIC,
      policies_dir: resolve(
        file(
          'policies/prod.yaml',
          stringify({ version: 1, cluster: 'prod', actions: [{ id: 'gitops_pr' }], approvers: [] }),
        ),
        '..',
      ),
      packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: {
        source: 'off',
        overrides_dir: resolve(file('overrides/.keep', ''), '..'),
        // 2.5 版的写法（App 身份与仓库写在一起）：解析时迁移到 github_app 与 topology.override_pr
        override_pr: {
          github: {
            api_base: gh.url,
            app_id: '123456',
            installation_id: '7890',
            private_key_file: file('github-app.pem', pem),
            repo: REPO,
            dir: DIR,
          },
        },
      },
      approvals: { signing_key_file: file('signing.pem', ed()), key_id: 'k' },
      callers: { tokens_file: file('callers.yaml', stringify({ callers: [] })) },
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
    });
    const srv = await buildServer({
      config,
      pg: srvDb.serverConfig,
      noAuxListeners: true,
      apiListen: { host: '127.0.0.1', port: 0 },
    });
    try {
      const login = await fetch(`${srv.apiUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PUBLIC },
        body: JSON.stringify({ username: 'admin', password: 'correct horse battery', totp: totp.generate() }),
      });
      const cookie = /__Host-srenautix_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const csrf = ((await login.json()) as { csrf_token: string }).csrf_token;
      const post = (body: unknown, withSession = true) =>
        fetch(`${srv.apiUrl}/v1/topology/overrides/pr`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(withSession
              ? { cookie: `__Host-srenautix_session=${cookie}`, origin: PUBLIC, 'x-csrf-token': csrf }
              : {}),
          },
          body: JSON.stringify(body),
        });
      // 告警 NginxHighLatency 所在的事件（提议绑定它的版本、根因与阶段 A 的证据指纹）
      await seedIncident(srvDb, 'NginxHighLatency');
      const body = {
        cluster_id: 'prod',
        alertname: 'NginxHighLatency',
        component: 'Deployment:edge/nginx',
        role: 'symptom',
      };
      const before = gh.requests.length;
      const r = await post(body);
      const created = (await r.json()) as Record<string, unknown>;
      expect(r.status, JSON.stringify(created)).toBe(201);
      expect(responseErrors('/v1/topology/overrides/pr', 'post', 201, created)).toBeNull();
      expect(created).toMatchObject({
        state: 'approved',
        incident_id: INCIDENT_ID,
        approval_url: `${PUBLIC}/actions/${String(created.proposal_id)}`,
      });
      expect(created.branch).toMatch(/^srenautix\/topology-override-prod-nginxhighlatency-/);
      const p = await srvDb.admin.query<{ action: string; params: Record<string, string>; target: unknown }>(
        "SELECT action, params, body->'target' AS target FROM server.proposals WHERE proposal_id = $1",
        [created.proposal_id],
      );
      expect(p.rows[0]).toMatchObject({
        action: 'gitops_pr',
        params: { repository: REPO, base: 'main', branch: created.branch },
        target: { kind: 'GitRepository', name: REPO, uid: gh.heads.get('main') },
      });
      expect(applyPatch(gh.branches.get('main')!.get(`${DIR}/prod.yaml`) ?? '', p.rows[0]!.params.patch!)).toContain(
        'NginxHighLatency',
      );
      // server 不写 Git：PR 由 gateway 执行批准后的 gitops_pr 开出
      expect(writes(before)).toEqual([]);
      const again = await post(body);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { proposal_id: string }).proposal_id).toBe(created.proposal_id);
      const orphan = await post({ ...body, alertname: 'NeverFired' });
      expect(orphan.status).toBe(409);
      expect(((await orphan.json()) as { error: string }).error).toBe('no_incident');
      expect((await post(body, false)).status).toBe(401);
      const audit = await srvDb.admin.query<{ actor: string; data: { branch: string } }>(
        "SELECT actor, data FROM server.governance_audit WHERE kind = 'topology.override_pr'",
      );
      expect(audit.rows).toEqual([{ actor: 'local:admin', data: expect.objectContaining({ branch: created.branch }) }]);
    } finally {
      await srv.stop();
      await srvDb.close();
    }
  }, 120_000);
});

describe('拓扑覆盖的加载与告警归属', () => {
  it('合并后的覆盖文件：命中的告警归属覆盖的组件与角色；match_labels 更具体的规则优先；告警自带 role 标签仍然优先', async () => {
    const dir = join(ROOT, 'overrides');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prod.yaml'), gh.branches.get('main')!.get(`${DIR}/prod.yaml`)!);
    writeFileSync(
      join(dir, 'prod-topics.yaml'),
      [
        'api_version: srenautix.io/topology-overrides/v1',
        'alerts:',
        '  - cluster_id: prod',
        '    alertname: KafkaConsumerLag',
        '    match_labels: { topic: payments }',
        '    component: Deployment:pay/payments-consumer',
        '    role: symptom',
        '',
      ].join('\n'),
    );
    const overrides = TopologyOverrides.load(dir);
    // prod.yaml 里合并了两条规则（KafkaConsumerLag、RedisEvictions），prod-topics.yaml 一条
    expect(overrides.size).toBe(3);
    const tokenFile = join(ROOT, 'ingest-token');
    writeFileSync(tokenFile, 'ingest-token-overrides-0123456789');
    const ingest = new IngestService(
      db.server,
      [{ id: 'am', kind: 'alertmanager', token_file: tokenFile }],
      { clusterId: 'prod', selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
      {
        catalog: new AlertCatalog([]),
        nodes: new TopologyStore(db.server),
        ksm: null,
        ruleExpr: () => undefined,
        chronic: () => false,
        override: (clusterId, labels) => overrides.match(clusterId, labels),
      },
      new ServerMetrics('server', false),
      () => {
        throw new Error('测试中状态库一直可用');
      },
    );
    const at = new Date(Date.now() - 60_000);
    const raw = (alertname: string, extra: Record<string, string>) => {
      const labels = { alertname, namespace: 'shop', ...extra };
      return {
        source: 'alertmanager' as const,
        labels,
        annotations: {},
        severity: 'warning' as const,
        status: 'firing' as const,
        suppressed: 'none' as const,
        startsAt: at,
        endsAt: null,
        generatorUrl: null,
        fingerprint: fingerprint(identityLabels(labels)),
        alertname,
        alertmanagerSeenAt: at,
      };
    };
    await ingest.write(
      'prod',
      'am',
      'alertmanager',
      [
        raw('KafkaConsumerLag', { topic: 'orders' }),
        raw('KafkaConsumerLag', { topic: 'payments' }),
        raw('KafkaConsumerLag', { topic: 'audit', role: 'meta' }),
        raw('Unmapped', {}),
      ],
      {},
    );
    const alerts = await activeAlerts(db.server, 'prod', 0);
    const view = alerts
      .map((a) => [a.labels.topic ?? a.alertname, a.component, a.classification.role, a.classification.catalog_entry])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    expect(view).toEqual([
      ['audit', 'Deployment:shop/orders-consumer', 'meta', null],
      ['orders', 'Deployment:shop/orders-consumer', 'cause', 'topology-overrides/prod.yaml#0'],
      ['payments', 'Deployment:pay/payments-consumer', 'symptom', 'topology-overrides/prod-topics.yaml#0'],
      ['Unmapped', 'Namespace:shop', 'symptom', null],
    ]);
    // 其他集群不受影响
    expect(overrides.match('staging', { alertname: 'KafkaConsumerLag' })).toBeNull();
  });

  it('覆盖文件不合法时加载报错并指出文件与字段', () => {
    const dir = join(ROOT, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'x.yaml'),
      'api_version: srenautix.io/topology-overrides/v1\nalerts:\n  - { cluster_id: prod, alertname: A, component: nope, role: cause }\n',
    );
    expect(() => TopologyOverrides.load(dir)).toThrow(/拓扑覆盖文件 x\.yaml 不合法：alerts\.0\.component/);
  });
});
