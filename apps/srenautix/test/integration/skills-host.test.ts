import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { V1Pod } from '@kubernetes/client-node';
import { loadPromqlEngine, type PromqlEngine } from '@srenautix/integration-sdk';
import { compilePackSet, loadActionCatalog, type PackSet } from '@srenautix/packs-sdk';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApp, RepoRoles } from '../../src/github/app.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { skillsConfig, type SkillsConfig } from '../../src/skills/config.js';
import { NOT_PLANNED_COOLDOWN_MS } from '../../src/skills/publisher.js';
import { SkillRejected, SkillService } from '../../src/skills/service.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { RecordedKube } from '../support/recorded-kube.js';

/**
 * 技能的宿主（ADR 0181），真实 PostgreSQL 与内存中的 GitHub REST API，Kubernetes 用录制的结果：
 * - 加载与重新加载：新内容没有通过校验时保留上一个可用版本，状态条显示 SkillLoadFailed；
 * - 启用、授权、作用范围与暂停；
 * - 能力白名单（不变量 17）：没有授予的对象不读取、访问记录与治理审计写明拒绝；
 * - 按指纹去重：第一次开 issue，issue 打开时评论，completed 关闭之后开下一代并引用上一代，not planned 关闭之后
 *   冷却期内只计数、冷却期过后开下一代；创建结果未知时按标记找回；每小时上限推迟。
 */
const REPO = 'acme/api-gateway';
const FIXTURES = resolve(import.meta.dirname, '../fixtures/skills/skills');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });

let db: TestDb;
let gh: FakeGitHub;
let app: GitHubApp;
let engine: PromqlEngine;
let set: PackSet;
let root: string;

const pod = (name: string): V1Pod => ({
  metadata: { name, namespace: 'shop' },
  spec: { containers: [{ name: 'app', image: 'registry.example/app:1', resources: { limits: { memory: '1Gi' } } }] },
  status: {
    phase: 'Running',
    containerStatuses: [
      {
        name: 'app',
        image: 'registry.example/app:1',
        imageID: '',
        ready: true,
        restartCount: 1,
        lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: new Date('2026-11-02T00:09:14Z') } },
      },
    ],
  },
});

const kube = new RecordedKube(
  new Map([
    ['StatefulSet:shop/web', [pod('web-0')]],
    ['StatefulSet:shop/api', [pod('api-0')]],
    ['StatefulSet:shop/batch', [pod('batch-0')]],
  ]),
  new Map([
    ['shop/web-0', 'started\npassword=hunter2 token ghp_0123456789abcdef0123456789abcdef0123\nkilled'],
    ['shop/api-0', 'api log'],
    ['shop/batch-0', 'batch log'],
  ]),
);

const GRANTS = {
  'kube-probe': {
    'kube.read': { objects: ['pod_status', 'pod_logs_previous'] },
    'issue.write': { repo_role: 'business' },
  },
} as const;

function service(o: { config?: Partial<SkillsConfig>; repoMax?: number; now?: () => number } = {}): SkillService {
  const config = skillsConfig.parse({
    builtin_dir: root,
    enabled: ['kube-probe'],
    grants: GRANTS,
    scope: { 'kube-probe': { namespaces: ['shop'] } },
    ...o.config,
  });
  return new SkillService({
    pool: db.server,
    config,
    clusterId: 'test',
    hostVersion: '0.2.0',
    packs: () => set,
    engine,
    dataSource: () => {
      throw new Error('这个技能不读指标与日志');
    },
    kube,
    kubeLimits: { tailLines: 100, maxBytes: 16384 },
    github: app,
    repos: { business: { repo: REPO, default_branch: 'main' }, ops: null },
    logsAvailable: false,
    repoMaxPerHour: o.repoMax ?? 100,
    lang: 'zh-CN',
    titlePrefix: '[影子]',
    consoleUrl: 'https://srenautix.example.test/',
    registry: new Registry(),
    ownerOf: async () => null,
    storm: () => false,
    ...(o.now ? { now: o.now } : {}),
  });
}

const subject = (name: string) => ({ kind: 'StatefulSet' as const, namespace: 'shop', name });
const hit = {
  trigger: 'manual',
  kind: 'manual' as const,
  at: new Date().toISOString(),
  detail: 'test',
  pod: null,
  container: null,
  cause: null,
};
const signal = new AbortController().signal;

