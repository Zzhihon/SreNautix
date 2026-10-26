import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Incident } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApp } from '../../src/github/app.js';
import { COVERAGE_LABEL, CoverageIssues, coverageMarker } from '../../src/github/coverage-issues.js';
import { IssueService } from '../../src/github/issues.js';
import { upsertAlert } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { tx } from '../../src/store/pool.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { incident as baseIncident } from '../support/scenario.js';

/**
 * 覆盖缺口 issue（ADR 0171），真实 PostgreSQL 与内存中的 GitHub REST API：没有命中告警目录条目的成员告警每个
 * (集群, 告警名) 一个 issue；同一缺口再次出现时只追加评论；人关闭之后不再重开、不再评论；创建结果未知时按标记找回；
 * 每小时上限与事件 issue 共用。
 */
const REPO = 'acme/ops';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const metrics = new ServerMetrics('server', false);
const T = Date.now();

let db: TestDb;
let gh: FakeGitHub;
let app: GitHubApp;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  gh = new FakeGitHub('1', '2', key.publicKey, REPO);
  await gh.start();
  app = new GitHubApp({
    apiBase: gh.url,
    appId: '1',
    installationId: '2',
    privateKey: key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  });
});

afterAll(async () => {
  await gh?.stop();
  await db?.close();
});

const coverage = (o: { perHour?: number; language?: 'zh' | 'en'; cluster?: string } = {}) =>
  new CoverageIssues(
    db.server,
    app,
    {
      repo: REPO,
      labels: ['srenautix', 'ops'],
      titlePrefix: '[影子]',
      maxPerHour: o.perHour ?? 100,
      lookbackMs: 3600_000,
      consoleUrl: 'https://srenautix.example.test/',
      language: o.language ?? 'zh',
    },
    metrics,
  );

interface Member {
  alertname: string;
  /** 告警分类命中的目录条目；没有时为 null */
  entry?: string | null;
  /** 告警在事件里的状态：离开事件的成员不算 */
  left?: boolean;
  labels?: Record<string, string>;
  startsMinAgo?: number;
}

