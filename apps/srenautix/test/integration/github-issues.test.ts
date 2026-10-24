import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { GitHubApp } from '../../src/github/app.js';
import { ServerMetrics } from '../../src/metrics.js';
import { withRefs } from '../../src/proposals/service.js';
import { GitOpsPulls } from '../../src/remediation/pulls.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { until } from '../support/monitoring.js';
import { fileWriter, seedShopTopology, sha256 } from '../support/worker-hub.js';

/**
 * 事件 issue（ADR 0095）：真实的 server 与 PG，GitHub 为测试中的假 API（App JWT 换安装令牌、issue、评论、PR）。
 * 去重（每个事件一个 issue，进展只追加评论）、限速（每小时上限之外只记录）、关联（PR 描述写 Refs、issue 回链 PR）与失败重试
 * （返回 5xx 时退避重试；开出或评论之后连接断开时按标记找回，不重复）。
 */
const PUBLIC = 'https://srenautix.example.test';
const REPO = 'acme/ops';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `github-issues-${process.pid}`);
const TOKENS = { ingest: 'ingest-token-issues-0123456789', external: 'external-token-issues-0123456789' };
const file = fileWriter(ROOT);
const app = generateKeyPairSync('rsa', { modulusLength: 2048 });

let gh: FakeGitHub;
let db: TestDb;
let srv: ServerHandle;
let cookie = '';
let csrf = '';
let incidentA = '';

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

const run = () => srv.issues!.runOnce();
const issueRow = async (id: string) =>
  (
    await db.admin.query<{
      state: string;
      number: number | null;
      attempts: number;
      last_error: string | null;
      body_hash: string | null;
    }>('SELECT state, number, attempts, last_error, body_hash FROM server.github_issues WHERE incident_id = $1', [id])
  ).rows[0];
/** 跳过退避，让到期的重试立即执行 */
const fastForward = () =>
  db.admin.query(
    `UPDATE server.github_issues SET next_attempt_at = now() WHERE state = 'pending';
     UPDATE server.github_issue_comments SET next_attempt_at = now() WHERE posted_at IS NULL`,
  );

/** 复制事件 A 为另一个集群里的新事件（不受本集群事件引擎对账影响），阶段 A 处置判断为 escalate */
async function cloneEscalated(label: string): Promise<string> {
  const id = randomUUID();
  await db.admin.query(
    `INSERT INTO server.incidents
       SELECT * FROM jsonb_populate_record(NULL::server.incidents, (SELECT to_jsonb(i) || jsonb_build_object(
         'incident_id', $2::uuid, 'cluster_id', 'c2', 'label', $3::text, 'updated_at', now(), 'state', 'firing', 'ended_at', NULL,
         'body', i.body || jsonb_build_object('incident_id', $2::uuid, 'cluster_id', 'c2', 'label', $3::text))
       FROM server.incidents i WHERE i.incident_id = $1))`,
    [incidentA, id, label],
  );
  await db.admin.query(
    `INSERT INTO server.stage_a_reports
       SELECT * FROM jsonb_populate_record(NULL::server.stage_a_reports, (SELECT to_jsonb(s) || jsonb_build_object(
         'report_id', gen_random_uuid(), 'incident_id', $2::uuid, 'disposition', 'escalate',
         'body', s.body || jsonb_build_object('incident_id', $2::uuid, 'disposition', 'escalate'))
       FROM server.stage_a_reports s WHERE s.incident_id = $1 ORDER BY s.incident_version DESC LIMIT 1))`,
    [incidentA, id],
  );
  return id;
}

