import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import type { EvidenceResult, Incident, Proposal, RepositoryLayout } from '@srenautix/contract';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import type { EvidenceDataSource } from '@srenautix/packs-sdk';
import { applyPatch } from 'diff';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GitHubApp } from '../../src/github/app.js';
import { IssueService } from '../../src/github/issues.js';
import type { Bindings } from '../../src/identity/bindings.js';
import { upsertAlert } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { NO_LINKS } from '../../src/notify/links.js';
import { ReportSource } from '../../src/notify/source.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import { Policies, type GatewayPolicy } from '../../src/proposals/policy.js';
import { ProposalService } from '../../src/proposals/service.js';
import { GitOpsPulls } from '../../src/remediation/pulls.js';
import { BINDING_RETRY_LIMIT, REMEDIATION_RULE, RemediationService } from '../../src/remediation/service.js';
import { GitRepositoryTargets } from '../../src/remediation/targets.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { tx } from '../../src/store/pool.js';
import { ComponentExpander } from '../../src/topology/expand.js';
import { TopologyStore, type TopologyChange } from '../../src/topology/store.js';
import { TopologyTargets } from '../../src/topology/targets.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { PACKS } from '../support/packs.js';
import { incident as baseIncident, stageA, stageACards } from '../support/scenario.js';

/**
 * 自愈 PR（ADR 0108），真实 PostgreSQL、内置 gitops 包与内存中的 GitHub REST API：
 * 研判结论 → 适用的修复模板 → 读仓库计划补丁 → 校验 → gitops_pr 提议（规则 remediation-pr，目标 UID 为 base 的提交）；
 * 同一次研判不重复处理；gateway 开出 PR 后关联到事件 issue。server 对仓库只发 GET。
 */
const REPO = 'acme/gitops';
const CLUSTER = 'test';
const CATALOG_PATH = 'srenautix/packs/kind-shop/alerts.yaml';
const CATALOG_FILE = `# 告警目录
entries:
  - { id: shop-api-down, alertname: ShopApiDown, role: symptom, entity: { kind: Deployment, name_labels: [deployment] } }
`;
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const metrics = new ServerMetrics('server', false);
const T = Date.now();

let db: TestDb;
let gh: FakeGitHub;
let app: GitHubApp;
let service: RemediationService;
let issues: IssueService;
let rt: PackRuntime;

function incident(): Incident {
  const inc = baseIncident();
  const id = randomUUID();
  return {
    ...inc,
    incident_id: id,
    label: `Deployment:shop/api:${id}`,
    first_firing_at: new Date(T - 20 * 60_000).toISOString(),
    root: {
      ...inc.root,
      component: 'Deployment:shop/api',
      entity: { cluster_id: CLUSTER, kind: 'Deployment', namespace: 'shop', name: 'api', uid: null },
    },
    members: [],
    components: ['Deployment:shop/api'],
  };
}

/**
 * 事件、成员告警（没有命中目录）、阶段 A 报告与一次结束的研判。root 改写事件根因，researchRoot 是研判结论的根因
 * （默认 Deployment:shop/api），cards 是阶段 A 的卡（默认 support/scenario 的五张）
 */
async function seed(
  level = 'likely',
  o: {
    disposition?: string;
    severity?: 'warning' | 'critical';
    root?: Incident['root'];
    researchRoot?: string;
    cards?: EvidenceResult[];
    /** 成员告警的告警名（默认 ShopQueueBacklog） */
    alertname?: string;
    /** 成员告警的标签（不含 alertname 与 severity；默认 deployment=api、namespace=shop）、归属组件与实体 */
    alert?: {
      labels: Record<string, string>;
      component: string;
      entity: { kind: string; namespace: string | null; name: string } | null;
    };
  } = {},
): Promise<{ inc: Incident; runId: string }> {
  const alertname = o.alertname ?? 'ShopQueueBacklog';
  const member = o.alert ?? {
    labels: { deployment: 'api', namespace: 'shop' },
    component: 'Deployment:shop/api',
    entity: { kind: 'Deployment', namespace: 'shop', name: 'api' },
  };
  const inc = incident();
  if (o.root) {
    inc.root = o.root;
    inc.label = `${o.root.component}:${inc.incident_id}`;
    inc.components = [...new Set([o.root.component!, ...inc.components])];
  }
  const researchRoot = o.researchRoot ?? 'Deployment:shop/api';
  const disposition = o.disposition ?? 'act';
  const severity = o.severity ?? 'warning';
  const fp = createHash('sha256').update(inc.incident_id).digest('hex').slice(0, 16);
  const startsAt = new Date(T - 15 * 60_000);
  const u = await tx(db.server, (c) =>
    upsertAlert(
      c,
      CLUSTER,
      {
        source: 'alertmanager',
        labels: { alertname, ...member.labels, severity },
        annotations: {},
        severity,
        status: 'firing',
        suppressed: 'none',
        startsAt,
        endsAt: null,
        generatorUrl: null,
        fingerprint: fp,
        alertname,
      },
      {
        classification: { role: 'cause', source: 'default', confidence: 0.3, catalog_entry: null, chronic: false },
        entity: member.entity ? { cluster_id: CLUSTER, ...member.entity, uid: null } : null,
        entityResolution: member.entity ? 'labels' : 'unresolved',
        component: member.component,
        chains: [],
      },
    ),
  );
  inc.members = [
    {
      alert_id: u.alertId,
      alertname,
      role: 'cause',
      component: member.component,
      severity: 'warning',
      status: 'firing',
      starts_at: startsAt.toISOString(),
      ends_at: null,
      joined_version: 1,
      left_version: null,
    },
  ];
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      inc.incident_id,
      CLUSTER,
      inc.label,
      inc.incident_version,
      'firing',
      inc.severity,
      inc.first_firing_at,
      inc.root.component,
      JSON.stringify(inc),
    ],
  );
  const report = { ...stageA(o.cards), incident_id: inc.incident_id, incident_version: inc.incident_version };
  await db.server.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body, first_firing_at, rendered_at)
     VALUES ($1, $2, $3, $4, $5, false, $6, $7, now())`,
    [
      randomUUID(),
      inc.incident_id,
      inc.incident_version,
      report.disposition,
      report.evidence_fingerprint,
      JSON.stringify(report),
      inc.first_firing_at,
    ],
  );
  const runId = randomUUID();
  await db.server.query(
    `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, disposition, conclusion_level, root_component,
       summary, evidence_fingerprint, output, started_at, finished_at)
     VALUES ($1, $2, $3, 'new_incident', 'completed', $9, $4, $5, $6, $7, $8, now() - interval '2 minutes', now())`,
    [
      runId,
      inc.incident_id,
      inc.incident_version,
      level,
      researchRoot,
      'api 的队列积压告警没有命中告警目录',
      report.evidence_fingerprint,
      JSON.stringify({
        disposition,
        conclusion: {
          level,
          hypothesis_id: 'h1',
          root_component: researchRoot,
          undetermined_reason: null,
          consistency: {},
        },
        hypotheses: [
          {
            id: 'h1',
            parent_id: null,
            root_component: researchRoot,
            mechanism: '队列积压',
            supporting: ['card:1'],
            refuting: [],
            status: 'supported',
          },
        ],
        next_checks: [],
        situation: '',
        summary: 'api 的队列积压告警没有命中告警目录',
        recommendations: [],
        proposals: [],
        validation_notes: [],
      }),
      disposition,
    ],
  );
  return { inc, runId };
}

const RULES_PATH = 'platform/rules/shop.yaml';
const RULES_FILE = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: shop
spec:
  groups:
    - name: shop
      rules:
        - alert: ShopQueueBacklog
          expr: queue_depth > 100
          labels:
            severity: critical
`;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  gh = new FakeGitHub('1', '2', key.publicKey, REPO);
  await gh.start();
  gh.write(
    'main',
    { [CATALOG_PATH]: CATALOG_FILE, [RULES_PATH]: RULES_FILE, 'apps/shop/release.json': '{}\n' },
    { message: 'seed' },
  );
  app = new GitHubApp({ apiBase: gh.url, appId: '1', installationId: '2', privateKey: pem });
  rt = await PackRuntime.load({
    dirs: [PACKS],
    only: ['gitops', 'workload', 'kubernetes-core'],
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
  });
  ({ service } = build(null));
}, 120_000);

