import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesInWindow, ChangesService, type ChangeSourceConfig } from '../../src/changes/service.js';
import { parseServerConfig } from '../../src/config/server.js';
import { serverConditions } from '../../src/console-bff/conditions.js';
import { GitHubApp } from '../../src/github/app.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';

/**
 * GitHub 变更源同步（ADR 0096）：假的 GitHub REST API（App JWT 换安装令牌、分支提交列表与提交的 diff）与真实 PostgreSQL。
 * 验证回看窗口、路径映射、合并提交、翻页、按 change_id 去重、diff 只读一次与失败的隔离；kind: git 的变更源明确不支持。
 */
const REPO = 'acme/gitops';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const app = generateKeyPairSync('rsa', { modulusLength: 2048 });

let db: TestDb;
let gh: FakeGitHub;
let client: GitHubApp;
let kicks = 0;

const source = (over: Partial<ChangeSourceConfig> = {}): ChangeSourceConfig => ({
  id: 'gitops',
  kind: 'github',
  repo: REPO,
  branch: 'main',
  paths: [
    { prefix: 'apps/shop/api/', targets: ['Deployment:shop/api'], kind: 'gitops_sync' },
    { prefix: 'apps/shop/config/', targets: ['ConfigMap:shop/api-config', 'Deployment:shop/api'], kind: 'config' },
  ],
  ...over,
});
const commit = (files: string[], message: string, at: number, parents = 1) =>
  gh.commit('main', { message, author: 'Alice', date: new Date(at), files, parents });

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  gh = new FakeGitHub('31337', '55', app.publicKey, REPO);
  await gh.start();
  client = new GitHubApp({
    apiBase: gh.url,
    appId: '31337',
    installationId: '55',
    privateKey: app.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  });
  commit(['README.md'], 'init', NOW - 48 * 60 * MIN);
});

afterAll(async () => {
  await gh?.stop();
  await db?.close();
});