/** 一个事件与它的成员告警；suppressed、merged 与 updatedMinAgo 改写事件本身 */
async function incidentWith(
  members: Member[],
  o: { cluster?: string; suppressed?: boolean; merged?: boolean; updatedMinAgo?: number } = {},
): Promise<string> {
  const cluster = o.cluster ?? 'test';
  const inc: Incident = { ...baseIncident(), incident_id: randomUUID(), cluster_id: cluster, members: [] };
  inc.label = `Deployment:shop/api:${inc.incident_id}`;
  for (const m of members) {
    const startsAt = new Date(T - (m.startsMinAgo ?? 10) * 60_000);
    const fp = createHash('sha256').update(`${inc.incident_id}/${m.alertname}`).digest('hex').slice(0, 16);
    const u = await tx(db.server, (c) =>
      upsertAlert(
        c,
        cluster,
        {
          source: 'alertmanager',
          labels: { alertname: m.alertname, severity: 'warning', ...(m.labels ?? { service: 'catalog' }) },
          annotations: {},
          severity: 'warning',
          status: 'firing',
          suppressed: 'none',
          startsAt,
          endsAt: null,
          generatorUrl: null,
          fingerprint: fp,
          alertname: m.alertname,
          alertmanagerSeenAt: startsAt,
        },
        {
          classification: {
            role: 'cause',
            source: 'default',
            confidence: 0.3,
            catalog_entry: m.entry ?? null,
            chronic: false,
          },
          entity: null,
          entityResolution: 'unresolved',
          component: 'component:catalog',
          chains: [],
        },
      ),
    );
    inc.members.push({
      alert_id: u.alertId,
      alertname: m.alertname,
      role: 'cause',
      component: 'component:catalog',
      severity: 'warning',
      status: 'firing',
      starts_at: startsAt.toISOString(),
      ends_at: null,
      joined_version: 1,
      left_version: m.left ? 2 : null,
    });
  }
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component,
       suppressed, body, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - make_interval(mins => $11))`,
    [
      inc.incident_id,
      cluster,
      inc.label,
      inc.incident_version,
      o.merged ? 'merged' : 'firing',
      inc.severity,
      inc.first_firing_at,
      inc.root.component,
      o.suppressed ?? false,
      JSON.stringify(inc),
      o.updatedMinAgo ?? 0,
    ],
  );
  return inc.incident_id;
}

const gap = async (alertname: string, cluster = 'test') =>
  (
    await db.admin.query<{
      state: string;
      number: number | null;
      attempts: number;
      last_error: string | null;
      first_seen_at: Date;
      last_seen_at: Date;
      next_attempt_at: Date;
    }>(
      `SELECT state, number, attempts, last_error, first_seen_at, last_seen_at, next_attempt_at FROM server.coverage_gaps
        WHERE cluster_id = $1 AND alertname = $2`,
      [cluster, alertname],
    )
  ).rows[0];
const occurrences = async (alertname: string) =>
  (
    await db.admin.query<{ incident_id: string; reported: boolean }>(
      `SELECT incident_id, reported_at IS NOT NULL AS reported FROM server.coverage_gap_incidents
        WHERE alertname = $1 ORDER BY seen_at`,
      [alertname],
    )
  ).rows;
const issuesOf = (alertname: string, cluster = 'test') =>
  gh.issues.filter((i) => i.body.includes(coverageMarker(cluster, alertname)));
/** 到期重试：把缺口的下一次尝试时间提前到现在（退避等待由 next_attempt_at 表示） */
const due = (alertname: string) =>
  db.admin.query('UPDATE server.coverage_gaps SET next_attempt_at = now() WHERE alertname = $1', [alertname]);
const audit = async (kind: string, alertname: string) =>
  (
    await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.governance_audit WHERE kind = $1 AND data->>'alertname' = $2",
      [kind, alertname],
    )
  ).rows[0]!.n;

describe('覆盖缺口的登记', () => {
  it('只登记仍在事件里、没有命中目录条目的告警；被抑制、已合并、超出回看时间的事件不算', async () => {
    const a = await incidentWith([
      { alertname: 'GapCatalogStale', startsMinAgo: 30 },
      { alertname: 'GapCovered', entry: 'kind-shop/shop-api-down' },
      { alertname: 'GapLeft', left: true },
    ]);
    await incidentWith([{ alertname: 'GapSuppressed' }], { suppressed: true });
    await incidentWith([{ alertname: 'GapMerged' }], { merged: true });
    await incidentWith([{ alertname: 'GapOld' }], { updatedMinAgo: 120 });
    const b = await incidentWith([{ alertname: 'GapCatalogStale', startsMinAgo: 5 }]);
    await coverage().scan();
    const names = (
      await db.admin.query<{ alertname: string }>('SELECT alertname FROM server.coverage_gaps ORDER BY alertname')
    ).rows.map((r) => r.alertname);
    expect(names).toEqual(['GapCatalogStale']);
    expect((await occurrences('GapCatalogStale')).map((o) => o.incident_id).sort()).toEqual([a, b].sort());
    const g = await gap('GapCatalogStale');
    expect(g).toMatchObject({ state: 'pending', number: null });
    expect(g!.first_seen_at.getTime()).toBe(T - 30 * 60_000);
    expect(g!.last_seen_at.getTime()).toBe(T - 5 * 60_000);
    // 重复登记不增加行
    await coverage().scan();
    expect(await occurrences('GapCatalogStale')).toHaveLength(2);
  });
});

describe('覆盖缺口 issue', () => {
  it('每个 (集群, 告警名) 开一个 issue：标记、标签、出现次数与时间、涉及事件、补齐说明与控制台入口', async () => {
    const ids = [
      await incidentWith([{ alertname: 'ShopCatalogStale', startsMinAgo: 20, labels: { service: 'catalog' } }]),
      await incidentWith([
        { alertname: 'ShopCatalogStale', startsMinAgo: 8, labels: { service: 'catalog', tier: 'web' } },
      ]),
    ];
    // 另一个集群的同名告警是另一个缺口
    const other = await incidentWith([{ alertname: 'ShopCatalogStale' }], { cluster: 'staging' });
    await coverage().runOnce();
    const found = issuesOf('ShopCatalogStale');
    expect(found).toHaveLength(1);
    const issue = found[0]!;
    expect(issue.labels).toEqual(['srenautix', 'ops', COVERAGE_LABEL]);
    expect(issue.title).toBe('[影子] 覆盖缺口：告警 ShopCatalogStale 没有告警目录条目（集群 test）');
    expect(issue.body.startsWith(coverageMarker('test', 'ShopCatalogStale'))).toBe(true);
    expect(issue.body).toContain('出现次数：2 个事件');
    expect(issue.body).toContain(`首次出现：${new Date(T - 20 * 60_000).toISOString()}`);
    expect(issue.body).toContain(`最近一次出现：${new Date(T - 8 * 60_000).toISOString()}`);
    // 最近一次触发的标签（不含 alertname）
    expect(issue.body).toContain('最近一次触发的标签：`service=catalog`、`severity=warning`、`tier=web`');
    // 事件按开始时间倒序，链接到控制台
    const first = issue.body.indexOf(`https://srenautix.example.test/incidents/${ids[1]}`);
    const second = issue.body.indexOf(`https://srenautix.example.test/incidents/${ids[0]}`);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(issue.body).toContain('https://srenautix.example.test/topology?view=coverage&cluster=test');
    expect(issue.body).toContain('不需要补齐时关闭这个 issue');
    expect(issuesOf('ShopCatalogStale', 'staging')).toHaveLength(1);
    expect(issuesOf('ShopCatalogStale', 'staging')[0]!.body).toContain(`/incidents/${other}`);
    expect(await gap('ShopCatalogStale')).toMatchObject({ state: 'open', number: issue.number, attempts: 0 });
    expect((await occurrences('ShopCatalogStale')).every((o) => o.reported)).toBe(true);
    expect(await audit('github.coverage_issue_opened', 'ShopCatalogStale')).toBe(2);

    // 下一轮：没有新的事件，不重复开、不评论
    await coverage().runOnce();
    expect(issuesOf('ShopCatalogStale')).toHaveLength(1);
    expect(gh.comments.get(issue.number) ?? []).toEqual([]);
  });

  it('再次出现在新的事件里时只追加一条评论；人关闭 issue 之后不再评论，也不重开', async () => {
    const first = await incidentWith([{ alertname: 'ShopQueueOrphaned' }]);
    await coverage().runOnce();
    const issue = issuesOf('ShopQueueOrphaned')[0]!;
    const a = await incidentWith([{ alertname: 'ShopQueueOrphaned', startsMinAgo: 4 }]);
    const b = await incidentWith([{ alertname: 'ShopQueueOrphaned', startsMinAgo: 2 }]);
    await coverage().runOnce();
    const comments = gh.comments.get(issue.number) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('<!-- srenautix:coverage-comment=test/ShopQueueOrphaned -->');
    expect(comments[0]!.body).toContain('告警 `ShopQueueOrphaned` 又出现在 2 个事件里（累计 3 个事件）');
    expect(comments[0]!.body).toContain(`/incidents/${a}`);
    expect(comments[0]!.body).toContain(`/incidents/${b}`);
    expect(comments[0]!.body).not.toContain(`/incidents/${first}`);
    expect(await audit('github.coverage_issue_comment', 'ShopQueueOrphaned')).toBe(1);
    await coverage().runOnce();
    expect(gh.comments.get(issue.number)).toHaveLength(1);

    gh.closeIssue(issue.number);
    const c = await incidentWith([{ alertname: 'ShopQueueOrphaned', startsMinAgo: 1 }]);
    await coverage().runOnce();
    expect(gh.comments.get(issue.number)).toHaveLength(1);
    expect(await gap('ShopQueueOrphaned')).toMatchObject({ state: 'closed', number: issue.number });
    expect(await audit('github.coverage_issue_closed', 'ShopQueueOrphaned')).toBe(1);
    // 关闭之后出现的事件只计数
    expect((await occurrences('ShopQueueOrphaned')).find((o) => o.incident_id === c)).toEqual({
      incident_id: c,
      reported: false,
    });
    await incidentWith([{ alertname: 'ShopQueueOrphaned' }]);
    await coverage().runOnce();
    expect(issuesOf('ShopQueueOrphaned')).toHaveLength(1);
    expect(gh.comments.get(issue.number)).toHaveLength(1);
    expect(await occurrences('ShopQueueOrphaned')).toHaveLength(5);
  });

  it('创建之后连接断开：状态为 unknown，下一次按标记找回同一个 issue，已登记的事件以评论追加一次', async () => {
    const id = await incidentWith([{ alertname: 'ShopFeedLagging' }]);
    gh.fault('POST', /^\/repos\/acme\/ops\/issues$/, 'drop_after');
    await coverage().runOnce();
    expect(issuesOf('ShopFeedLagging')).toHaveLength(1);
    expect(await gap('ShopFeedLagging')).toMatchObject({ state: 'unknown', number: null, attempts: 1 });
    // 退避期内不重试
    await coverage().runOnce();
    expect(issuesOf('ShopFeedLagging')).toHaveLength(1);
    await due('ShopFeedLagging');
    await coverage().runOnce();
    const found = issuesOf('ShopFeedLagging');
    expect(found).toHaveLength(1);
    expect(await gap('ShopFeedLagging')).toMatchObject({ state: 'open', number: found[0]!.number, attempts: 0 });
    // 找回的 issue 不知道正文列到了哪里：登记过的事件追加在评论里
    const comments = gh.comments.get(found[0]!.number) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(`/incidents/${id}`);
    const recovered = await db.admin.query<{ data: { recovered: boolean } }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'github.coverage_issue_opened' AND data->>'alertname' = 'ShopFeedLagging'",
    );
    expect(recovered.rows.map((r) => r.data.recovered)).toEqual([true]);
  });

  it('结果明确的失败（4xx）记为 pending 并退避重试，重试直接创建；重试用尽记为 failed', async () => {
    await incidentWith([{ alertname: 'ShopSearchStale' }]);
    gh.fault('POST', /^\/repos\/acme\/ops\/issues$/, 422);
    await coverage().runOnce();
    const g = await gap('ShopSearchStale');
    expect(g).toMatchObject({ state: 'pending', attempts: 1 });
    expect(g!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await due('ShopSearchStale');
    await coverage().runOnce();
    expect(issuesOf('ShopSearchStale')).toHaveLength(1);

    await incidentWith([{ alertname: 'ShopIndexStale' }]);
    gh.fault('POST', /^\/repos\/acme\/ops\/issues$/, 422, 8);
    for (let i = 0; i < 8; i++) {
      await due('ShopIndexStale');
      await coverage().runOnce();
    }
    expect(await gap('ShopIndexStale')).toMatchObject({ state: 'failed', attempts: 8 });
    expect(issuesOf('ShopIndexStale')).toHaveLength(0);
    expect(await audit('github.coverage_issue_failed', 'ShopIndexStale')).toBe(1);
  });

  it('英文 issue', async () => {
    await incidentWith([{ alertname: 'ShopRatesStale' }], { cluster: 'eu' });
    await coverage({ language: 'en' }).runOnce();
    const issue = issuesOf('ShopRatesStale', 'eu')[0]!;
    expect(issue.title).toBe('[影子] Coverage gap: alert ShopRatesStale has no catalog entry (cluster eu)');
    expect(issue.body).toContain('Incidents with this alert: 1');
    expect(issue.body).toContain('Close this issue when the gap needs no fix');
  });
});

