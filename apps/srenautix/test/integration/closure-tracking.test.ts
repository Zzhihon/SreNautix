import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApp } from '../../src/github/app.js';
import { ClosureTracker } from '../../src/github/closures.js';
import { ServerMetrics } from '../../src/metrics.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import { RemediationChanges } from '../../src/remediation/dedupe.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { incident as baseIncident } from '../support/scenario.js';

/**
 * 关闭的跟踪（ADR 0174）：真实 PostgreSQL 与测试中的 GitHub REST API。定时任务刷新打开的自愈 PR 与事件 issue：
 * PR 关闭且没有合并时写隐式反馈 pr_closed（reason 是关闭之前的最后一条人工评论），以 not planned 关闭的 issue 写
 * issue_not_planned，两者都生成评测候选（ADR 0175）；合并的 PR 与以 completed 关闭的 issue 不写反馈。
 */
const REPO = 'acme/ops';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const metrics = new ServerMetrics('server', false);

let db: TestDb;
let gh: FakeGitHub;
let tracker: ClosureTracker;
let feedback: FeedbackService;

async function newIncident(): Promise<string> {
  const id = randomUUID();
  const inc = { ...baseIncident(), incident_id: id, label: `StatefulSet:shop/postgres:${id}` };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, 'firing', 'critical', $5, $6, $7)`,
    [
      id,
      inc.cluster_id,
      inc.label,
      inc.incident_version,
      new Date(inc.first_firing_at),
      inc.root.component,
      JSON.stringify(inc),
    ],
  );
  return id;
}

/** 一个已经开出 PR 的自愈修改（PR 打开），以及产生它的研判 */
async function openChange(number: number): Promise<{ incidentId: string; runId: string; proposalId: string }> {
  const incidentId = await newIncident();
  const runId = randomUUID();
  const proposalId = randomUUID();
  await db.server.query(
    `INSERT INTO server.remediation_attempts (run_id, key, incident_id, incident_version, outcome, proposal_id)
     VALUES ($1, 'gitops/noisy-alert-relax', $2, 2, 'proposed', $3)`,
    [runId, incidentId, proposalId],
  );
  await db.server.query(
    `INSERT INTO server.remediation_changes (proposal_id, repository, change_hash, key, files, incident_id, state, pr_number, pr_url)
     VALUES ($1, $2, $3, 'gitops/noisy-alert-relax', '[]', $4, 'open', $5, $6)`,
    [proposalId, REPO, randomUUID(), incidentId, number, `https://github.example.test/${REPO}/pull/${number}`],
  );
  gh.pulls.push({ number, head: `srenautix/${number}`, base: 'main', title: `fix ${number}`, body: '' });
  return { incidentId, runId, proposalId };
}

/** 一个已经开出的事件 issue */
async function openIssue(number: number): Promise<string> {
  const incidentId = await newIncident();
  await db.server.query(
    `INSERT INTO server.github_issues (incident_id, repo, state, reason, number, url, opened_at)
     VALUES ($1, $2, 'open', 'escalate', $3, $4, now())`,
    [incidentId, REPO, number, `https://github.example.test/${REPO}/issues/${number}`],
  );
  gh.issues.push({ number, title: `issue ${number}`, body: '', labels: ['srenautix'], created: Date.now() });
  return incidentId;
}

const feedbackOf = async (incidentId: string) =>
  (
    await db.server.query(
      `SELECT implicit, channel, principal_id, linked, reason, research_run_id FROM server.feedback
        WHERE incident_id = $1 ORDER BY created_at`,
      [incidentId],
    )
  ).rows;
const candidatesOf = async (incidentId: string) =>
  (
    await db.server.query(
      'SELECT source, source_ref, suggested_type, state, research_run_id FROM server.eval_candidates WHERE incident_id = $1',
      [incidentId],
    )
  ).rows;

beforeAll(async () => {
  gh = new FakeGitHub('1', '2', key.publicKey, REPO);
  await gh.start();
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const app = new GitHubApp({ apiBase: gh.url, appId: '1', installationId: '2', privateKey: pem });
  feedback = new FeedbackService(db.server, metrics);
  const closed = (
    c: Parameters<FeedbackService['recordClosure']>[0],
    x: Parameters<FeedbackService['recordClosure']>[1],
  ) => feedback.recordClosure(c, x);
  tracker = new ClosureTracker(db.server, app, new RemediationChanges(db.server, app, 0, closed), closed, 2);
});

afterAll(async () => {
  await db?.close();
  await gh?.stop();
});