beforeAll(async () => {
  gh = new FakeGitHub('424242', '99', app.publicKey, REPO);
  await gh.start();
  db = await newTestDb();
  await seedShopTopology(db);
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
      packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: {
        source: 'off',
        overrides_dir: resolve(file('overrides/.keep', ''), '..'),
        override_pr: { repo: REPO },
      },
      github_app: {
        api_base: gh.url,
        app_id: '424242',
        installation_id: '99',
        private_key_file: file('github-app.pem', app.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
      },
      // 后台循环间隔设为 1 小时：用例直接调用 runOnce，避免与注入的故障相互干扰
      issues: { enabled: true, repo: REPO, max_per_hour: 3, interval: '1h' },
      notify: { prefix: '[影子]' },
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
                namespaces: ['*'],
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

  const body = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json'), 'utf8'),
  ) as { alerts: Array<{ startsAt: string }> };
  body.alerts[0]!.startsAt = new Date(Date.now() - 30_000).toISOString();
  const r = await api('POST', '/v1/ingest/am', body, TOKENS.ingest);
  expect(r.status).toBe(200);
  incidentA = await until('事件与阶段 A 报告', async () => {
    const q = await db.admin.query<{ incident_id: string }>('SELECT incident_id FROM server.stage_a_reports LIMIT 1');
    return q.rows[0]?.incident_id;
  });
}, 120_000);

