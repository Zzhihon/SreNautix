import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { startLoki, startVictoriaMetrics, type RunningProcess, type TsdbInstance } from '@srenautix/integration-sdk';
import { compilePackSet, loadActionCatalog, loadBuiltinPacks, loadPackDir, type PackSet } from '@srenautix/packs-sdk';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApp, RepoRoles } from '../../src/github/app.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { skillsConfig } from '../../src/skills/config.js';
import { SkillService } from '../../src/skills/service.js';
import { EvidenceSource } from '../../src/stage-a/packs.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { FakeGitHub } from '../support/github.js';
import { AT, CODE, logStreams, metricSeries, NS, pods, previousLogs, STS } from '../support/oom-skill-fixture.js';
import { RecordedKube } from '../support/recorded-kube.js';
import { PACKS } from '../support/packs.js';

/**
 * 技能 oom-rootcause 端到端（ADR 0181 §11）：夹具的指标装进真实的 VictoriaMetrics，日志装进真实的 Loki，业务仓库在内存中的
 * GitHub，Pod 状态与上一次退出的日志用录制的结果。手动运行（参考时刻 11-02 12:00Z）之后：
 * - 发生、分类、主因与另一种触发、统计上未得到支持的嫌疑项、代码位置（固定到提交）、堆画像与运维侧选项写进 issue；
 * - 请求体、上游错误文字与环境变量不出现在 issue、运行记录与访问记录里；
 * - 每次访问都在授予的能力与运行对象之内；
 * - 同一根因再次出现时评论，不开新 issue。
 */
const REPO = 'acme/api-gateway';
const SHOP = resolve(import.meta.dirname, '../fixtures/skills/packs/shop');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });

let db: TestDb;
let gh: FakeGitHub;
let vm: TsdbInstance;
let loki: RunningProcess;
let set: PackSet;
let svc: SkillService;
let commit: string;
const kube = new RecordedKube(
  new Map([[`StatefulSet:${NS}/${STS}`, pods()]]),
  new Map([...previousLogs()].map(([pod, text]) => [`${NS}/${pod}`, text])),
);
const signal = new AbortController().signal;
const subject = { kind: 'StatefulSet' as const, namespace: NS, name: STS };

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  vm = await startVictoriaMetrics(metricSeries());
  loki = await startLoki(logStreams());
  gh = new FakeGitHub('1', '2', key.publicKey, REPO);
  await gh.start();
  commit = gh.write('main', CODE, { message: 'gateway code' });
  const app = new GitHubApp(
    {
      apiBase: gh.url,
      appId: '1',
      installationId: '2',
      privateKey: key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    },
    Date.now,
    new RepoRoles([[REPO, 'business']]),
  );
  set = await compilePackSet([...loadBuiltinPacks(PACKS), loadPackDir(SHOP, 'dir:shop')], {
    catalog: loadActionCatalog(DEFAULT_CATALOG_PATH),
  });
  const evidence = await EvidenceSource.create(
    { id: 'prometheus', url: vm.url, dialect: 'promql', bearerTokenFile: null, timeoutMs: 30_000 },
    {
      id: 'loki',
      url: loki.url,
      bearerTokenFile: null,
      tenant: null,
      labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
      timeoutMs: 30_000,
    },
  );
  svc = new SkillService({
    pool: db.server,
    config: skillsConfig.parse({
      enabled: ['oom-rootcause'],
      grants: {
        'oom-rootcause': {
          'metrics.query_range': {},
          'logs.query': { max_lines: 1000 },
          'kube.read': { objects: ['pod_status', 'events', 'pod_logs_previous'] },
          'code.read': { repo_role: 'business' },
          'issue.write': { repo_role: 'business' },
        },
      },
      scope: { 'oom-rootcause': { namespaces: [NS] } },
    }),
    clusterId: 'test',
    hostVersion: '0.2.0',
    packs: () => set,
    engine: evidence.engine,
    dataSource: (at) => evidence.dataSource(at),
    kube,
    kubeLimits: { tailLines: 100, maxBytes: 16384 },
    github: app,
    repos: { business: { repo: REPO, default_branch: 'main' }, ops: null },
    logsAvailable: true,
    repoMaxPerHour: 10,
    lang: 'zh-CN',
    titlePrefix: '[影子]',
    consoleUrl: 'https://srenautix.example.test/',
    registry: new Registry(),
    ownerOf: async () => null,
    storm: () => false,
  });
  await svc.reload();
}, 600_000);

afterAll(async () => {
  await gh?.stop();
  await loki?.stop();
  await vm?.stop();
  await db?.close();
});

async function manualRun(): Promise<Awaited<ReturnType<SkillService['run']>>> {
  // 同一对象两次运行之间至少间隔 coalesce（2h，手动运行也一样）：把之前的运行挪到 coalesce 之前，下一次手动运行立即到期
  await db.server.query(
    "UPDATE server.skill_runs SET started_at = started_at - interval '3 hours' WHERE skill = 'oom-rootcause' AND started_at IS NOT NULL",
  );
  const run = await svc.enqueue(
    'oom-rootcause',
    subject,
    {
      trigger: 'manual',
      kind: 'manual',
      at: new Date(AT).toISOString(),
      detail: 'test',
      pod: null,
      container: null,
      cause: null,
    },
    { manual: true, requestedBy: 'tester', at: new Date(AT).toISOString() },
  );
  expect(await svc.runOne(signal)).toBe(true);
  return svc.run(run.run_id);
}