/** 提议服务与自愈服务；signingKey 给出时自动执行规则签发断言（经过 gateway 仅提议的检查） */
function build(
  signingKey: KeyObject | null,
  o: {
    /** 在提交提议之前执行（模拟对账在读取事件与提议之间让事件升版本） */
    beforeCreate?: () => Promise<void>;
    /** 仓库布局里另加的文件角色 */
    files?: RepositoryLayout;
    dataSource?: () => Promise<EvidenceDataSource | null>;
    categories?: string[];
    conclusions?: string[];
    /** 同一模板对同一组文件的修改被拒绝后的冷却期（默认 7 天） */
    cooldownMs?: number;
    /** 事件 issue 每小时上限（默认 3） */
    issuesPerHour?: number;
    /** 外部上游汇总配置里的组件与告警标签（默认为空） */
    externalAlerts?: { components: string[]; alertLabels: Record<string, string[]> };
  } = {},
): { proposals: ProposalService; service: RemediationService } {
  const beforeCreate = o.beforeCreate;
  const policy: GatewayPolicy = {
    version: 1,
    cluster: CLUSTER,
    actions: [{ id: 'gitops_pr', auto_execution: { rules: ['remediation-pr'], namespaces: [] } }],
    approvers: [],
  };
  const proposals = new ProposalService(
    db.server,
    Catalog.load(),
    {
      profile: 'standard',
      signingKey,
      keyId: signingKey ? 'test-service' : 'none',
      assertionTtlMs: 900_000,
      proposalTtlMs: 7_200_000,
      proposalTtlCapMs: 86_400_000,
      hReauthMaxAgeMs: 300_000,
    },
    () => ({}) as Bindings,
    new GitRepositoryTargets(new TopologyTargets(db.server), () => app),
    () => new Policies(new Map([[CLUSTER, policy]]), 'test'),
    metrics,
  );
  // 事件 issue 与 GitOps 仓库同一个（FakeGitHub 只模拟一个仓库），Refs 写作 #n
  issues = new IssueService(
    db.server,
    app,
    {
      repo: REPO,
      labels: ['srenautix'],
      titlePrefix: '[影子]',
      maxPerHour: o.issuesPerHour ?? 3,
      lookbackMs: 3600_000,
      consoleUrl: 'https://srenautix.example.test',
      language: 'zh',
    },
    metrics,
    (incidentId, language) =>
      new ReportSource(
        db.server,
        new FeedbackService(db.server, metrics),
        new TopologyStore(db.server),
        { alertTitle: () => null, actionVerify: () => null, links: NO_LINKS },
        { prefix: '[影子]', consoleUrl: 'https://srenautix.example.test' },
      ).message(incidentId, language),
  );
  const service = new RemediationService(
    db.server,
    {
      repositories: {
        gitops: {
          repo: REPO,
          base_branch: 'main',
          files: {
            pack_alerts: { path: CATALOG_PATH, format: 'yaml' },
            alert_rules: { path: 'platform/rules/*.yaml', format: 'yaml' },
            ...o.files,
          },
        },
      },
      categories: o.categories ?? ['release_rollback', 'config_resource', 'alert_rule', 'topology_coverage'],
      conclusions: o.conclusions ?? ['likely', 'evidence_consistent'],
      titlePrefix: '[影子]',
      language: 'zh',
      consoleUrl: 'https://srenautix.example.test',
      maxPerRun: 2,
      lookbackMs: 6 * 3600_000,
      externalAlerts: o.externalAlerts ?? { components: [], alertLabels: {} },
      rejectedCooldownMs: o.cooldownMs ?? 7 * 86_400_000,
    },
    {
      packs: () => rt.set,
      componentTypes: () => rt.componentTypes(),
      componentType: async () => null,
      concrete: (clusterId, key, at, hints) =>
        new ComponentExpander(new TopologyStore(db.server)).concrete(clusterId, key, at, hints),
      owner: (clusterId, key, at) => new TopologyStore(db.server).ownerOf(clusterId, key, at),
      managers: (clusterId, key, at) => new TopologyStore(db.server).targets(clusterId, key, 'managed_by', at),
      dataSource: o.dataSource ?? (async () => null),
      github: app,
      proposals: beforeCreate
        ? (Object.assign(Object.create(proposals) as ProposalService, {
            create: async (...args: Parameters<ProposalService['create']>) => {
              await beforeCreate();
              return proposals.create(...args);
            },
          }) as ProposalService)
        : proposals,
      issueRef: async (incidentId, fromRepo) => {
        const i = await issues.ensure(incidentId, 'repo_change');
        return i ? GitHubApp.ref(fromRepo, i.repo, i.number) : null;
      },
      linkPull: (incidentId, pull) =>
        issues.link(incidentId, {
          kind: 'pull',
          url: pull.url,
          title: pull.title,
          repo: pull.repo,
          number: pull.number,
          refsInBody: false,
        }),
      metrics,
    },
  );
  return { proposals, service };
}

/**
 * 之前用例的提议全部过期（没有开出 PR，修改记为 abandoned）：用例之间同一个修改不算重复。去重本身由"修改去重"一组用例覆盖
 */
const settle = () =>
  db.server.query(
    `UPDATE server.proposals SET state = 'expired', body = jsonb_set(body, '{state}', '"expired"')
      WHERE action = 'gitops_pr' AND state <> 'expired'`,
  );

afterAll(async () => {
  await gh?.stop();
  await db?.close();
});