describe('每小时上限与事件 issue 共用', () => {
  it('最近 1 小时事件 issue 与覆盖 issue 合计达到上限时，覆盖 issue 推迟、事件 issue 记为 skipped', async () => {
    // 前面的用例已经开出若干覆盖 issue；上限取当前合计，再开一个就超出
    const opened = (
      await db.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM server.coverage_gaps WHERE repo = $1 AND opened_at > now() - interval '1 hour'",
        [REPO],
      )
    ).rows[0]!.n;
    expect(opened).toBeGreaterThan(0);
    await incidentWith([{ alertname: 'ShopTaxStale' }]);
    await coverage({ perHour: opened }).runOnce();
    const g = await gap('ShopTaxStale');
    expect(g).toMatchObject({ state: 'pending', attempts: 0 });
    expect(g!.last_error).toBe(
      `仓库 ${REPO} 最近 1 小时已开 ${opened} 个 issue（事件 issue 与覆盖 issue 合计），达到上限 ${opened}，稍后再开`,
    );
    expect(g!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(issuesOf('ShopTaxStale')).toHaveLength(0);

    // 事件 issue 按同一个合计判断：覆盖 issue 已经用满上限，事件 issue 不开（报告不会生成）
    const events = new IssueService(
      db.server,
      app,
      {
        repo: REPO,
        labels: ['srenautix'],
        titlePrefix: '',
        maxPerHour: opened,
        lookbackMs: 3600_000,
        consoleUrl: 'https://srenautix.example.test',
        language: 'zh',
      },
      metrics,
      async () => {
        throw new Error('达到上限时不生成事件报告');
      },
    );
    const incidentId = await incidentWith([{ alertname: 'ShopTaxStale', entry: 'kind-shop/shop-tax' }]);
    expect(await events.ensure(incidentId, 'escalate')).toBeNull();
    const row = await db.admin.query<{ state: string; last_error: string }>(
      'SELECT state, last_error FROM server.github_issues WHERE incident_id = $1',
      [incidentId],
    );
    expect(row.rows[0]).toEqual({
      state: 'skipped',
      last_error: `仓库 ${REPO} 最近 1 小时已开 ${opened} 个 issue（事件 issue 与覆盖 issue 合计），达到上限`,
    });

    // 上限放宽之后，推迟的覆盖 issue 到期开出
    await due('ShopTaxStale');
    await coverage({ perHour: opened + 1 }).runOnce();
    expect(issuesOf('ShopTaxStale')).toHaveLength(1);
  });
});
