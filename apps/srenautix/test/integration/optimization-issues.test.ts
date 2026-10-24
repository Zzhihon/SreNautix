import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApp, GitHubDenied, RepoRoles } from '../../src/github/app.js';
import { OptimizationIssues, type IssueContent } from '../../src/github/optimization-issues.js';
import { recommendationMarker } from '../../src/optimize/render.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';

/**
 * 业务仓库的 issue（ADR 0146 §4.5）与事件 issue（ADR 0095）同一套去重与找回机制，键是 recommendation_id：
 * 创建请求的结果未知（连接中断、5xx）时下一次先按标记找回，重试不会重复开 issue；结果明确的失败（4xx）照常重建。
 * 不变量 15：业务仓库角色的白名单之外的请求（PR、写文件、改 issue 标签与状态）不发出，假 GitHub 收不到。
 */
const BIZ = 'CCH-HQ/claude-code-hub-plus';
const OPS = 'acme/ops';
const app = generateKeyPairSync('rsa', { modulusLength: 2048 });

let db: TestDb;
let gh: FakeGitHub;
let client: GitHubApp;
let issues: OptimizationIssues;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  gh = new FakeGitHub('7001', '71', app.publicKey, BIZ);
  await gh.start();
  client = new GitHubApp(
    {
      apiBase: gh.url,
      appId: '7001',
      installationId: '71',
      privateKey: app.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    },
    Date.now,
    new RepoRoles([
      [OPS, 'ops'],
      [BIZ, 'business'],
    ]),
  );
  issues = new OptimizationIssues(db.server, client);
});

afterAll(async () => {
  await gh?.stop();
  await db?.close();
});

async function recommendation(): Promise<string> {
  const id = randomUUID();
  await db.server.query(
    `INSERT INTO server.optimization_recommendations (recommendation_id, cluster_id, finding, goal_id, run_id, kind, template,
       state, repository, body)
     VALUES ($1, 'c1', $2, $3, $4, 'business_issue', 'postgres/slow-statement', 'open', $5, '{}')`,
    [id, `sha256:${'c'.repeat(64)}`, randomUUID(), randomUUID(), BIZ],
  );
  return id;
}

const content = (id: string): IssueContent => ({
  title: '[优化] 慢语句：补索引或改写查询',
  body: `正文\n\n${recommendationMarker(id)}`,
  labels: ['srenautix', 'srenautix:database'],
});

const posts = () => gh.requests.filter((r) => r.method === 'POST' && r.path === `/repos/${BIZ}/issues`).length;
const withMarker = (id: string) => gh.issues.filter((i) => i.body.includes(recommendationMarker(id)));
const row = async (id: string) =>
  (
    await db.admin.query<{ issue_state: string | null; attempts: number }>(
      'SELECT issue_state, attempts FROM server.optimization_recommendations WHERE recommendation_id = $1',
      [id],
    )
  ).rows[0]!;

describe('业务仓库的 issue', () => {
  it('创建之后连接断开：下一次按标记找回同一个 issue，不重复开', async () => {
    const id = await recommendation();
    const before = posts();
    gh.fault('POST', new RegExp(`^/repos/${BIZ}/issues$`), 'drop_after');
    const first = await issues.deliver(id, async () => content(id));
    expect(first.kind).toBe('retry');
    expect(await row(id)).toMatchObject({ issue_state: 'unknown', attempts: 1 });
    expect(withMarker(id)).toHaveLength(1);

    let rendered = 0;
    const second = await issues.deliver(id, async () => {
      rendered++;
      return content(id);
    });
    expect(second).toMatchObject({ kind: 'opened', recovered: true, number: withMarker(id)[0]!.number });
    expect(rendered).toBe(0);
    expect(posts() - before).toBe(1);
    expect(withMarker(id)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ issue_state: 'open' });
  });

  it('5xx 之后找不到标记才再次创建；多次重试始终只有一个 issue', async () => {
    const id = await recommendation();
    gh.fault('POST', new RegExp(`^/repos/${BIZ}/issues$`), 502, 2);
    expect((await issues.deliver(id, async () => content(id))).kind).toBe('retry');
    expect((await issues.deliver(id, async () => content(id))).kind).toBe('retry');
    expect(await row(id)).toMatchObject({ issue_state: 'unknown', attempts: 2 });
    const r = await issues.deliver(id, async () => content(id));
    expect(r).toMatchObject({ kind: 'opened', recovered: false });
    expect(withMarker(id)).toHaveLength(1);
    // 已经开出之后再投递（例如并发的另一轮）同样只按标记找回
    await db.server.query(
      "UPDATE server.optimization_recommendations SET issue_state = 'unknown' WHERE recommendation_id = $1",
      [id],
    );
    expect(await issues.deliver(id, async () => content(id))).toMatchObject({ kind: 'opened', recovered: true });
    expect(withMarker(id)).toHaveLength(1);
  });

  it('结果明确的失败（422）记为 pending，下一次直接创建', async () => {
    const id = await recommendation();
    gh.fault('POST', new RegExp(`^/repos/${BIZ}/issues$`), 422);
    expect((await issues.deliver(id, async () => content(id))).kind).toBe('retry');
    expect(await row(id)).toMatchObject({ issue_state: 'pending' });
    expect(await issues.deliver(id, async () => content(id))).toMatchObject({ kind: 'opened', recovered: false });
    expect(withMarker(id)).toHaveLength(1);
  });
});

describe('不变量 15：业务仓库只读代码，写入只有 issue 与评论', () => {
  it('白名单之外的请求不发出，假 GitHub 收不到', async () => {
    const before = gh.requests.length;
    const denied: Array<[string, string, unknown]> = [
      ['POST', `/repos/${BIZ}/pulls`, { head: 'x', base: 'dev', title: 't' }],
      ['PUT', `/repos/${BIZ}/contents/internal/db.go`, { message: 'm', content: 'eA==' }],
      ['POST', `/repos/${BIZ}/git/refs`, { ref: 'refs/heads/x', sha: 'a'.repeat(40) }],
      ['PATCH', `/repos/${BIZ}/issues/1`, { state: 'closed' }],
      ['PATCH', `/repos/${BIZ}/issues/1`, { labels: ['x'] }],
      ['GET', `/repos/${BIZ}/pulls/1`, undefined],
      ['GET', `/repos/${BIZ}/git/ref/heads/dev`, undefined],
      ['PUT', `/repos/${BIZ}/pulls/1/merge`, {}],
      ['GET', '/repos/CCH-HQ/unlisted/issues', undefined],
    ];
    for (const [m, p, b] of denied) {
      await expect(client.api(m, p, b, 'probe'), `${m} ${p}`).rejects.toBeInstanceOf(GitHubDenied);
    }
    expect(gh.requests.length).toBe(before);
  });
});