describe('oom-rootcause 端到端', () => {
  it('加载内置技能与测试包的绑定', () => {
    expect(svc.summary('oom-rootcause')).toMatchObject({ state: 'active', missing: [], load_error: null });
    expect(svc.registry.get('oom-rootcause')!.bindings.map((b) => b.id)).toEqual(['api-gateway']);
  });

  it('手动运行开出 issue：结论、证据、代码位置、堆画像与选项；不含请求体与密钥', async () => {
    const r = (await manualRun())!;
    expect(r.run.error).toBeNull();
    expect(r.run.reason).toBe('published');
    expect(r.run.steps.filter((s) => s.state === 'failed')).toEqual([]);
    for (const c of r.calls) {
      expect(c.outcome).toBe('ok');
    }
    await svc.tickOnce(signal);
    expect(gh.issues.length).toBe(1);
    const issue = gh.issues[0]!;
    expect(issue.title).toBe('[影子] api-gateway 内存终止：大请求体整体转换与整段拼接（3 次）');
    expect(issue.labels.sort()).toEqual(['area/gateway', 'bug', 'srenautix', 'srenautix:oom-rootcause']);
    const b = issue.body;
    expect(b).toMatch(/^<!-- srenautix:skill=oom-rootcause\/[0-9a-f]{32}\/1 -->/);
    expect(b).toContain('| 11-02 00:09:14 | api-gateway-3 | 容器 limit 触发 |');
    expect(b).toContain('| 11-02 00:44:22 | api-gateway-0 | 容器 limit 触发 |');
    expect(b).toMatch(/\| 11-01 07:5\d:00 \| api-gateway-0 \| 容器 limit 触发 \|/);
    expect(b).toContain('- **主因（置信度中高）**：大请求体整体转换与整段拼接。');
    expect(b).toContain('- **另一种触发（置信度中）**：api-gateway-0 11-01 07:5');
    expect(b).toContain('- **统计上未得到支持（不排除）**：导出任务的内存看门狗，可能是次要加重因素，见 §3。');
    // 代码位置固定到提交；找不到的模式列为提示失效
    expect(b).toContain(
      `[\`internal/body/limit.go:6-11\`](https://github.com/${REPO}/blob/${commit}/internal/body/limit.go#L6-L11)`,
    );
    expect(b).toContain('代码提示失效：`internal/body/limit.go` 中找不到 `defaultSpikeAllowanceBytes`。');
    expect(b).toContain(`代码按提交 \`${commit}\` 读取。`);
    // 证据表的查询是实际发出的 PromQL 与 LogQL
    expect(b).toMatch(/`[^`\n]*go_memstats_heap_inuse_bytes[^`\n]*api-gateway-3[^`\n]*`/);
    expect(b).toMatch(
      /\{namespace="shop", pod="api-gateway-0", container="gateway"\} \\\|= "executor_upstream_failure"/,
    );
    // 大请求：组织只留前缀
    expect(b).toContain('请求体字节最多的是组织 7f3c9a2b…');
    expect(b).toContain('`7f3c9a2b…`');
    expect(b).not.toContain('7f3c9a2b5e6d4c1a');
    // 堆画像：只列文件名合法的，不取出
    expect(b).toContain('heap-20261102T063722Z-2883MiB.pb.gz');
    expect(b).toContain('heap-20261102T004350Z-3290MiB.pb.gz');
    expect(b).not.toContain('rm -rf');
    expect(b).toContain('| 降低单个请求体的转换上限 | 网关请求准入 | 超过上限的大请求返回 413 |');
    expect(b).toContain('相关：#98 #101 #104 #107');
    // 请求体、上游错误文字、环境变量都不出现
    const everything = JSON.stringify([b, r.run, r.calls]);
    expect(everything).not.toMatch(/user prompt|another user prompt|confidential|sk-should-never-leak/);
    // 访问都在运行对象之内，Kubernetes 只读了声明的对象
    expect(new Set(kube.reads.map((x) => x.op))).toEqual(new Set(['workload_pods', 'events', 'pod_logs_previous']));
    expect(kube.reads.every((x) => x.namespace === NS)).toBe(true);
    expect(r.run.usage.metrics_queries).toBeLessThanOrEqual(200);
  });

  it('同一工作负载上没有新的发生时不投递', async () => {
    const r = (await manualRun())!;
    expect(r.run.reason).toBe('no_occurrence');
    expect(r.run.steps.find((s) => s.id === 'publish')!.state).toBe('skipped');
  });

  it('同一根因再次出现时在已有 issue 下评论', async () => {
    await db.server.query("DELETE FROM server.skill_occurrences WHERE skill = 'oom-rootcause'");
    const r = (await manualRun())!;
    expect(r.run.reason).toBe('commented');
    await svc.tickOnce(signal);
    expect(gh.issues.length).toBe(1);
    const comments = gh.comments.get(gh.issues[0]!.number) ?? [];
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain('同一根因再次出现（第 2 次运行');
  });
});