/** 事件升一个版本（只加入成员，根因不变）；返回新版本 */
const bump = async (incidentId: string) =>
  (
    await db.server.query<{ version: number }>(
      `UPDATE server.incidents SET version = version + 1, body = jsonb_set(body, '{incident_version}', to_jsonb(version + 1))
        WHERE incident_id = $1 RETURNING version`,
      [incidentId],
    )
  ).rows[0]!.version;
const currentVersion = async (incidentId: string) =>
  (
    await db.server.query<{ version: number }>('SELECT version FROM server.incidents WHERE incident_id = $1', [
      incidentId,
    ])
  ).rows[0]?.version;
/** 新版本的阶段 A 报告：证据指纹不变（指纹变化会触发研判）；从上一版本的报告复制 */
const report = (incidentId: string, v: number) =>
  db.server.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body,
       first_firing_at, rendered_at)
     SELECT $3, incident_id, $2, disposition, evidence_fingerprint, degraded, jsonb_set(body, '{incident_version}', to_jsonb($2::int)),
            first_firing_at, now()
       FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2 - 1`,
    [incidentId, v, randomUUID()],
  );

const attempts = async (runId: string) =>
  (
    await db.server.query<{
      key: string;
      outcome: string;
      code: string | null;
      proposal_id: string | null;
      branch: string | null;
    }>(
      'SELECT key, outcome, code, proposal_id, branch FROM server.remediation_attempts WHERE run_id = $1 ORDER BY key',
      [runId],
    )
  ).rows;

describe('自愈 PR', () => {
  let proposal: Proposal;
  let inc: Incident;
  beforeEach(settle);

  it('结论适用模板时生成补丁，校验后提交 gitops_pr 提议：[影子] 标题、srenautix/ 分支、带标记的描述、目标为 base 的提交', async () => {
    const s = await seed();
    inc = s.inc;
    const writesBefore = gh.requests.filter((r) => r.method !== 'GET' && !r.path.startsWith('/app/')).length;
    expect(await service.runOnce()).toBe(1);
    const rows = await attempts(s.runId);
    expect(rows).toEqual([
      {
        key: 'gitops/alert-catalog-entry',
        outcome: 'proposed',
        code: null,
        proposal_id: expect.any(String),
        branch: expect.stringMatching(
          new RegExp(`^srenautix/${inc.incident_id.slice(0, 8)}-topology-coverage-[0-9a-f]{6}$`),
        ),
      },
    ]);
    const p = await db.server.query<{ body: Proposal }>('SELECT body FROM server.proposals WHERE proposal_id = $1', [
      rows[0]!.proposal_id,
    ]);
    proposal = p.rows[0]!.body;
    expect(proposal).toMatchObject({
      action: 'gitops_pr',
      source: 'rule',
      rule_id: REMEDIATION_RULE,
      research_run_id: s.runId,
      hypothesis_id: 'h1',
      evidence_refs: ['card:1'],
      // 策略为 gitops_pr 列出了自动执行规则 remediation-pr：可撤销、L 档，签发后由 gateway 自动执行
      level: 'reversible',
      tier: 'L',
      auto_eligible: true,
      target: { kind: 'GitRepository', name: REPO, uid: gh.heads.get('main') },
    });
    expect(proposal.state).not.toBe('rejected_by_policy');
    const params = proposal.params as { title: string; body: string; patch: string; base: string; branch: string };
    expect(params.title).toMatch(/^\[影子\] 为未覆盖的告警加告警目录条目：/);
    expect(params.base).toBe('main');
    expect(params.branch).toBe(rows[0]!.branch);
    for (const m of ['summary', 'evidence', 'change', 'verify', 'rollback', 'run']) {
      expect(params.body).toContain(`<!-- srenautix:pr=${m} -->`);
    }
    for (const h of ['## 结论', '## 证据', '## 改了什么', '## 验证计划', '## 回滚', '## 研判运行']) {
      expect(params.body).toContain(h);
    }
    expect(params.body).toContain(`https://srenautix.example.test/runs/${s.runId}`);
    expect(params.body).toContain(`<!-- srenautix:incident=${inc.incident_id} -->`);
    // 事件 issue 先开出，描述里 Refs 在事件标记之前
    const issue = gh.issues.at(-1)!;
    expect(params.body.indexOf(`Refs #${issue.number}`)).toBeLessThan(params.body.indexOf('srenautix:incident='));
    // 补丁应用到 base 后：目录多了一条，注释保留
    const after = applyPatch(CATALOG_FILE, params.patch);
    expect(after).not.toBe(false);
    expect((after as string).startsWith('# 告警目录\n')).toBe(true);
    expect(
      (parse(after as string) as { entries: Array<{ alertname: string }> }).entries.map((e) => e.alertname),
    ).toEqual(['ShopApiDown', 'ShopQueueBacklog']);
    // server 对 GitOps 仓库只读：除了开 issue 与评论，没有写请求
    const writes = gh.requests
      .filter((r) => r.method !== 'GET' && !r.path.startsWith('/app/'))
      .slice(writesBefore)
      .map((r) => `${r.method} ${r.path}`);
    expect(writes.every((w) => /^POST \/repos\/acme\/gitops\/issues(\/\d+\/comments)?$/.test(w))).toBe(true);
    expect(gh.heads.get('main')).toBe(proposal.target.uid);
  });

  it('同一次研判不重复处理；结论等级不在配置中的研判不处理；没有适用模板时记一行', async () => {
    expect(await service.runOnce()).toBe(0);
    const weak = await seed('inconclusive');
    expect(await service.runOnce()).toBe(0);
    expect(await attempts(weak.runId)).toEqual([]);
    // 目录里已经有这条告警：模板的 skip_if 生效
    gh.write(
      'main',
      {
        [CATALOG_PATH]: `${CATALOG_FILE}  - { id: shop-queue-backlog, alertname: ShopQueueBacklog, role: cause, entity: { kind: Deployment, name_labels: [deployment] } }\n`,
      },
      { message: 'catalog: add ShopQueueBacklog' },
    );
    const again = await seed();
    expect(await service.runOnce()).toBe(0);
    expect(await attempts(again.runId)).toEqual([
      { key: 'gitops/alert-catalog-entry', outcome: 'skipped', code: 'skip_if', proposal_id: null, branch: null },
    ]);
  });

  it('模板收到研判结论：研判判为 ignore、告警是 critical 时提议把规则降为 warning；判为 act 时不提', async () => {
    const act = await seed('likely', { severity: 'critical' });
    expect(await service.runOnce()).toBe(0);
    expect((await attempts(act.runId)).map((a) => a.key)).not.toContain('gitops/noisy-alert-relax');
    const ignored = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    expect(await service.runOnce()).toBe(1);
    const rows = await attempts(ignored.runId);
    const noisy = rows.find((a) => a.key === 'gitops/noisy-alert-relax');
    expect(noisy).toMatchObject({ outcome: 'proposed' });
    const p = await db.server.query<{ params: { patch: string; title: string } }>(
      'SELECT params FROM server.proposals WHERE proposal_id = $1',
      [noisy!.proposal_id],
    );
    const after = applyPatch(RULES_FILE, p.rows[0]!.params.patch) as string;
    expect(after).toContain('severity: warning');
    expect(after).toContain('for: 1h');
    expect(p.rows[0]!.params.title).toMatch(/^\[影子\] 降低误报告警的严重度/);
  });

  it('研判之后事件只加入了成员（新版本没有触发研判）时结论仍然适用；新版本触发过研判时跳过（ADR 0108 §10）', async () => {
    const joined = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    const jv = await bump(joined.inc.incident_id);
    // 新版本的阶段 A 报告还没有生成：推迟到下一轮，不记结果
    expect(await service.runOnce()).toBe(0);
    expect(await attempts(joined.runId)).toEqual([]);
    await report(joined.inc.incident_id, jv);
    expect(await service.runOnce()).toBe(1);
    expect((await attempts(joined.runId)).find((a) => a.key === 'gitops/noisy-alert-relax')).toMatchObject({
      outcome: 'proposed',
    });

    const retriggered = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    const v = await bump(retriggered.inc.incident_id);
    await db.server.query(
      `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state, skip_reason, finished_at)
       VALUES ($1, $2, $3, 'fingerprint_changed', 'critical', false, 'skipped', 'capped', now())`,
      [randomUUID(), retriggered.inc.incident_id, v],
    );
    expect(await service.runOnce()).toBe(0);
    expect(await attempts(retriggered.runId)).toEqual([
      { key: '-', outcome: 'skipped', code: 'incident_changed', proposal_id: null, branch: null },
    ]);
  });

  it('Kind 12:13:57 的时序：v1 研判完成，提交提议前对账让事件升到 v2，第一次绑定过时；下一轮按 v2 重新绑定，开出 PR（ADR 0108 §13）', async () => {
    const run = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    // 研判针对的版本（v1），对账之后是下一个版本（v2）
    const v1 = run.inc.incident_version;
    const v2 = v1 + 1;
    let raced = false;
    const racing = build(null, {
      beforeCreate: async () => {
        if (!raced) {
          raced = true;
          await bump(run.inc.incident_id);
        }
      },
    }).service;
    expect(await racing.runOnce()).toBe(0);
    expect((await attempts(run.runId)).find((a) => a.key === 'gitops/noisy-alert-relax')).toMatchObject({
      outcome: 'skipped',
      code: 'binding_stale',
    });
    // v2 的阶段 A 报告还没有：推迟，尝试仍是 binding_stale
    expect(await racing.runOnce()).toBe(0);
    await report(run.inc.incident_id, v2);
    // 上一轮绑定过时的模板这一轮按 v2 重新处理（告警目录模板因前面的用例已经写入目录而 skip_if）
    expect(await racing.runOnce()).toBe(1);
    const rows = await attempts(run.runId);
    expect(rows.find((a) => a.key === 'gitops/noisy-alert-relax')).toMatchObject({ outcome: 'proposed' });
    const p = await db.server.query<{ v: number }>(
      "SELECT (body->'binding'->>'incident_version')::int AS v FROM server.proposals WHERE proposal_id = $1",
      [rows.find((a) => a.key === 'gitops/noisy-alert-relax')!.proposal_id],
    );
    expect(p.rows[0]!.v).toBe(v2);
    // 已经有结果的模板不再处理
    expect(await racing.runOnce()).toBe(0);
  });

  it('绑定过时：根因变了时等新版本的研判；重试有次数上限', async () => {
    const changed = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    let once = false;
    const racing = build(null, {
      beforeCreate: async () => {
        if (!once) {
          once = true;
          const v = await bump(changed.inc.incident_id);
          await db.server.query(
            `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state)
             VALUES ($1, $2, $3, 'root_changed', 'critical', false, 'queued')`,
            [randomUUID(), changed.inc.incident_id, v],
          );
        }
      },
    }).service;
    expect(await racing.runOnce()).toBe(0);
    expect(await racing.runOnce()).toBe(0);
    expect((await attempts(changed.runId)).map((a) => [a.key, a.code])).toContainEqual(['-', 'incident_changed']);

    const stuck = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    // 每次提交前都有新版本：重试 BINDING_RETRY_LIMIT 次后停止
    const always = build(null, {
      beforeCreate: async () => {
        await bump(stuck.inc.incident_id);
      },
    }).service;
    for (let i = 0; i < BINDING_RETRY_LIMIT + 3; i++) {
      await report(stuck.inc.incident_id, (await currentVersion(stuck.inc.incident_id)) as number).catch(
        () => undefined,
      );
      await always.runOnce();
    }
    const r = await db.server.query<{ retries: number; code: string }>(
      "SELECT retries, code FROM server.remediation_attempts WHERE run_id = $1 AND key = 'gitops/noisy-alert-relax'",
      [stuck.runId],
    );
    expect(r.rows[0]).toEqual({ retries: BINDING_RETRY_LIMIT, code: 'binding_stale' });
  });

  it('gateway 开出 PR 后：从执行事件取得 PR，关联到事件 issue；消息里没有时按分支查 GitHub', async () => {
    const execId = 'a'.repeat(32);
    await db.server.query("UPDATE server.proposals SET state = 'dispatched' WHERE proposal_id = $1", [
      proposal.proposal_id,
    ]);
    await db.server.query(
      `UPDATE server.proposals SET body = jsonb_set(body, '{state}', '"dispatched"') WHERE proposal_id = $1`,
      [proposal.proposal_id],
    );
    await db.server.query(
      `INSERT INTO server.execution_events (event_id, cluster_id, execution_id, ticket_id, proposal_id, seq, phase, at, reason, body)
       VALUES ($1, $2, $3, $4, $5, 1, 'verified', now(), 'checks_passed', $6)`,
      [
        'e'.repeat(32),
        CLUSTER,
        execId,
        randomUUID(),
        proposal.proposal_id,
        JSON.stringify({ message: `pr_open: PR https://github.example.test/${REPO}/pull/41 #41 state=open` }),
      ],
    );
    gh.pulls.push({
      number: 41,
      head: (proposal.params as { branch: string }).branch,
      base: 'main',
      title: (proposal.params as { title: string }).title,
      body: (proposal.params as { body: string }).body,
    });
    const pulls = new GitOpsPulls(db.server, app, issues, metrics);
    expect(await pulls.runOnce()).toBe(1);
    const row = await db.server.query('SELECT url, number, branch FROM server.gitops_pulls WHERE proposal_id = $1', [
      proposal.proposal_id,
    ]);
    expect(row.rows).toEqual([
      {
        url: `https://github.example.test/${REPO}/pull/41`,
        number: 41,
        branch: (proposal.params as { branch: string }).branch,
      },
    ]);
    const link = await db.server.query(
      'SELECT kind, url, refs_in_body FROM server.github_issue_links WHERE incident_id = $1',
      [inc.incident_id],
    );
    expect(link.rows).toContainEqual({
      kind: 'pull',
      url: `https://github.example.test/${REPO}/pull/41`,
      refs_in_body: true,
    });
    expect(await pulls.runOnce()).toBe(0);

    // 第二个提议：执行事件没有 PR 消息，进入校验后按分支查到
    const other = {
      ...proposal,
      proposal_id: randomUUID(),
      params: { ...proposal.params, branch: 'srenautix/other-1' },
    };
    await db.server.query(
      `INSERT INTO server.proposals (proposal_id, idempotency_key, cluster_id, incident_id, action, level, tier, source, state,
         target_namespace, params, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'gitops_pr', $5, $6, 'rule', 'dispatched', NULL, $7, $8, now(), now())`,
      [
        other.proposal_id,
        `k:${other.proposal_id}`,
        CLUSTER,
        inc.incident_id,
        other.level,
        other.tier,
        JSON.stringify(other.params),
        JSON.stringify(other),
      ],
    );
    await db.server.query(
      `INSERT INTO server.execution_events (event_id, cluster_id, execution_id, ticket_id, proposal_id, seq, phase, at, reason, body)
       VALUES ($1, $2, $3, $4, $5, 1, 'verifying', now(), 'applied', '{}')`,
      ['f'.repeat(32), CLUSTER, 'b'.repeat(32), randomUUID(), other.proposal_id],
    );
    gh.pulls.push({ number: 77, head: 'srenautix/other-1', base: 'main', title: 't', body: '' });
    expect(await pulls.runOnce()).toBe(1);
    const second = await db.server.query('SELECT url FROM server.gitops_pulls WHERE proposal_id = $1', [
      other.proposal_id,
    ]);
    expect(second.rows).toEqual([{ url: `https://github.example.test/${REPO}/pull/77` }]);
  });

  it('gateway 仅提议（冻结）时：accepts_actions 含 gitops_pr 就照常签发；为空时不签发，原因码是 gateway_propose_only', async () => {
    const signed = build(generateKeyPairSync('ed25519').privateKey);
    const status = (accepts: string[]) =>
      db.server.query(
        `INSERT INTO server.spoke_status (cluster_id, gateway_id, version, leader, propose_only, conditions, queue, clock_skew,
           accepts_actions)
         VALUES ($1, 'gw-0', '0.1.0', true, true, '[]', '[]', '{"apiserver": 0}', $2)
         ON CONFLICT (cluster_id) DO UPDATE SET propose_only = true, accepts_actions = excluded.accepts_actions`,
        [CLUSTER, accepts],
      );
    const issued = (proposalId: string | null) =>
      db.server
        .query<{ n: number }>('SELECT count(*)::int AS n FROM server.approval_assertions WHERE proposal_id = $1', [
          proposalId,
        ])
        .then((r) => r.rows[0]!.n);

    await status(['gitops_pr']);
    const allowed = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    expect(await signed.service.runOnce()).toBe(1);
    const ok = (await attempts(allowed.runId)).find((a) => a.key === 'gitops/noisy-alert-relax')!;
    expect(ok).toMatchObject({ outcome: 'proposed' });
    expect(await issued(ok.proposal_id)).toBe(1);

    await status([]);
    await settle();
    const blocked = await seed('likely', { severity: 'critical', disposition: 'ignore' });
    expect(await signed.service.runOnce()).toBe(0);
    expect((await attempts(blocked.runId)).find((a) => a.key === 'gitops/noisy-alert-relax')).toMatchObject({
      outcome: 'skipped',
      code: 'gateway_propose_only',
    });
    await db.server.query('DELETE FROM server.spoke_status WHERE cluster_id = $1', [CLUSTER]);
  });
});

