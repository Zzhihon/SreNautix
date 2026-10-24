// 内置包的主动优化模板（ADR 0146 §4.3、§4.4）：postgres 的 pg-guc-tune、slow-statement 与 hot-polling，workload 的
// resource-right-size 与 resource-right-size-memory。补丁在内存中的仓库上生成，输入查询读真实的 Prometheus。
import type { RepositoryLayout } from '@srenautix/contract';
import {
  PrometheusApiAdapter,
  startPrometheus,
  type FixtureMetricSeries,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePackSet, type PackSet } from '../src/pack/compile.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { pgMemory, pgMemoryKb } from '../src/remediation/functions.js';
import { applicableIssues, planIssue, type GoalTemplateContext } from '../src/remediation/issues.js';
import { applicableRemediations, planRemediation, type RemediationContext } from '../src/remediation/plan.js';
import type { RepoReader } from '../src/remediation/repo.js';
import { LiveDataSource } from '../src/runtime/datasource.js';
import { CATALOG, PACKS } from './support.js';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const AT = T0 + 120 * MIN;

const flat = (labels: Record<string, string>, v: (i: number) => number): FixtureMetricSeries => ({
  labels,
  points: Array.from({ length: 121 }, (_, i) => ({ t: T0 + i * MIN, v: v(i) })),
});
const container = (name: string, pod: string, c: string) => ({ __name__: name, namespace: 'shop', pod, container: c });
const REPORT = 'report-5f7b8c9d6e-k2m4n';

// report：CPU 用量 0.1 核（计数器每分钟加 6），最大工作集 200 MiB；web 的 CPU 用量同样是 0.1 核，由按 CPU 利用率伸缩的 HPA 管理
const fixtures: FixtureMetricSeries[] = [
  flat(container('container_cpu_usage_seconds_total', REPORT, 'report'), (i) => 6 * i),
  flat(container('container_cpu_usage_seconds_total', REPORT, 'sidecar'), (i) => 0.6 * i),
  flat(container('container_memory_working_set_bytes', REPORT, 'report'), () => 209715200),
  flat(container('container_oom_events_total', REPORT, 'report'), () => 0),
  flat(
    { ...container('kube_pod_container_status_last_terminated_reason', 'other-0', 'other'), reason: 'OOMKilled' },
    () => 1,
  ),
  flat(container('container_cpu_usage_seconds_total', 'web-7d9f8c6b5d-x2k9p', 'web'), (i) => 6 * i),
  flat(
    {
      __name__: 'kube_horizontalpodautoscaler_info',
      namespace: 'shop',
      horizontalpodautoscaler: 'web',
      scaletargetref_name: 'web',
    },
    () => 1,
  ),
  flat(
    {
      __name__: 'kube_horizontalpodautoscaler_spec_target_metric',
      namespace: 'shop',
      horizontalpodautoscaler: 'web',
      metric_name: 'cpu',
      metric_target_type: 'utilization',
    },
    () => 80,
  ),
];

let prom: TsdbInstance;
let ds: LiveDataSource;
let set: PackSet;
beforeAll(async () => {
  prom = await startPrometheus(fixtures);
  ds = new LiveDataSource({
    metrics: {
      adapter: new PrometheusApiAdapter({ id: 'prometheus', url: prom.url, dialects: ['promql'] }),
      profile: {
        namespace: 'namespace',
        pod: 'pod',
        container: 'container',
        node: 'node',
        cluster: null,
        scrape_interval_seconds: 60,
        tenant: null,
      },
    },
  });
  set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
});
afterAll(async () => {
  await prom?.stop();
});

function memoryRepo(files: Record<string, string>): RepoReader {
  const keys = Object.keys(files).sort();
  return {
    head: async () => '0'.repeat(40),
    read: async (p) => files[p] ?? null,
    list: async (glob) => keys.filter((p) => p.startsWith(glob.split('*')[0]!)),
    history: async () => [],
  };
}

const goal = (finding: Record<string, unknown>, cards: Record<string, unknown> = {}): GoalTemplateContext => ({
  goal: { goal_id: '5b0c8f3e-2a1d-4c7e-9f10-1a2b3c4d5e6f', revision: 1 },
  finding,
  finding_cards: cards,
  gates: { min_share: 0.2 },
});