afterAll(async () => {
  await srv?.stop();
  await gh?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('事件 issue', () => {
  it('处置判断不是 escalate 的事件不开 issue', async () => {
    await run();
    expect(gh.issues).toHaveLength(0);
    expect(await issueRow(incidentA)).toBeUndefined();
  });

  it('escalate：开一个带标签与前缀的 issue（结论、证据卡摘要、控制台链接）；再跑一轮不重复', async () => {
    // 本用例没有领域包，阶段 A 报告里加一张异常的卡（与 worker-e2e 相同的做法）
    const now = new Date().toISOString();
    const card = {
      ref: 'card:1',
      card_id: '_example/pod-memory/limit-ratio',
      title: { 'zh-CN': 'working set 占 limit', en: 'Working set vs limit' },
      threshold: 0.9,
      series: [],
      entity: { cluster_id: 'c1', kind: 'Pod', namespace: 'shop', name: 'api-7d9f8-x2k4p', uid: 'uid-pod-api' },
      window: { from: now, to: now },
      verdict: 'abnormal',
      display_state: 'abnormal',
      reason: { kind: 'threshold', text: '超过阈值 0.9' },
      value: '96%',
      table: null,
      queries: [],
      egress: 'allow',
      anomaly_started_at: null,
      evaluated_at: now,
    };
    await db.admin.query(
      `UPDATE server.stage_a_reports SET disposition = 'escalate',
         body = jsonb_set(body || '{"disposition":"escalate"}', '{cards}', (body->'cards') || $2::jsonb)
       WHERE incident_id = $1`,
      [incidentA, JSON.stringify([card])],
    );
    await run();
    await run();
    expect(gh.issues).toHaveLength(1);
    const issue = gh.issues[0]!;
    expect(issue.title).toMatch(/^\[影子\] /);
    expect(issue.labels).toEqual(['srenautix']);
    expect(issue.body).toContain(`<!-- srenautix:incident=${incidentA} -->`);
    expect(issue.body).toContain(`${PUBLIC}/incidents/${incidentA}`);
    expect(issue.body).toContain('处置判断为升级');
    // 与通知同一份报告的全文：五段，阶段 A 的异常卡带实测值、阈值与控制台卡片详情的链接
    for (const h of ['## 现状', '## 关键问题', '## 拓扑联系', '## 解决方案', '## 证据链']) {
      expect(issue.body).toContain(h);
    }
    expect(issue.body).toMatch(
      /\*\*working set 占 limit\*\* · `Pod:shop\/api-7d9f8-x2k4p`：超过阈值 0\.9，值 `96%`，阈值 `0\.9`/,
    );
    expect(issue.body).toContain(`[控制台](${PUBLIC}/incidents/${incidentA}?tab=evidence#card-`);
    expect(await issueRow(incidentA)).toMatchObject({ body_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await issueRow(incidentA)).toMatchObject({ state: 'open', number: issue.number });
    const audit = await db.admin.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'github.issue_opened'",
    );
    expect(audit.rows.map((x) => x.data)).toEqual([
      expect.objectContaining({ incident_id: incidentA, repo: REPO, number: issue.number, recovered: false }),
    ]);
  });

  it('后续进展追加为评论：研判结束与事件恢复各一条，不重复；评论发出失败时退避重试，断开连接时按标记找回', async () => {
    const n = gh.issues[0]!.number;
    const research = async (summary: string) => {
      const runId = randomUUID();
      const output = {
        disposition: 'escalate',
        conclusion: {
          level: 'likely',
          hypothesis_id: null,
          root_component: null,
          undetermined_reason: null,
          consistency: {
            entity_in_scope: false,
            onset_precedes_symptom: false,
            no_contrary_normal: false,
            competitor_tested: false,
          },
        },
        hypotheses: [],
        next_checks: [],
        situation: '',
        summary,
        recommendations: [],
        proposals: [],
        validation_notes: [],
      };
      await db.admin.query(
        `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, disposition, conclusion_level, summary,
           output, started_at, finished_at)
         VALUES ($1, $2, 1, 'new_incident', 'completed', 'escalate', 'likely', $3, $4, now(), now() + interval '1 second')`,
        [runId, incidentA, summary, JSON.stringify(output)],
      );
      return runId;
    };
    const before = gh.issues[0]!.body;
    await research('api 的 Pod 内存接近 limit，建议扩容并排查泄漏');
    await run();
    await run();
    expect(gh.comments.get(n)?.map((c) => c.body)).toEqual([expect.stringContaining('研判结束：结论 `likely`')]);
    // 正文就地更新为新的结论（PATCH 只改 body）
    expect(gh.issues[0]!.body).not.toBe(before);
    expect(gh.issues[0]!.body).toContain('结论：可能（likely）');
    const patches = gh.requests.filter((r) => r.method === 'PATCH' && r.path === `/repos/${REPO}/issues/${n}`);
    expect(patches.length).toBe(1);

    // 5xx：记一次失败，退避后重试成功
    gh.fault('POST', /\/issues\/\d+\/comments$/, 503);
    const second = await research('第二次研判：根因仍是 api');
    await run();
    const pending = await db.admin.query<{ attempts: number; last_error: string }>(
      'SELECT attempts, last_error FROM server.github_issue_comments WHERE key = $1',
      [`research:${second}`],
    );
    expect(pending.rows[0]).toMatchObject({ attempts: 1, last_error: expect.stringContaining('503') });
    await run();
    expect(gh.comments.get(n)).toHaveLength(1);
    await fastForward();
    await run();
    expect(gh.comments.get(n)).toHaveLength(2);

    // 评论已经写入但响应丢失：重试时按标记找到，不重复写
    gh.fault('POST', /\/issues\/\d+\/comments$/, 'drop_after');
    await db.admin.query("UPDATE server.incidents SET state = 'resolved', ended_at = now() WHERE incident_id = $1", [
      incidentA,
    ]);
    await run();
    expect(gh.comments.get(n)).toHaveLength(3);
    await fastForward();
    await run();
    await run();
    const bodies = gh.comments.get(n)!.map((c) => c.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain('事件已于');
    const posted = await db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM server.github_issue_comments WHERE incident_id = $1 AND posted_at IS NOT NULL',
      [incidentA],
    );
    expect(posted.rows[0]?.n).toBe(3);
  });

  it('开 issue 时连接断开：重试按事件标记找回已开的 issue，不重复开', async () => {
    const b = await cloneEscalated('c2-recover');
    gh.fault('POST', new RegExp(`^/repos/${REPO}/issues$`), 'drop_after');
    await run();
    expect(gh.issues).toHaveLength(2);
    expect(await issueRow(b)).toMatchObject({ state: 'pending', attempts: 1 });
    await fastForward();
    await run();
    expect(gh.issues).toHaveLength(2);
    expect(await issueRow(b)).toMatchObject({ state: 'open', number: gh.issues[1]!.number });
    const audit = await db.admin.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'github.issue_opened' AND data->>'incident_id' = $1",
      [b],
    );
    expect(audit.rows[0]?.data).toMatchObject({ recovered: true });
  });

  it('拓扑覆盖 PR：提交 gitops_pr 提议，事件已有 issue 时描述写 Refs，issue 回链提议；gateway 开出 PR 后回链 PR', async () => {
    const r = await api('POST', '/v1/topology/overrides/pr', {
      cluster_id: 'c1',
      alertname: 'ApiMemoryHigh',
      component: 'Deployment:shop/api',
      role: 'cause',
      incident_id: incidentA,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(responseErrors('/v1/topology/overrides/pr', 'post', 201, r.body)).toBeNull();
    const n = gh.issues[0]!.number;
    expect(r.body.issue_url).toBe(`https://github.example.test/${REPO}/issues/${n}`);
    const proposalId = String(r.body.proposal_id);
    const params = (
      await db.admin.query<{ params: { body: string; branch: string } }>(
        'SELECT params FROM server.proposals WHERE proposal_id = $1',
        [proposalId],
      )
    ).rows[0]!.params;
    expect(params.body).toContain(`Refs #${n}`);
    // server 不开 PR
    expect(gh.pulls.some((p) => p.head === params.branch)).toBe(false);
    await run();
    expect(gh.comments.get(n)!.at(-1)!.body).toContain(`${PUBLIC}/actions/${proposalId}`);
    // gateway 执行批准后的提议、开出 PR（执行事件里写 PR 地址）：关联到事件 issue
    gh.pulls.push({ number: 501, head: params.branch, base: 'main', title: 't', body: params.body });
    await db.admin.query(
      `INSERT INTO server.execution_events (event_id, cluster_id, execution_id, ticket_id, proposal_id, seq, phase, at, reason, body)
       VALUES ($1, 'c1', $2, gen_random_uuid(), $3, 1, 'verified', now(), 'checks_passed', $4)`,
      [
        'd'.repeat(32),
        'e'.repeat(32),
        proposalId,
        JSON.stringify({ message: `pr_open: PR https://github.example.test/${REPO}/pull/501 #501 state=open` }),
      ],
    );
    await db.admin.query("UPDATE server.proposals SET state = 'dispatched' WHERE proposal_id = $1", [proposalId]);
    const appClient = new GitHubApp({
      apiBase: gh.url,
      appId: '424242',
      installationId: '99',
      privateKey: app.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    });
    const pulls = new GitOpsPulls(db.server, appClient, srv.issues, new ServerMetrics('server', false));
    expect(await pulls.runOnce()).toBe(1);
    await run();
    expect(gh.comments.get(n)!.at(-1)!.body).toContain(`关联的 PR：`);
    expect(gh.comments.get(n)!.at(-1)!.body).toContain(`https://github.example.test/${REPO}/pull/501`);
    const missing = await api('POST', '/v1/topology/overrides/pr', {
      cluster_id: 'c1',
      alertname: 'Other',
      component: 'Deployment:shop/api',
      role: 'cause',
      incident_id: randomUUID(),
    });
    expect(missing.status).toBe(404);
  });

  it('提议先于 issue：issue 暂时开不出时提议照常提交，issue 开出后回链提议；之后开出的 PR 补 Refs', async () => {
    const c = await cloneEscalated('c2-pr-first');
    gh.fault('POST', new RegExp(`^/repos/${REPO}/issues$`), 502);
    const r = await api('POST', '/v1/topology/overrides/pr', {
      cluster_id: 'c2',
      alertname: 'CacheEvictions',
      component: 'StatefulSet:cache/redis',
      role: 'cause',
      incident_id: c,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.issue_url).toBeNull();
    const params = (
      await db.admin.query<{ params: { body: string; branch: string } }>(
        'SELECT params FROM server.proposals WHERE proposal_id = $1',
        [r.body.proposal_id],
      )
    ).rows[0]!.params;
    expect(params.body).not.toContain('Refs');
    await fastForward();
    await run();
    const row = await issueRow(c);
    expect(row).toMatchObject({ state: 'open' });
    await run();
    expect(gh.comments.get(row!.number!)!.map((x) => x.body)).toEqual([
      expect.stringContaining(`${PUBLIC}/actions/${String(r.body.proposal_id)}`),
    ]);
    // gateway 按提议开出的 PR 描述里没有 Refs：关联后补上
    gh.pulls.push({ number: 502, head: params.branch, base: 'main', title: 't', body: params.body });
    await srv.issues!.link(c, {
      kind: 'pull',
      url: `https://github.example.test/${REPO}/pull/502`,
      title: 't',
      repo: REPO,
      number: 502,
      refsInBody: false,
    });
    await run();
    expect(gh.pulls.find((p) => p.number === 502)!.body).toContain(`Refs #${row!.number!}`);
    const refsAudit = await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.governance_audit WHERE kind = 'github.pr_refs'",
    );
    expect(refsAudit.rows[0]?.n).toBe(1);
  });

  it('gitops_pr 提议：参数描述里写 Refs，issue 回链提议', async () => {
    expect(withRefs({ body: 'x' }, '#3')).toEqual({ body: 'x\n\nRefs #3' });
    expect(withRefs({ body: 'x\n\nRefs #3' }, '#3')).toEqual({ body: 'x\n\nRefs #3' });
    expect(withRefs({}, 'acme/ops#3')).toEqual({ body: 'Refs acme/ops#3' });
    expect(withRefs({ body: 'x'.repeat(8190) }, '#3')).toEqual({ body: 'x'.repeat(8190) });
    const inc = (await api('GET', `/v1/incidents/${incidentA}`)).body as {
      incident_version: number;
      root: { component: string };
    };
    const sa = (await api('GET', `/v1/incidents/${incidentA}/stage-a`)).body as { evidence_fingerprint: string };
    const p = await api(
      'POST',
      '/v1/proposals',
      {
        incident_id: incidentA,
        binding: {
          incident_version: inc.incident_version,
          root_component: inc.root.component,
          evidence_fingerprint: sa.evidence_fingerprint,
        },
        action: 'gitops_pr',
        params: {
          repository: 'acme/gitops',
          base: 'main',
          title: 'shop: raise api memory limit',
          body: '把 api 的内存 limit 提到 1Gi',
          patch:
            'diff --git a/apps/shop/api.yaml b/apps/shop/api.yaml\n--- a/apps/shop/api.yaml\n+++ b/apps/shop/api.yaml\n@@ -1 +1 @@\n-memory: 512Mi\n+memory: 1Gi\n',
        },
        research_run_id: null,
        rule_id: null,
        hypothesis_id: null,
        evidence_refs: [],
        expected_effect: '内存不再接近 limit',
      },
      TOKENS.external,
    );
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const n = gh.issues[0]!.number;
    expect((p.body.params as { body: string }).body).toBe(`把 api 的内存 limit 提到 1Gi\n\nRefs ${REPO}#${n}`);
    await run();
    expect(gh.comments.get(n)!.at(-1)!.body).toContain(`${PUBLIC}/actions/${String(p.body.proposal_id)}`);
  });

  it('标题跟随根因（ADR 0142）：根因变了就改标题，同一事件每小时最多改一次；不知道现在的标题时先读回', async () => {
    // CCHP #249：开出时根因是 Argo 应用，之后事件的根因是 gateway，标题一直停在开出时那一刻
    const id = (
      await db.admin.query<{ incident_id: string }>(
        "SELECT incident_id FROM server.incidents WHERE label = 'c2-recover'",
      )
    ).rows[0]!.incident_id;
    const { number } = (await issueRow(id))!;
    const issue = () => gh.issues.find((i) => i.number === number)!;
    const reroot = (component: string) =>
      db.admin.query(
        `UPDATE server.incidents SET root_component = $2, updated_at = now(),
           body = jsonb_set(body, '{root,component}', to_jsonb($2::text)) WHERE incident_id = $1`,
        [id, component],
      );
    const patchesOf = () =>
      gh.requests.filter((r) => r.method === 'PATCH' && r.path === `/repos/${REPO}/issues/${number}`).length;
    const titleRow = async () =>
      (
        await db.admin.query<{ title: string | null; title_updated_at: Date | null }>(
          'SELECT title, title_updated_at FROM server.github_issues WHERE incident_id = $1',
          [id],
        )
      ).rows[0]!;
    const opened = issue().title;
    expect((await titleRow()).title).toBe(opened);
    await run();
    const before = patchesOf();

    await reroot('StatefulSet:cache/gateway');
    await run();
    expect(issue().title).not.toBe(opened);
    expect(issue().title).toMatch(/^\[影子\] StatefulSet:cache\/gateway：/);
    expect(await titleRow()).toMatchObject({ title: issue().title, title_updated_at: expect.any(Date) });
    const audit = await db.admin.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'github.issue_retitled'",
    );
    expect(audit.rows.map((x) => x.data)).toEqual([
      { incident_id: id, repo: REPO, number, from: opened, to: issue().title },
    ]);
    const metrics = await srv.metrics.registry.metrics();
    expect(metrics).toContain(`srenautix_github_issues_total{repo="${REPO}",outcome="title_updated"} 1`);
    expect(patchesOf()).toBe(before + 1);

    // 一小时之内根因又变了：正文照常更新，标题不改（不跟着抖动）
    const second = issue().title;
    await reroot('Deployment:shop/api');
    await run();
    expect(issue().title).toBe(second);
    expect(issue().body).toContain('Deployment:shop/api');
    const last = gh.requests
      .filter((r) => r.method === 'PATCH' && r.path === `/repos/${REPO}/issues/${number}`)
      .at(-1)!;
    expect(Object.keys(last.body as object)).toEqual(['body']);
    await run();
    expect(issue().title).toBe(second);

    // 过了一小时：留下的标题补上
    await db.admin.query(
      "UPDATE server.github_issues SET title_updated_at = now() - interval '61 minutes' WHERE incident_id = $1",
      [id],
    );
    await db.admin.query('UPDATE server.incidents SET updated_at = now() WHERE incident_id = $1', [id]);
    await run();
    expect(issue().title).toMatch(/^\[影子\] Deployment:shop\/api：/);
    expect(Object.keys(gh.requests.at(-1)!.body as object)).toEqual(['title']);

    // 这一版之前开出的 issue（库里没有标题）：先读回 GitHub 上的标题，相同就不改
    await db.admin.query(
      "UPDATE server.github_issues SET title = NULL, title_updated_at = now() - interval '2 hours' WHERE incident_id = $1",
      [id],
    );
    await db.admin.query('UPDATE server.incidents SET updated_at = now() WHERE incident_id = $1', [id]);
    const n = patchesOf();
    await run();
    expect(patchesOf()).toBe(n);
    expect((await titleRow()).title).toBe(issue().title);
    expect(gh.requests.some((r) => r.method === 'GET' && r.path === `/repos/${REPO}/issues/${number}`)).toBe(true);
  });

  it('限速：每小时开满之后的事件只记录为 skipped，不开 issue', async () => {
    expect(gh.issues).toHaveLength(3);
    const d = await cloneEscalated('c2-over-limit');
    await run();
    expect(gh.issues).toHaveLength(3);
    expect(await issueRow(d)).toMatchObject({ state: 'skipped', number: null });
    await run();
    expect(gh.issues).toHaveLength(3);
    const audit = await db.admin.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'github.issue_skipped'",
    );
    expect(audit.rows.map((x) => x.data)).toEqual([
      { incident_id: d, repo: REPO, reason: 'rate_limit', max_per_hour: 3 },
    ]);
    const metrics = await srv.metrics.registry.metrics();
    expect(metrics).toContain(`srenautix_github_issues_total{repo="${REPO}",outcome="skipped_rate_limit"} 1`);
  });

  it('重试用尽：GitHub 一直失败时记为 failed 并写审计', async () => {
    // 已开的 issue 移出最近 1 小时，腾出限速额度
    await db.admin.query("UPDATE server.github_issues SET opened_at = now() - interval '2 hours' WHERE state = 'open'");
    gh.fault('POST', new RegExp(`^/repos/${REPO}/issues$`), 500, 100);
    gh.fault('GET', new RegExp(`^/repos/${REPO}/issues$`), 500, 100);
    const e = await cloneEscalated('c2-gives-up');
    for (let i = 0; i < 8; i++) {
      await fastForward();
      await run();
    }
    expect(await issueRow(e)).toMatchObject({ state: 'failed', attempts: 8 });
    const audit = await db.admin.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'github.issue_failed'",
    );
    expect(audit.rows.map((x) => x.data)).toEqual([expect.objectContaining({ incident_id: e, attempts: 8 })]);
  });
});