/**
 * 修复模板按研判根因匹配（ADR 0126），对应 Kind 的 config-resource-oom（kind-e2e 39628044289）：事件根因是管理 shop 的
 * Argo Application，研判根因是 Deployment shop/checkout，checkout 的容器被 OOMKilled。指标在真实 Prometheus 里。
 */
describe('研判根因', () => {
  const WORKLOADS_PATH = 'apps/shop/workloads.yaml';
  const WORKLOADS_FILE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: shop
spec:
  template:
    spec:
      containers:
        - name: checkout
          image: busybox
          resources:
            requests: {cpu: 5m, memory: 16Mi}
            limits: {cpu: 100m, memory: 32Mi}
`;
  const APP = 'Application.argoproj.io:argocd/shop';
  const appRoot: Incident['root'] = {
    component: APP,
    entity: { cluster_id: CLUSTER, kind: 'Application.argoproj.io', namespace: 'argocd', name: 'shop', uid: null },
    ambiguous: false,
    margin: 0.4,
    silent_root: false,
  };
  // 阶段 A 在 checkout 的 Pod 上执行的内存卡：OOMKilled，异常
  const memoryCard = (): EvidenceResult => ({
    ...stageACards()[0]!,
    card_id: 'workload/pod-restarts/memory',
    entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: 'checkout-56f4794c88-fbdsd', uid: null },
    verdict: 'abnormal',
    display_state: 'abnormal',
    reason: { kind: 'rule', text: '1 个容器被 OOM 终止' },
  });
  let prom: TsdbInstance;
  let oom: RemediationService;
  beforeEach(settle);

  beforeAll(async () => {
    const points = Array.from({ length: 61 }, (_, i) => ({ t: T - (60 - i) * 60_000, v: 1 }));
    prom = await startPrometheus([
      {
        labels: {
          __name__: 'kube_pod_container_status_last_terminated_reason',
          namespace: 'shop',
          pod: 'checkout-56f4794c88-fbdsd',
          container: 'checkout',
          reason: 'OOMKilled',
        },
        points,
      },
    ]);
    const source = await EvidenceSource.create({
      id: 'prometheus',
      url: prom.url,
      dialect: 'promql',
      bearerTokenFile: null,
      timeoutMs: 5_000,
    });
    gh.write('main', { [WORKLOADS_PATH]: WORKLOADS_FILE }, { message: 'shop workloads' });
    // 内存卡所在 Pod 的属主链：Pod → ReplicaSet → Deployment checkout（根因自己的卡，ADR 0139）；
    // web 的 Pod 属于另一个工作负载
    const at = new Date(T - 3600_000);
    const owned = (pod: string, rs: string, deploy: string): TopologyChange[] => [
      ...[`Pod:shop/${pod}`, `ReplicaSet:shop/${rs}`, `Deployment:shop/${deploy}`].map((key): TopologyChange => ({
        op: 'node_upsert',
        at,
        source: 'informer',
        node: {
          key,
          kind: key.split(':')[0]!,
          namespace: 'shop',
          name: key.split('/')[1]!,
          uid: `uid-${key.split('/')[1]!}`,
          labels: {},
          component_type: null,
          hub: false,
        },
      })),
      ...[
        [`Pod:shop/${pod}`, `ReplicaSet:shop/${rs}`],
        [`ReplicaSet:shop/${rs}`, `Deployment:shop/${deploy}`],
      ].map(([from, to]): TopologyChange => ({
        op: 'edge_upsert',
        at,
        source: 'informer',
        edge: {
          from: from!,
          to: to!,
          relation: 'owned_by',
          provenance: 'structural',
          confidence: 1,
          scope: 'service',
          evidence: 'ownerReference',
        },
      })),
    ];
    await new TopologyStore(db.server).apply(CLUSTER, [
      ...owned('checkout-56f4794c88-fbdsd', 'checkout-56f4794c88', 'checkout'),
      ...owned('web-7b8c9d0e1f-h3j5k', 'web-7b8c9d0e1f', 'web'),
    ]);
    oom = build(null, {
      files: { workloads: { path: WORKLOADS_PATH, format: 'yaml' } },
      dataSource: () => source.dataSource(Date.now()),
      categories: ['config_resource'],
      conclusions: ['likely', 'evidence_consistent', 'inconclusive'],
    }).service;
  }, 120_000);

  afterAll(async () => {
    await prom?.stop();
  });

  it('事件根因是 Application、研判根因是 Deployment：memory-limit-raise 按 checkout 生成补丁，limit 乘 1.5', async () => {
    const s = await seed('likely', { root: appRoot, researchRoot: 'Deployment:shop/checkout', cards: [memoryCard()] });
    expect(await oom.runOnce()).toBe(1);
    const rows = await attempts(s.runId);
    expect(rows).toEqual([
      {
        key: 'gitops/memory-limit-raise',
        outcome: 'proposed',
        code: null,
        proposal_id: expect.any(String),
        branch: expect.stringMatching(new RegExp(`^srenautix/${s.inc.incident_id.slice(0, 8)}-config-resource-`)),
      },
    ]);
    const p = await db.server.query<{ body: Proposal }>('SELECT body FROM server.proposals WHERE proposal_id = $1', [
      rows[0]!.proposal_id,
    ]);
    const proposal = p.rows[0]!.body;
    const params = proposal.params as { title: string; patch: string };
    expect(params.patch).toContain(`diff --git a/${WORKLOADS_PATH} b/${WORKLOADS_PATH}`);
    const after = applyPatch(WORKLOADS_FILE, params.patch) as string;
    expect(after).toContain('limits: {cpu: 100m, memory: 48Mi}');
    expect(after.replace('memory: 48Mi', 'memory: 32Mi')).toBe(WORKLOADS_FILE);
    // 标题写研判根因；提议仍绑定事件的根因（提议服务按事件核对绑定）
    expect(params.title).toMatch(/：Deployment:shop\/checkout$/);
    expect(proposal.binding.root_component).toBe(APP);
  });

  it('OOMKilled 的是另一个工作负载的 Pod：研判根因 checkout 自己的内存卡没有异常，memory-limit-raise 不适用', async () => {
    const other: EvidenceResult = {
      ...memoryCard(),
      entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: 'web-7b8c9d0e1f-h3j5k', uid: null },
    };
    const s = await seed('likely', { root: appRoot, researchRoot: 'Deployment:shop/checkout', cards: [other] });
    expect(await oom.runOnce()).toBe(0);
    expect(await attempts(s.runId)).toEqual([
      { key: '-', outcome: 'skipped', code: 'no_template', proposal_id: null, branch: null },
    ]);
  });

  it('研判结论低于 likely 时退回事件根因：Application 上没有适用的配置模板', async () => {
    const s = await seed('inconclusive', {
      root: appRoot,
      researchRoot: 'Deployment:shop/checkout',
      cards: [memoryCard()],
    });
    expect(await oom.runOnce()).toBe(0);
    expect(await attempts(s.runId)).toEqual([
      { key: '-', outcome: 'skipped', code: 'no_template', proposal_id: null, branch: null },
    ]);
  });

  it('研判根因是 Service：展开到它选中的 Pod 所属的工作负载', async () => {
    const topo = new TopologyStore(db.server);
    const at = new Date(T - 3600_000);
    const node = (kind: string, name: string) => ({
      key: `${kind}:shop/${name}`,
      kind,
      namespace: 'shop',
      name,
      uid: `uid-${name}`,
      labels: {},
      component_type: null,
      hub: false,
    });
    const edge = (from: string, relation: 'selects' | 'owned_by', to: string) => ({
      from,
      to,
      relation,
      provenance: 'structural' as const,
      confidence: 1,
      scope: 'service' as const,
      evidence: relation === 'selects' ? 'spec.selector' : 'ownerReference',
    });
    await topo.apply(CLUSTER, [
      { op: 'node_upsert', at, source: 'informer', node: node('Service', 'checkout') },
      { op: 'node_upsert', at, source: 'informer', node: node('Deployment', 'checkout') },
      { op: 'node_upsert', at, source: 'informer', node: node('ReplicaSet', 'checkout-56f4794c88') },
      { op: 'node_upsert', at, source: 'informer', node: node('Pod', 'checkout-56f4794c88-fbdsd') },
      {
        op: 'edge_upsert',
        at,
        source: 'informer',
        edge: edge('Service:shop/checkout', 'selects', 'Pod:shop/checkout-56f4794c88-fbdsd'),
      },
      {
        op: 'edge_upsert',
        at,
        source: 'informer',
        edge: edge('Pod:shop/checkout-56f4794c88-fbdsd', 'owned_by', 'ReplicaSet:shop/checkout-56f4794c88'),
      },
      {
        op: 'edge_upsert',
        at,
        source: 'informer',
        edge: edge('ReplicaSet:shop/checkout-56f4794c88', 'owned_by', 'Deployment:shop/checkout'),
      },
    ]);
    const expander = new ComponentExpander(topo);
    expect(await expander.concrete(CLUSTER, 'Service:shop/checkout', new Date())).toEqual({
      key: 'Deployment:shop/checkout',
      kind: 'Deployment',
      namespace: 'shop',
      name: 'checkout',
      uid: 'uid-checkout',
    });
    expect((await expander.concrete(CLUSTER, 'Pod:shop/checkout-56f4794c88-fbdsd', new Date())).key).toBe(
      'Deployment:shop/checkout',
    );
    expect((await expander.concrete(CLUSTER, APP, new Date())).key).toBe(APP);

    const s = await seed('likely', { root: appRoot, researchRoot: 'Service:shop/checkout', cards: [memoryCard()] });
    expect(await oom.runOnce()).toBe(1);
    expect(await attempts(s.runId)).toEqual([
      expect.objectContaining({ key: 'gitops/memory-limit-raise', outcome: 'proposed' }),
    ]);
  });
});

/**
 * 修改去重（ADR 0155）：同一条未覆盖的告警在多个事件里反复触发，基准提交在两次触发之间前进，补丁只差上下文与行号。
 * gateway 开出 PR 由执行事件与 FakeGitHub 里的 PR 表示（与"gateway 开出 PR 后"相同）
 */
describe('修改去重', () => {
  const ALERT = 'ShopCacheEvictions';
  const PR = 900;
  let svc: RemediationService;
  let firstProposal: string;

  beforeAll(async () => {
    await settle();
    ({ service: svc } = build(null, { issuesPerHour: 100 }));
  });

  const catalogAttempt = async (runId: string) =>
    (await attempts(runId)).find((a) => a.key === 'gitops/alert-catalog-entry');
  const pullComments = () => gh.comments.get(PR) ?? [];
  const catalogProposals = async (alertname: string) =>
    (
      await db.server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM server.proposals WHERE action = 'gitops_pr' AND params->>'patch' LIKE $1`,
        [`%alertname: ${alertname},%`],
      )
    ).rows[0]!.n;

  /** gateway 开出 PR：提议进入 dispatched，执行事件带 PR 地址，FakeGitHub 里有这个 PR；GitOpsPulls 记下它 */
  const open = async (proposalId: string, number: number) => {
    const p = (
      await db.server.query<{ body: Proposal }>('SELECT body FROM server.proposals WHERE proposal_id = $1', [
        proposalId,
      ])
    ).rows[0]!.body;
    const params = p.params as { branch: string; title: string; body: string };
    await db.server.query(
      `UPDATE server.proposals SET state = 'dispatched', body = jsonb_set(body, '{state}', '"dispatched"') WHERE proposal_id = $1`,
      [proposalId],
    );
    await db.server.query(
      `INSERT INTO server.execution_events (event_id, cluster_id, execution_id, ticket_id, proposal_id, seq, phase, at, reason, body)
       VALUES ($1, $2, $3, $4, $5, 1, 'verified', now(), 'checks_passed', $6)`,
      [
        randomUUID().replace(/-/g, ''),
        CLUSTER,
        randomUUID().replace(/-/g, ''),
        randomUUID(),
        proposalId,
        JSON.stringify({
          message: `pr_open: PR https://github.example.test/${REPO}/pull/${number} #${number} state=open`,
        }),
      ],
    );
    gh.pulls.push({ number, head: params.branch, base: 'main', title: params.title, body: params.body });
    await new GitOpsPulls(db.server, app, issues, metrics).runOnce();
    const row = await db.server.query('SELECT number FROM server.gitops_pulls WHERE proposal_id = $1', [proposalId]);
    expect(row.rows).toEqual([{ number }]);
  };

  it('同一个修改：提议还没有开出 PR、PR 打开时都不再提议；PR 开出后每次触发评论一次，新事件的 issue 关联到 PR', async () => {
    const first = await seed('likely', { alertname: ALERT });
    expect(await svc.runOnce()).toBe(1);
    const a1 = await catalogAttempt(first.runId);
    expect(a1).toMatchObject({ outcome: 'proposed' });
    firstProposal = a1!.proposal_id!;

    // 基准提交前进：目录在末尾多了一条，新补丁的上下文与行号都变了，增加的行相同（CCHP #289 与 #297 的情形）
    const catalog = gh.branches.get('main')!.get(CATALOG_PATH)!;
    gh.write(
      'main',
      {
        [CATALOG_PATH]: `${catalog}  - { id: shop-pod-pending, alertname: ShopPodPending, role: cause, entity: { kind: Pod, name_labels: [pod] } }\n`,
      },
      { message: 'catalog: add ShopPodPending' },
    );
    const second = await seed('likely', { alertname: ALERT });
    expect(await svc.runOnce()).toBe(0);
    expect(await catalogAttempt(second.runId)).toMatchObject({
      outcome: 'skipped',
      code: 'duplicate_pending',
      proposal_id: null,
    });

    await open(firstProposal, PR);
    const third = await seed('likely', { alertname: ALERT });
    expect(await svc.runOnce()).toBe(0);
    expect(await catalogAttempt(third.runId)).toMatchObject({ outcome: 'skipped', code: 'duplicate_open' });

    // 只有一个提议、一个 PR；第二、第三个事件各一条评论，带标记与新事件 issue 的 Refs
    expect(await catalogProposals(ALERT)).toBe(1);
    expect(gh.pulls.filter((p) => p.body.includes(ALERT))).toHaveLength(1);
    const comments = pullComments();
    expect(comments).toHaveLength(2);
    for (const [i, incidentId] of [second, third].map((s) => s.inc.incident_id).entries()) {
      const issue = await issues.issueOf(incidentId);
      expect(issue).not.toBeNull();
      expect(comments[i]!.body).toContain(`<!-- srenautix:trigger=${incidentId} -->`);
      expect(comments[i]!.body).toContain(`https://srenautix.example.test/incidents/${incidentId}`);
      expect(comments[i]!.body).toContain(`Refs #${issue!.number}`);
    }
    const audit = await db.server.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.governance_audit WHERE kind = 'remediation.trigger_comment'",
    );
    expect(audit.rows[0]!.n).toBe(2);

    // 事件 issue 的后台循环：新事件的 issue 里回链 PR，PR 描述补上它们的 Refs
    await issues.runOnce();
    const pr = gh.pulls.find((p) => p.number === PR)!;
    for (const incidentId of [second, third].map((s) => s.inc.incident_id)) {
      const issue = (await issues.issueOf(incidentId))!;
      expect(pr.body).toContain(`Refs #${issue.number}`);
      expect((gh.comments.get(issue.number) ?? []).map((c) => c.body).join('\n')).toContain(
        `https://github.example.test/${REPO}/pull/${PR}`,
      );
    }

    // 同一事件的后续轮次不重复评论
    expect(await svc.runOnce()).toBe(0);
    expect(pullComments()).toHaveLength(2);
  });

  it('server 重启后照常去重：记录在 PostgreSQL；去重表建立之前的提议按尝试记录补登记', async () => {
    // 新的服务实例，并清掉修改与触发的记录（相当于升级之前已经开出的 PR）
    await db.server.query('DELETE FROM server.remediation_triggers');
    await db.server.query('DELETE FROM server.remediation_changes');
    const restarted = build(null, { issuesPerHour: 100 }).service;
    const fourth = await seed('likely', { alertname: ALERT });
    expect(await restarted.runOnce()).toBe(0);
    expect(await catalogAttempt(fourth.runId)).toMatchObject({ outcome: 'skipped', code: 'duplicate_open' });
    const row = await db.server.query<{ state: string; pr_number: number }>(
      'SELECT state, pr_number FROM server.remediation_changes WHERE proposal_id = $1',
      [firstProposal],
    );
    expect(row.rows).toEqual([{ state: 'open', pr_number: PR }]);
    expect(await catalogProposals(ALERT)).toBe(1);
    expect(pullComments()).toHaveLength(3);
    expect(pullComments()[2]!.body).toContain(`<!-- srenautix:trigger=${fourth.inc.incident_id} -->`);
  });

  it('人关闭 PR 且没有合并：同一个修改不再提出；同一模板对同一文件的其他修改在冷却期内不提出', async () => {
    gh.close(PR, false);
    const fifth = await seed('likely', { alertname: ALERT });
    expect(await svc.runOnce()).toBe(0);
    expect(await catalogAttempt(fifth.runId)).toMatchObject({ outcome: 'skipped', code: 'rejected_before' });
    const state = await db.server.query<{ state: string; closed_at: Date | null }>(
      'SELECT state, closed_at FROM server.remediation_changes WHERE proposal_id = $1',
      [firstProposal],
    );
    expect(state.rows[0]).toMatchObject({ state: 'rejected', closed_at: expect.any(Date) });
    // 被拒绝的 PR 上不再评论
    expect(pullComments()).toHaveLength(3);

    // 另一条未覆盖的告警：同一模板、同一个目录文件，冷却期（7 天）内不提出
    const variant = await seed('likely', { alertname: 'ShopCacheMisses' });
    expect(await svc.runOnce()).toBe(0);
    expect(await catalogAttempt(variant.runId)).toMatchObject({ outcome: 'skipped', code: 'rejected_cooldown' });
    expect(await catalogProposals('ShopCacheMisses')).toBe(0);

    // 冷却期为 0 时只记住被拒绝的那一个修改：其他告警的条目照常提出，被拒绝的修改仍然不提
    const relaxed = build(null, { issuesPerHour: 100, cooldownMs: 0 }).service;
    const other = await seed('likely', { alertname: 'ShopCacheMisses' });
    expect(await relaxed.runOnce()).toBe(1);
    expect(await catalogAttempt(other.runId)).toMatchObject({ outcome: 'proposed' });
    const same = await seed('likely', { alertname: ALERT });
    expect(await relaxed.runOnce()).toBe(0);
    expect(await catalogAttempt(same.runId)).toMatchObject({ outcome: 'skipped', code: 'rejected_before' });
    expect(await catalogProposals(ALERT)).toBe(1);
  });
});