const ctx = (root: RemediationContext['root'], g?: GoalTemplateContext): RemediationContext => ({
  incident: {},
  root,
  cards: {},
  alerts: [],
  ...(g ? { goal: g } : {}),
});

const plan = (key: string, c: RemediationContext, files: Record<string, string>, layout: RepositoryLayout) =>
  planRemediation(set, key, c, { repo: memoryRepo(files), layout }, ds, AT);

const applicable = (c: RemediationContext) => applicableRemediations(set, c).applicable.map((a) => a.key);

describe('PostgreSQL 的内存参数', () => {
  it('kB、MB、GB 与没有单位的取值换算为 kB，写回能整除的最大单位', () => {
    expect(['4MB', '4096kB', '1GB', '64'].map(pgMemoryKb)).toEqual([4096, 4096, 1048576, 64]);
    expect([6144, 1048576, 1500.2].map(pgMemory)).toEqual(['6MB', '1GB', '1501kB']);
    expect(() => pgMemoryKb('4 MiB')).toThrow();
  });
});

const CLUSTER = (params: string) => `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: shop-pg
spec:
  instances: 2
  postgresql:
    parameters:
${params}
`;
const PG_FILE = 'platform/pg/cluster.yaml';
const PG_LAYOUT: RepositoryLayout = { postgres_clusters: { path: PG_FILE, format: 'yaml' } };

describe('postgres/pg-guc-tune', () => {
  const finding = {
    kind: 'pg.temp_spill',
    share: 0.8,
    entity: { type: 'pg_statement', key: 'pg_statement:shop-pg/app/abc', display: 'q', labels: { queryid: '102' } },
  };
  const temp = { 'postgres/checks/statement-temp': { verdict: 'abnormal', observations: { total_bytes: 2048000 } } };
  const root = { cluster_id: 'c1', kind: 'Cluster.postgresql.cnpg.io', namespace: 'shop', name: 'shop-pg' };
  const c = ctx(root, goal(finding, temp));

  it('临时文件写入时把 work_mem 调大一半，补丁只改这一行，预期收益来自诊断卡', async () => {
    expect(applicable(c)).toEqual(['postgres/pg-guc-tune']);
    const files = { [PG_FILE]: CLUSTER("      work_mem: '16MB'\n      max_connections: '200'") };
    const p = await plan('postgres/pg-guc-tune', c, files, PG_LAYOUT);
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') {
      return;
    }
    const changed = p.patch.split('\n').filter((l) => /^[-+] /.test(l));
    expect(changed).toEqual(["-      work_mem: '16MB'", "+      work_mem: '24MB'"]);
    expect(p.estimate).toMatchObject({ indicator: 'postgres/temp-written', lower: 819200, expected: 1638400 });
    expect(p.verify.guards).toEqual(['postgres/db-time', 'postgres/cache-hit']);
    expect(p.change['zh-CN']).toContain('work_mem 由 16MB 调到 24MB');
  });

  it('没有写 work_mem 时按默认 4MB 计；到达上限时跳过', async () => {
    const p = await plan('postgres/pg-guc-tune', c, { [PG_FILE]: CLUSTER("      max_connections: '200'") }, PG_LAYOUT);
    expect(p.kind === 'plan' && p.patch).toContain('+      work_mem: 6MB');
    const top = await plan('postgres/pg-guc-tune', c, { [PG_FILE]: CLUSTER("      work_mem: '256MB'") }, PG_LAYOUT);
    expect(top).toMatchObject({ kind: 'skipped', code: 'skip_if' });
  });

  it('只在目标上下文中、发现为 pg.temp_spill 时适用', () => {
    expect(applicable(ctx(root, goal({ ...finding, kind: 'pg.statement_dominant' })))).toEqual([]);
    expect(applicable(ctx(root))).not.toContain('postgres/pg-guc-tune');
  });
});