describe('GitHub 变更源同步', () => {
  let svc: ChangesService;
  let rollout = '';

  it('按路径映射回看窗口内的提交，触及多个映射时取并集；窗口外、未映射与合并提交不取', async () => {
    commit(['apps/shop/api/old.yaml'], 'too old', NOW - 30 * 60 * MIN);
    rollout = commit(['apps/shop/api/deployment.yaml'], 'scale api to 3\n\nlonger body', NOW - 20 * MIN);
    commit(['docs/notes.md'], 'unmapped', NOW - 15 * MIN);
    commit(['apps/shop/api/deployment.yaml'], 'Merge pull request #7', NOW - 12 * MIN, 2);
    commit(['apps/shop/config/app.yaml'], 'debug logging', NOW - 10 * MIN);
    svc = new ChangesService(
      db.server,
      [source()],
      { github: client, defaultClusterId: 'c1', sqlAudit: [] },
      24 * 60 * MIN,
      () => kicks++,
    );
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 2 });
    expect(kicks).toBe(1);
    const got = await changesInWindow(db.server, 'c1', new Date(NOW - 60 * MIN), new Date(NOW));
    expect(got.map((c) => [c.summary, c.kind, c.targets, c.paths])).toEqual([
      ['scale api to 3', 'gitops_sync', ['Deployment:shop/api'], ['apps/shop/api/']],
      ['debug logging', 'config', ['ConfigMap:shop/api-config', 'Deployment:shop/api'], ['apps/shop/config/']],
    ]);
    expect(got[0]).toMatchObject({
      change_id: `gitops:${rollout}`,
      source: 'gitops',
      revision: rollout,
      refs: [rollout.slice(0, 12)],
      actor: 'Alice <Alice@example.test>',
      link: `https://github.example.test/${REPO}/commit/${rollout}`,
      time: new Date(NOW - 20 * MIN).toISOString(),
    });
    expect(await changesInWindow(db.server, 'c2', new Date(NOW - 60 * MIN), new Date(NOW))).toEqual([]);
  });

  it('再次同步按 change_id 去重，已读过 diff 的提交不再请求；新的提交增量取得', async () => {
    const before = gh.requests.filter((r) => /\/commits\/[0-9a-f]{40}$/.test(r.path)).length;
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 0 });
    expect(gh.requests.filter((r) => /\/commits\/[0-9a-f]{40}$/.test(r.path)).length).toBe(before);
    expect(kicks).toBe(1);
    commit(['apps/shop/api/deployment.yaml'], 'scale api to 4', NOW - 2 * MIN);
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 1 });
    expect(kicks).toBe(2);
    const [status] = await svc.statuses();
    expect(status).toMatchObject({ id: 'gitops', clusterId: 'c1', lastError: null });
    expect(status!.lastSyncedAt).not.toBeNull();
  });

  it('窗口内的提交超过一页时翻页读取', async () => {
    for (let i = 0; i < 120; i++) {
      commit([`docs/n${i}.md`], `note ${i}`, NOW - 60 * MIN + i * 1000);
    }
    commit(['apps/shop/api/hpa.yaml'], 'add hpa', NOW - 61 * MIN);
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 1 });
    const pages = gh.requests.filter((r) => r.path === `/repos/${REPO}/commits`).length;
    expect(pages).toBeGreaterThanOrEqual(2);
  });

  it('一个变更源不可用只影响它自己，并发布 DatasourceUnavailable 条件', async () => {
    const both = new ChangesService(
      db.server,
      [source({ id: 'broken', repo: 'acme/missing', cluster_id: 'c2' }), source()],
      { github: client, defaultClusterId: 'c1', sqlAudit: [] },
      24 * 60 * MIN,
      () => kicks++,
    );
    expect(await both.syncOnce(NOW)).toEqual({ broken: null, gitops: 0 });
    const statuses = await both.statuses();
    expect(statuses.find((s) => s.id === 'broken')).toMatchObject({ clusterId: 'c2', lastSyncedAt: null });
    expect(statuses.find((s) => s.id === 'broken')!.lastError).toMatch(
      /仓库 acme\/missing：GitHub list_commits 返回 HTTP 404/,
    );
    const conds = serverConditions({
      ingestSources: [],
      silenceThresholdMs: 600_000,
      lastWatchdogAt: null,
      startedAt: new Date(),
      reconcileOk: null,
      evidenceDatasourceError: null,
      changeSources: statuses,
      packFailures: [],
      packsDisabled: [],
      degraded: false,
      storm: false,
      budgetRatio: 0,
      audit: { sink: 'pg', lagSeconds: 0, thresholdSeconds: 300 },
      channelFailures: [],
      restoredAt: null,
      frozenClusters: [],
      now: new Date(),
    }).filter((c) => c.subject?.startsWith('changes:'));
    expect(conds.map((c) => [c.subject, c.active])).toEqual([
      ['changes:broken', true],
      ['changes:gitops', false],
    ]);
  });

  it('配置：kind: git 明确不支持；GitHub 变更源需要 github_app', () => {
    const base = {
      cluster_id: 'c1',
      public_url: 'https://srenautix.example.test',
      policies_dir: '/x',
      ingest: { sources: [] },
      packs: { dirs: ['/x'] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      approvals: { signing_key_file: '/x', key_id: 'k' },
      identity: { bindings_dir: '/x' },
      audit: { checkpoint_key_file: '/x' },
      callers: { tokens_file: '/x' },
    };
    const paths = [{ prefix: 'apps/', targets: ['Deployment:shop/api'], kind: 'rollout' }];
    expect(() =>
      parseServerConfig({
        ...base,
        changes: { sources: [{ id: 'old', kind: 'git', url: 'https://git.example/x.git', ref: 'origin/main', paths }] },
      }),
    ).toThrow(/变更源 old：kind: git 不支持（hub 镜像不带 git，ADR 0096）/);
    expect(() =>
      parseServerConfig({ ...base, changes: { sources: [{ id: 'gh', kind: 'github', repo: REPO, paths }] } }),
    ).toThrow(/需要 github_app/);
    const ok = parseServerConfig({
      ...base,
      github_app: { app_id: '1', installation_id: '2', private_key_file: '/k.pem' },
      changes: { sources: [{ id: 'gh', kind: 'github', repo: REPO, paths }] },
    });
    expect(ok.changes.sources[0]).toMatchObject({ kind: 'github', repo: REPO, branch: 'main' });
  });
});