describe('自愈 PR 的关闭', () => {
  it('关闭且没有合并：隐式反馈 pr_closed 带关闭者与关闭之前的最后一条人工评论，生成候选；合并的不写反馈', async () => {
    const rejected = await openChange(11);
    const merged = await openChange(12);
    const still = await openChange(13);
    const t = Date.now();
    gh.comment(11, '<!-- srenautix:trigger=x -->\n同一个修改再次被触发', new Date(t - 120_000));
    gh.comment(11, '阈值是有意设的', new Date(t - 90_000));
    gh.close(11, false, new Date(t - 60_000), 'alice');
    gh.comment(11, '关闭之后的补充', new Date(t - 30_000));
    gh.close(12, true, new Date(t - 60_000), 'bob');

    expect(await tracker.runOnce()).toEqual({ pulls: 2, issues: 0 });
    expect(await feedbackOf(rejected.incidentId)).toEqual([
      {
        implicit: 'pr_closed',
        channel: 'github',
        principal_id: 'github:alice',
        linked: false,
        reason: '阈值是有意设的',
        research_run_id: rejected.runId,
      },
    ]);
    expect(await candidatesOf(rejected.incidentId)).toEqual([
      {
        source: 'pr_closed',
        source_ref: `https://github.example.test/${REPO}/pull/11`,
        suggested_type: null,
        state: 'pending',
        research_run_id: rejected.runId,
      },
    ]);
    expect(await feedbackOf(merged.incidentId)).toEqual([]);
    expect(await candidatesOf(merged.incidentId)).toEqual([]);
    const states = await db.server.query<{ proposal_id: string; state: string }>(
      'SELECT proposal_id, state FROM server.remediation_changes ORDER BY pr_number',
    );
    expect(states.rows.map((r) => r.state)).toEqual(['rejected', 'merged', 'open']);
    expect(await feedbackOf(still.incidentId)).toEqual([]);

    // 已关闭的不再读取，下一轮只检查仍打开的；同一个关闭不会写第二次
    const before = gh.requests.length;
    expect(await tracker.runOnce()).toEqual({ pulls: 0, issues: 0 });
    expect(gh.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([`GET /repos/${REPO}/pulls/13`]);
    expect(await feedbackOf(rejected.incidentId)).toHaveLength(1);
  });

  it('每个仓库每轮最多刷新 perRepo 个，最久没有检查的在前', async () => {
    await db.server.query("UPDATE server.remediation_changes SET state = 'merged' WHERE state = 'open'");
    const a = await openChange(21);
    const b = await openChange(22);
    const c = await openChange(23);
    for (const n of [21, 22, 23]) {
      gh.close(n, false, new Date(Date.now() - 10_000), 'carol');
    }
    expect((await tracker.runOnce()).pulls).toBe(2);
    expect((await tracker.runOnce()).pulls).toBe(1);
    for (const x of [a, b, c]) {
      expect((await feedbackOf(x.incidentId)).map((f) => [f.implicit, f.reason])).toEqual([['pr_closed', null]]);
    }
  });
});

describe('事件 issue 的关闭', () => {
  it('以 not planned 关闭写隐式反馈 issue_not_planned 与候选；以 completed 关闭只记关闭时刻；打开的只更新检查时间', async () => {
    const notPlanned = await openIssue(31);
    const completed = await openIssue(32);
    const open = await openIssue(33);
    await db.server.query(
      `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, started_at, finished_at)
       VALUES ($1, $2, 2, 'new', 'completed', now() - interval '5 minutes', now() - interval '4 minutes')`,
      [randomUUID(), notPlanned],
    );
    gh.closeIssue(31, 'not_planned', 'dave');
    gh.closeIssue(32, 'completed', 'erin');

    // perRepo 为 2：先读两个最久没有检查的，第二轮读第三个
    const first = await tracker.runOnce();
    const second = await tracker.runOnce();
    expect(first.issues + second.issues).toBe(2);
    const fb = await feedbackOf(notPlanned);
    expect(fb).toEqual([
      {
        implicit: 'issue_not_planned',
        channel: 'github',
        principal_id: 'github:dave',
        linked: false,
        reason: null,
        research_run_id: expect.any(String),
      },
    ]);
    expect(await candidatesOf(notPlanned)).toEqual([
      expect.objectContaining({
        source: 'issue_not_planned',
        source_ref: `https://github.example.test/${REPO}/issues/31`,
        suggested_type: null,
      }),
    ]);
    expect(await feedbackOf(completed)).toEqual([]);
    const rows = await db.server.query<{
      number: number;
      state: string;
      state_reason: string | null;
      closed: boolean;
      checked: boolean;
    }>(
      `SELECT number, state, state_reason, closed_at IS NOT NULL AS closed, checked_at IS NOT NULL AS checked
         FROM server.github_issues WHERE incident_id = ANY($1::uuid[]) ORDER BY number`,
      [[notPlanned, completed, open]],
    );
    // issue 的状态不变（进展评论照常追加），关闭时刻与原因另记
    expect(rows.rows).toEqual([
      { number: 31, state: 'open', state_reason: 'not_planned', closed: true, checked: true },
      { number: 32, state: 'open', state_reason: 'completed', closed: true, checked: true },
      { number: 33, state: 'open', state_reason: null, closed: false, checked: true },
    ]);
    const audit = await db.server.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.governance_audit WHERE kind = 'github.issue_closed'",
    );
    expect(audit.rows[0]!.n).toBe(2);
    // 关闭不是对结论的评价：事件的最新反馈里没有它
    expect((await feedback.latest(db.server, [notPlanned])).size).toBe(0);
  });

  it('GitHub 请求失败只记日志，留到下一轮', async () => {
    const id = await openIssue(41);
    gh.fault('GET', /\/issues\/41$/, 502);
    gh.closeIssue(41, 'not_planned', 'frank');
    await tracker.runOnce();
    expect(await feedbackOf(id)).toEqual([]);
    await tracker.runOnce();
    await tracker.runOnce();
    expect((await feedbackOf(id)).map((f) => f.implicit)).toEqual(['issue_not_planned']);
  });
});