/**
 * 模板上下文里告警的拓扑事实（ADR 0155），经真实的拓扑存储与组件展开：只带分组标签、逻辑组件在拓扑里没有对象的告警不加
 * 目录条目；外部上游的告警不降级
 */
describe('告警的拓扑事实', () => {
  beforeEach(settle);

  const reason = async (runId: string, key: string) =>
    (
      await db.server.query<{ code: string; reason: string }>(
        'SELECT code, reason FROM server.remediation_attempts WHERE run_id = $1 AND key = $2',
        [runId, key],
      )
    ).rows[0];

  it('规则声明没有实体、只带 component: workload：拓扑里没有对应的对象，目录条目模板跳过并说明要在规则上补实体', async () => {
    const s = await seed('likely', {
      alertname: 'ShopGatewayOverProvisioned',
      alert: {
        labels: { component: 'workload', role: 'cause', entity_kind: 'none', entity: '' },
        component: 'component:workload',
        entity: null,
      },
    });
    expect(await service.runOnce()).toBe(0);
    expect(await reason(s.runId, 'gitops/alert-catalog-entry')).toEqual({
      code: 'skip_if',
      reason:
        '告警 ShopGatewayOverProvisioned 给不出实体：规则声明没有实体（entity_kind 为 none），只带分组标签 workload，' +
        '这个逻辑组件在拓扑里没有对应的对象。目录条目不会改变它的归属，需要在告警规则上加 entity 与 entity_kind 标签',
    });
  });

  it('只带 service 标签、同名 Service 选中一个工作负载：实体为逻辑组件，条目带 role_confidence', async () => {
    const at = new Date(T - 3600_000);
    const node = (kind: string, name: string) => ({
      key: `${kind}:shop/${name}`,
      kind,
      namespace: 'shop',
      name,
      uid: `uid-${kind}-${name}`,
      labels: {},
      component_type: null,
      hub: false,
    });
    const edge = (from: string, relation: 'selects' | 'owned_by', to: string) => ({
      from,
      to,
      relation,
      provenance: 'structural' as const,
      confidence: 1,
      scope: 'service' as const,
      evidence: relation === 'selects' ? 'spec.selector' : 'ownerReference',
    });
    await new TopologyStore(db.server).apply(CLUSTER, [
      { op: 'node_upsert', at, source: 'informer', node: node('Service', 'catalog') },
      { op: 'node_upsert', at, source: 'informer', node: node('Deployment', 'catalog-api') },
      { op: 'node_upsert', at, source: 'informer', node: node('Pod', 'catalog-api-0') },
      {
        op: 'edge_upsert',
        at,
        source: 'informer',
        edge: edge('Service:shop/catalog', 'selects', 'Pod:shop/catalog-api-0'),
      },
      {
        op: 'edge_upsert',
        at,
        source: 'informer',
        edge: edge('Pod:shop/catalog-api-0', 'owned_by', 'Deployment:shop/catalog-api'),
      },
    ]);
    const s = await seed('likely', {
      alertname: 'ShopCatalogStale',
      alert: { labels: { service: 'catalog' }, component: 'component:catalog', entity: null },
    });
    // 上一组用例在同一个目录文件上被拒绝过一个条目：这里不用冷却期
    expect(await build(null, { cooldownMs: 0 }).service.runOnce()).toBe(1);
    const a = (await attempts(s.runId)).find((x) => x.key === 'gitops/alert-catalog-entry');
    expect(a).toMatchObject({ outcome: 'proposed' });
    const p = await db.server.query<{ params: { patch: string; body: string } }>(
      'SELECT params FROM server.proposals WHERE proposal_id = $1',
      [a!.proposal_id],
    );
    expect(p.rows[0]!.params.patch).toContain(
      '+  - { id: shop-catalog-stale, alertname: ShopCatalogStale, role: cause, role_confidence: 0.3, entity: { kind: component, name_labels: [ service ] } }',
    );
    expect(p.rows[0]!.params.body).toContain('这个逻辑组件在拓扑里对应 Deployment:shop/catalog-api');
  });

  it('外部上游汇总配置里的告警：根因不是外部组件、研判为 ignore 也不降级；配置为空时同一事件会降级', async () => {
    const provider = {
      labels: { component: 'provider', provider_id: 'p1' },
      component: 'component:provider',
      entity: null,
    };
    const external = build(null, { externalAlerts: { components: ['component:provider'], alertLabels: {} } }).service;
    const s = await seed('likely', { severity: 'critical', disposition: 'ignore', alert: provider });
    expect(await external.runOnce()).toBe(0);
    expect((await attempts(s.runId)).map((x) => x.key)).not.toContain('gitops/noisy-alert-relax');

    // 只配置告警标签条件时，满足条件的告警同样不降级
    const byLabel = build(null, { externalAlerts: { components: [], alertLabels: { provider_id: ['p1'] } } }).service;
    const t = await seed('likely', { severity: 'critical', disposition: 'ignore', alert: provider });
    expect(await byLabel.runOnce()).toBe(0);
    expect((await attempts(t.runId)).map((x) => x.key)).not.toContain('gitops/noisy-alert-relax');

    const plain = await seed('likely', { severity: 'critical', disposition: 'ignore', alert: provider });
    expect(await service.runOnce()).toBe(1);
    expect((await attempts(plain.runId)).find((x) => x.key === 'gitops/noisy-alert-relax')).toMatchObject({
      outcome: 'proposed',
    });
  });
});
