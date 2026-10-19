import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesInWindow, ChangesService, type ChangeSourceConfig } from '../../src/changes/service.js';
import { serverConditions } from '../../src/console-bff/conditions.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { GitRepo } from '../support/git.js';

/**
 * 变更源同步：真实的 git 仓库（本地路径作为克隆地址）、真实的 git 命令与 PostgreSQL。
 * 提交时间按需设定，验证回看窗口、路径映射、按 change_id 去重、fetch 增量与失败的隔离。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `changes-sync-${process.pid}`);
const UPSTREAM = join(ROOT, 'upstream');
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;

let db: TestDb;
let kicks = 0;
let repo: GitRepo;
const commit = (path: string, content: string, message: string, at: number) => repo.commit(path, content, message, at);

const source = (over: Partial<ChangeSourceConfig> = {}): ChangeSourceConfig => ({
  id: 'gitops',
  kind: 'git',
  url: UPSTREAM,
  ref: 'origin/main',
  http_username: 'x-access-token',
  link_template: 'https://git.example.test/org/gitops/commit/{sha}',
  paths: [
    { prefix: 'apps/shop/api/', targets: ['Deployment:shop/api'], kind: 'gitops_sync' },
    { prefix: 'apps/shop/config/', targets: ['ConfigMap:shop/api-config', 'Deployment:shop/api'], kind: 'config' },
  ],
  ...over,
});

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  repo = new GitRepo(UPSTREAM);
  commit('README.md', 'gitops\n', 'init', NOW - 48 * 60 * MIN);
});

afterAll(async () => {
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('变更源同步', () => {
  let svc: ChangesService;
  let rollout = '';

  it('克隆后按路径映射回看窗口内的提交，触及多个映射时取并集；窗口外与未映射的提交不取', async () => {
    commit('apps/shop/api/old.yaml', 'replicas: 1\n', 'too old', NOW - 30 * 60 * MIN);
    rollout = commit('apps/shop/api/deployment.yaml', 'replicas: 3\n', 'scale api to 3', NOW - 20 * MIN);
    commit('docs/notes.md', 'x\n', 'unmapped', NOW - 15 * MIN);
    commit('apps/shop/config/app.yaml', 'level: debug\n', 'debug logging', NOW - 10 * MIN);
    svc = new ChangesService(
      db.server,
      [source()],
      { cacheDir: join(ROOT, 'cache'), defaultClusterId: 'c1' },
      24 * 60 * MIN,
      () => kicks++,
    );
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 2 });
    expect(kicks).toBe(1);
    const got = await changesInWindow(db.server, 'c1', new Date(NOW - 60 * MIN), new Date(NOW));
    expect(got.map((c) => [c.summary, c.kind, c.targets])).toEqual([
      ['scale api to 3', 'gitops_sync', ['Deployment:shop/api']],
      ['debug logging', 'config', ['ConfigMap:shop/api-config', 'Deployment:shop/api']],
    ]);
    expect(got[0]).toMatchObject({
      change_id: `gitops:${rollout}`,
      source: 'gitops',
      revision: rollout,
      actor: 'Alice <alice@example.test>',
      link: `https://git.example.test/org/gitops/commit/${rollout}`,
      time: new Date(NOW - 20 * MIN).toISOString(),
    });
    // 其他集群与窗口之外没有
    expect(await changesInWindow(db.server, 'c2', new Date(NOW - 60 * MIN), new Date(NOW))).toEqual([]);
    expect(await changesInWindow(db.server, 'c1', new Date(NOW - 15 * MIN), new Date(NOW))).toHaveLength(1);
  });

  it('再次同步按 change_id 去重；上游的新提交经 fetch 增量取得', async () => {
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 0 });
    expect(kicks).toBe(1);
    commit('apps/shop/api/deployment.yaml', 'replicas: 4\n', 'scale api to 4', NOW - 2 * MIN);
    expect(await svc.syncOnce(NOW)).toEqual({ gitops: 1 });
    expect(kicks).toBe(2);
    const [status] = await svc.statuses();
    expect(status).toMatchObject({ id: 'gitops', clusterId: 'c1', lastError: null });
    expect(status!.lastSyncedAt).not.toBeNull();
  });

  it('一个变更源不可用只影响它自己，并发布 DatasourceUnavailable 条件', async () => {
    const both = new ChangesService(
      db.server,
      [source({ id: 'broken', url: join(ROOT, 'no-such-repo'), cluster_id: 'c2' }), source()],
      { cacheDir: join(ROOT, 'cache'), defaultClusterId: 'c1' },
      24 * 60 * MIN,
      () => kicks++,
    );
    expect(await both.syncOnce(NOW)).toEqual({ broken: null, gitops: 0 });
    const statuses = await both.statuses();
    expect(statuses.find((s) => s.id === 'broken')).toMatchObject({ clusterId: 'c2', lastSyncedAt: null });
    expect(statuses.find((s) => s.id === 'broken')!.lastError).toMatch(/git clone 失败/);
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
});