describe('postgres 的业务 issue 模板', () => {
  const statement = 'SELECT count(*) FROM orders WHERE total > $1';
  const entity = { type: 'pg_statement', key: 'pg_statement:shop-pg/app/abc', display: 'q' };
  const dominant = {
    kind: 'pg.statement_dominant',
    share: 0.6,
    entity: { ...entity, labels: { queryid: '101', statement } },
  };

  it('slow-statement：规范化语句作为 sql 锚点，下界为份额 × 最小降幅', () => {
    expect(applicableIssues(set.issues, goal(dominant), 'database').applicable).toEqual(['postgres/slow-statement']);
    expect(planIssue(set.issues, 'postgres/slow-statement', goal(dominant))).toMatchObject({
      kind: 'issue',
      anchors: [{ kind: 'sql', value: statement }],
      estimate: { indicator: 'postgres/db-time', lower: 0.3, expected: expect.closeTo(0.48, 10) },
      verify: { within: '72h', cards: ['postgres/checks/statement-share'], guards: ['postgres/xact-rate'] },
      labels: ['perf'],
    });
  });

  it('没有语句文本时没有锚点，模板跳过', () => {
    const noText = { ...dominant, entity: { ...entity, labels: { queryid: '101' } } };
    const p = planIssue(set.issues, 'postgres/slow-statement', goal(noText));
    expect(p).toMatchObject({ kind: 'skipped', code: 'no_anchor' });
  });

  it('hot-polling 只对 pg.hot_polling 适用', () => {
    const polling = { ...dominant, kind: 'pg.hot_polling' };
    expect(applicableIssues(set.issues, goal(polling), 'database').applicable).toEqual(['postgres/hot-polling']);
    expect(planIssue(set.issues, 'postgres/hot-polling', goal(polling))).toMatchObject({ kind: 'issue' });
  });
});

const DEPLOY = (name: string, cpu: string, memory: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: ${name}
          resources:
            requests: { cpu: '${cpu}', memory: ${memory} }
            limits: { memory: ${memory} }
        - name: sidecar
          resources:
            requests: { cpu: 100m, memory: 64Mi }
`;
const WL_LAYOUT: RepositoryLayout = { workloads: { path: 'apps/shop/*.yaml', format: 'yaml' } };

describe('workload/resource-right-size', () => {
  const root = { cluster_id: 'c1', kind: 'Deployment', namespace: 'shop', name: 'report' };
  const entity = { type: 'Deployment', key: 'Deployment:shop/report', display: 'report', labels: {} };
  const cpu = { kind: 'workload.cpu_overprovisioned', share: 1, entity };
  const mem = { ...cpu, kind: 'workload.memory_overprovisioned' };

  it('CPU request 按 14 天 p99 的 1.2 倍调低，单次不低于当前值的一半；预期收益乘副本数', async () => {
    const files = { 'apps/shop/report.yaml': DEPLOY('report', '1', '1Gi') };
    const p = await plan('workload/resource-right-size', ctx(root, goal(cpu)), files, WL_LAYOUT);
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') {
      return;
    }
    // p99 0.1 核 × 1.2 = 0.12 核，但单次最多减半：500m
    expect(p.patch).toContain("+            requests: { cpu: '500m', memory: 1Gi }");
    expect(p.estimate).toMatchObject({ indicator: 'workload/cpu-requested', unit: 'cores', lower: 1.5 });
  });

  it('按 CPU 利用率伸缩的工作负载以 guard 跳过', async () => {
    const files = { 'apps/shop/web.yaml': DEPLOY('web', '1', '1Gi') };
    const p = await plan('workload/resource-right-size', ctx({ ...root, name: 'web' }, goal(cpu)), files, WL_LAYOUT);
    expect(p).toMatchObject({ kind: 'skipped', code: 'guard', guard: 'no-cpu-hpa' });
  });

  it('内存 request 与 limit 按最大工作集的 1.25 倍一起调低', async () => {
    const files = { 'apps/shop/report.yaml': DEPLOY('report', '1', '512Mi') };
    const p = await plan('workload/resource-right-size-memory', ctx(root, goal(mem)), files, WL_LAYOUT);
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') {
      return;
    }
    // 200Mi × 1.25 = 250Mi，不低于 512Mi 的一半（256Mi）：256Mi
    expect(p.patch).toContain("+            requests: { cpu: '1', memory: 256Mi }");
    expect(p.patch).toContain('+            limits: { memory: 256Mi }');
    expect(p.estimate).toMatchObject({ indicator: 'workload/memory-requested', lower: 256 * 2 ** 20 * 3 });
  });

  it('CPU 模板不处理内存发现，事件上下文不用这两个模板', () => {
    expect(applicable(ctx(root, goal(mem)))).toEqual(['workload/resource-right-size-memory']);
    expect(applicable(ctx(root)).filter((k) => k.startsWith('workload/resource-right-size'))).toEqual([]);
  });
});