async function runFor(s: SkillService, name: string): Promise<string> {
  const run = await s.enqueue('kube-probe', subject(name), hit, { manual: true, requestedBy: 'tester' });
  expect(await s.runOne(signal)).toBe(true);
  const r = await s.run(run.run_id);
  return r!.run.reason!;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  gh = new FakeGitHub('1', '2', key.publicKey, REPO);
  await gh.start();
  app = new GitHubApp(
    {
      apiBase: gh.url,
      appId: '1',
      installationId: '2',
      privateKey: key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    },
    Date.now,
    new RepoRoles([[REPO, 'business']]),
  );
  engine = await loadPromqlEngine();
  set = await compilePackSet([], { catalog: loadActionCatalog(DEFAULT_CATALOG_PATH) });
  const base = resolve(import.meta.dirname, '../../../../.scratch');
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, 'skills-host-'));
  cpSync(join(FIXTURES, 'kube-probe'), join(root, 'kube-probe'), { recursive: true });
});

afterAll(async () => {
  await gh?.stop();
  await db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('加载、启用与授权', () => {
  it('启用并授予全部能力时为 active；宿主列出步骤类型', async () => {
    const s = service();
    await s.reload();
    expect(s.summary('kube-probe')).toMatchObject({ state: 'active', version: '1.0.0', missing: [], load_error: null });
    expect(s.host().step_kinds.map((k) => k.uses)).toContain('issue.publish@v1');
    expect(s.conditions()).toEqual([]);
  });

  it('没有授予清单要求的能力时为 missing_grant，手动运行被拒绝，状态条显示缺少的能力', async () => {
    const s = service({ config: { grants: { 'kube-probe': { 'kube.read': { objects: ['pod_status'] } } } } as never });
    await s.reload();
    expect(s.summary('kube-probe')).toMatchObject({ state: 'missing_grant', missing: ['issue.write'] });
    await expect(s.enqueue('kube-probe', subject('web'), hit, { manual: true })).rejects.toThrow(SkillRejected);
    expect(s.conditions()).toEqual([
      expect.objectContaining({ type: 'SkillCapabilityMissing', subject: 'kube-probe', active: true }),
    ]);
  });

  it('作用范围之外的对象与暂停的技能不接受运行', async () => {
    const s = service();
    await s.reload();
    await expect(
      s.enqueue('kube-probe', { kind: 'StatefulSet', namespace: 'other', name: 'x' }, hit, { manual: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      s.enqueue('kube-probe', { kind: 'DaemonSet', namespace: 'shop', name: 'x' }, hit, { manual: true }),
    ).rejects.toMatchObject({ status: 403 });
    await s.setPaused('kube-probe', true, '维护', 'admin');
    expect(s.summary('kube-probe')).toMatchObject({ state: 'paused', paused_reason: '维护' });
    await expect(s.enqueue('kube-probe', subject('web'), hit, { manual: true })).rejects.toMatchObject({ status: 409 });
    await s.setPaused('kube-probe', false, null, 'admin');
    const audit = await db.server.query<{ kind: string }>(
      "SELECT kind FROM server.governance_audit WHERE kind LIKE 'skill.%' ORDER BY seq",
    );
    expect(audit.rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['skill.loaded', 'skill.paused', 'skill.resumed']),
    );
  });

  it('新内容没有通过校验时保留上一个可用版本；修好之后重新加载', async () => {
    const s = service();
    await s.reload();
    const file = join(root, 'kube-probe', 'skill.yaml');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, good.replace('uses: issue.publish@v1', 'uses: shell.exec@v1'));
    await s.reload();
    expect(s.summary('kube-probe')).toMatchObject({ state: 'active', version: '1.0.0' });
    expect(s.summary('kube-probe')!.load_error).toMatch(/shell.exec@v1 不是宿主支持的类型/);
    expect(s.conditions()).toEqual([
      expect.objectContaining({ type: 'SkillLoadFailed', subject: 'kube-probe', reason: 'KeptPrevious' }),
    ]);
    writeFileSync(file, good.replace('version: 1.0.0', 'version: 1.0.1'));
    await s.reload();
    expect(s.summary('kube-probe')).toMatchObject({ state: 'active', version: '1.0.1', load_error: null });
    writeFileSync(file, good);
    await s.reload();
  });
});

describe('能力白名单（不变量 17）', () => {
  it('没有授予 pod_logs_previous 时这次读取不发出，运行以 capability_denied 结束并写审计', async () => {
    const s = service({
      config: {
        grants: { 'kube-probe': { ...GRANTS['kube-probe'], 'kube.read': { objects: ['pod_status'] } } },
      } as never,
    });
    await s.reload();
    // 清单要求的对象没有全部授予：有效能力里只有 pod_status，技能仍是 active
    expect(s.summary('kube-probe')!.capabilities['kube.read']).toEqual({ objects: ['pod_status'] });
    const before = kube.reads.length;
    const run = await s.enqueue('kube-probe', subject('batch'), hit, { manual: true });
    await s.runOne(signal);
    const r = (await s.run(run.run_id))!;
    expect(r.run.reason).toBe('capability_denied');
    expect(kube.reads.slice(before).map((x) => x.op)).toEqual(['workload_pods']);
    expect(r.calls.map((c) => [c.capability, c.operation, c.outcome])).toEqual([
      ['kube.read', 'workload_pods', 'ok'],
      ['kube.read', 'pod_logs_previous', 'denied'],
    ]);
    const audit = await db.server.query<{ data: { run_id: string } }>(
      "SELECT data FROM server.governance_audit WHERE kind = 'skill.call_denied'",
    );
    expect(audit.rows.map((x) => x.data.run_id)).toContain(run.run_id);
    expect(gh.issues.length).toBe(0);
  });
});

describe('按指纹去重与再次出现', () => {
  it('第一次开 issue；打开时评论；completed 关闭之后开下一代；not planned 之后冷却期内只计数，过后开下一代', async () => {
    let now = Date.now();
    const s = service({ now: () => now });
    await s.reload();

    expect(await runFor(s, 'web')).toBe('published');
    await s.tickOnce(signal);
    expect(gh.issues.length).toBe(1);
    const first = gh.issues[0]!;
    expect(first.title).toBe('[影子] web 探查');
    expect(first.labels.sort()).toEqual(['probe', 'srenautix', 'srenautix:kube-probe']);
    expect(first.body).toMatch(/^<!-- srenautix:skill=kube-probe\/[0-9a-f]{32}\/1 -->/);
    // 日志尾部经过脱敏
    expect(first.body).not.toMatch(/hunter2|ghp_0123/);
    expect(first.body).toContain('Pods: web-0');

    expect(await runFor(s, 'web')).toBe('commented');
    await s.tickOnce(signal);
    expect(gh.comments.get(first.number)?.map((c) => c.body)).toEqual([
      expect.stringMatching(/Seen again: occurrence 2/),
    ]);

    gh.closeIssue(first.number, 'completed');
    expect(await runFor(s, 'web')).toBe('published');
    await s.tickOnce(signal);
    expect(gh.issues.length).toBe(2);
    const second = gh.issues[1]!;
    expect(second.body).toContain(`Recurred after #${first.number}.`);
    expect(second.body).toContain('generation 2');

    gh.closeIssue(second.number, 'not_planned', 'maintainer', new Date(now));
    expect(await runFor(s, 'web')).toBe('counted');
    await s.tickOnce(signal);
    expect(gh.issues.length).toBe(2);
    expect(gh.comments.get(second.number) ?? []).toEqual([]);

    now += NOT_PLANNED_COOLDOWN_MS + 60_000;
    expect(await runFor(s, 'web')).toBe('published');
    await s.tickOnce(signal);
    expect(gh.issues.length).toBe(3);
    expect(gh.issues[2]!.body).toContain(`Recurred after #${second.number}.`);

    const rows = await db.server.query<{ generation: number; state: string; occurrences: number }>(
      "SELECT generation, state, occurrences FROM server.skill_findings WHERE skill = 'kube-probe' AND subject->>'name' = 'web' ORDER BY generation",
    );
    expect(rows.rows).toEqual([
      { generation: 1, state: 'completed', occurrences: 2 },
      { generation: 2, state: 'not_planned', occurrences: 2 },
      { generation: 3, state: 'open', occurrences: 1 },
    ]);
  });

  it('创建结果未知时按标记找回，不重复开 issue', async () => {
    const s = service();
    await s.reload();
    expect(await runFor(s, 'api')).toBe('published');
    gh.fault('POST', /\/issues$/, 'drop_after');
    await s.tickOnce(signal);
    const n = gh.issues.filter((i) => i.title.includes('api 探查')).length;
    expect(n).toBe(1);
    const st = await db.server.query<{ state: string }>(
      "SELECT state FROM server.skill_findings WHERE subject->>'name' = 'api'",
    );
    expect(st.rows[0]!.state).toBe('unknown');
    await db.server.query("UPDATE server.skill_findings SET next_attempt_at = now() WHERE subject->>'name' = 'api'");
    await s.tickOnce(signal);
    expect(gh.issues.filter((i) => i.title.includes('api 探查')).length).toBe(1);
    const st2 = await db.server.query<{ state: string; number: number }>(
      "SELECT state, number FROM server.skill_findings WHERE subject->>'name' = 'api'",
    );
    expect(st2.rows[0]).toMatchObject({ state: 'open' });
  });

  it('同一仓库最近 1 小时的 issue 达到上限时推迟，不开出', async () => {
    const opened = gh.issues.length;
    const s = service({ repoMax: 1 });
    await s.reload();
    expect(await runFor(s, 'batch')).toBe('published');
    await s.tickOnce(signal);
    expect(gh.issues.length).toBe(opened);
    const st = await db.server.query<{ state: string; last_error: string }>(
      "SELECT state, last_error FROM server.skill_findings WHERE subject->>'name' = 'batch'",
    );
    expect(st.rows[0]).toMatchObject({ state: 'pending' });
    expect(st.rows[0]!.last_error).toMatch(/达到上限 1/);
  });
});
