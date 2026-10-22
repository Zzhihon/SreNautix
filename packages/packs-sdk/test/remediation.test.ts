// 修复补丁模板（packs/gitops）在两种仓库布局上的计划：同一套模板，CCHP 形态（多文档 YAML、规则文件 glob、VMRule）
// 与 Kind 形态（每类一个文件、PrometheusRule）只靠布局配置区分。补丁必须能 git apply --check 到基准提交。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepositoryLayout } from '@srenautix/contract';
import {
  backendsDir,
  PrometheusApiAdapter,
  startPrometheus,
  type FixtureMetricSeries,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compilePackSet, type PackSet } from '../src/pack/compile.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import {
  componentRef,
  durationSecondsOf,
  kebabOf,
  quantityBytes,
  quantityCores,
} from '../src/remediation/functions.js';
import { applicableRemediations, planRemediation, type RemediationContext } from '../src/remediation/plan.js';
import { GitRepoReader } from '../src/remediation/repo.js';
import { LiveDataSource } from '../src/runtime/datasource.js';
import { CATALOG, PACKS } from './support.js';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const AT = T0 + 50 * MIN;
const OLD = 'registry.example/shop@sha256:' + 'a'.repeat(64);
const NEW = 'registry.example/shop@sha256:' + 'b'.repeat(64);
const SIDECAR = 'registry.example/otel@sha256:' + 'd'.repeat(64);
// 写错镜像的坏版本：换成了另一个仓库，新 Pod 拉不起来，就绪 Pod 里没有这个仓库的镜像
const OTHER_REPO = 'registry.example/busybox@sha256:' + 'e'.repeat(64);

const flat = (v: number) => Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v }));
const series = (labels: Record<string, string>, v = 1): FixtureMetricSeries => ({ labels, points: flat(v) });

// shop：旧版本 aaaa 的 api 就绪，新版本 bbbb 的 api 卡住未就绪；三个就绪的 otel 边车用别的镜像仓库；web 的容器被 OOMKilled
const fixtures: FixtureMetricSeries[] = [
  ...['api-5f7b8c9d6e-k2m4n', 'api-5f7b8c9d6e-p7q8r'].flatMap((pod) => [
    series({ __name__: 'kube_pod_container_info', namespace: 'shop', pod, container: 'api', image_id: OLD }),
    series({ __name__: 'kube_pod_status_ready', namespace: 'shop', pod, condition: 'true' }),
  ]),
  series({
    __name__: 'kube_pod_container_info',
    namespace: 'shop',
    pod: 'api-7c8d9e0f1a-x2z4w',
    container: 'api',
    image_id: NEW,
  }),
  series({ __name__: 'kube_pod_status_ready', namespace: 'shop', pod: 'api-7c8d9e0f1a-x2z4w', condition: 'true' }, 0),
  ...['otel-0', 'otel-1', 'otel-2'].flatMap((pod) => [
    series({ __name__: 'kube_pod_container_info', namespace: 'shop', pod, container: 'otel', image_id: SIDECAR }),
    series({ __name__: 'kube_pod_status_ready', namespace: 'shop', pod, condition: 'true' }),
  ]),
  series({
    __name__: 'kube_pod_container_status_last_terminated_reason',
    namespace: 'shop',
    pod: 'web-6b7c8d9e0f-a2b4c',
    container: 'web',
    reason: 'OOMKilled',
  }),
];

const release = (image: string, id: string) =>
  JSON.stringify(
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'shop-release' }, data: { image, release_id: id } },
    null,
    2,
  ) + '\n';

const HPA_API = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: api}
  minReplicas: 2
  # 上限按节点容量估算
  maxReplicas: 5
`;
const HPA_WEB = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: web}
  minReplicas: 1
  maxReplicas: 3
`;
const deployment = (name: string, memory: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  template:
    spec:
      containers:
      - name: ${name}
        image: registry.example/shop:placeholder
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            memory: ${memory}
`;
const rules = (kind: string, group: string, body: string) => `apiVersion: monitoring.coreos.com/v1
kind: ${kind}
metadata:
  name: ${group}
spec:
  groups:
  - name: ${group}
    rules:
${body}`;
const HPA_RULE = `    - alert: KubeHpaMaxedOut
      expr: kube_horizontalpodautoscaler_status_current_replicas >= kube_horizontalpodautoscaler_spec_max_replicas
      for: 30m
      labels:
        severity: critical
`;
const RESTART_RULE = `    - alert: ShopPodRestarted
      expr: increase(kube_pod_container_status_restarts_total{namespace="shop"}[5m]) > 0
      labels:
        severity: critical
`;
const PAIRED_RULES = `    - alert: ShopLatencyHigh
      expr: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 0.5
      for: 10m
      labels:
        severity: warning
    - alert: ShopLatencyHigh
      expr: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 1
      for: 10m
      labels:
        severity: critical
`;
const CATALOG_FILE = `# 告警目录
entries:
  - { id: shop-api-down, alertname: ShopApiDown, role: symptom, entity: { kind: Deployment, name_labels: [deployment] } }
`;

interface Shape {
  name: string;
  files: (rel: string) => Record<string, string>;
  layout: RepositoryLayout;
}

// 同一组逻辑内容的两种布局
const SHAPES: Shape[] = [
  {
    name: 'CCHP 形态',
    files: (rel) => ({
      'apps/shop/prod/release.json': rel,
      'apps/shop/prod/autoscaling.yaml': `${HPA_WEB}---\n${HPA_API}`,
      'apps/shop/base/workloads.yaml': `${deployment('api', '1Gi')}---\n${deployment('web', '512Mi')}`,
      'platform/observability/metrics/platform-rules.yaml': rules('VMRule', 'platform', HPA_RULE),
      'platform/observability/metrics/shop-rules.yaml': rules('VMRule', 'shop', RESTART_RULE + PAIRED_RULES),
      'platform/srenautix/app/packs/shop/alerts.yaml': CATALOG_FILE,
    }),
    layout: {
      release_input: {
        path: 'apps/shop/prod/release.json',
        format: 'json',
        fields: { image: 'data.image', release_id: 'data.release_id' },
      },
      autoscaling: { path: 'apps/shop/prod/autoscaling.yaml', format: 'yaml' },
      workloads: { path: 'apps/shop/base/workloads.yaml', format: 'yaml' },
      alert_rules: { path: 'platform/observability/metrics/*.yaml', format: 'yaml' },
      pack_alerts: { path: 'platform/srenautix/app/packs/shop/alerts.yaml', format: 'yaml' },
    },
  },
  {
    name: 'Kind 形态',
    files: (rel) => ({
      'apps/shop/release.json': rel,
      'apps/shop/autoscaling.yaml': HPA_API,
      'apps/shop/workloads.yaml': `${deployment('api', '1Gi')}---\n${deployment('web', '512Mi')}`,
      'platform/observability/rules/shop.yaml': rules('PrometheusRule', 'shop', HPA_RULE + RESTART_RULE + PAIRED_RULES),
      'srenautix/packs/kind-shop/alerts.yaml': CATALOG_FILE,
    }),
    layout: {
      release_input: {
        path: 'apps/shop/release.json',
        format: 'json',
        fields: { image: 'data.image', release_id: 'data.release_id' },
      },
      autoscaling: { path: 'apps/shop/autoscaling.yaml', format: 'yaml' },
      workloads: { path: 'apps/shop/workloads.yaml', format: 'yaml' },
      alert_rules: { path: 'platform/observability/rules/*.yaml', format: 'yaml' },
      pack_alerts: { path: 'srenautix/packs/kind-shop/alerts.yaml', format: 'yaml' },
    },
  },
];

const scratch: string[] = [];
let prom: TsdbInstance | undefined;
let ds: LiveDataSource;
let set: PackSet;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    encoding: 'utf8',
  });
}

function commitAll(dir: string, files: Record<string, string>, message: string): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

/** 发布 r1（aaaa）后发布 r2（bbbb）的仓库；serving 为 r1 时 head 指向 r2 */
function makeRepo(shape: Shape, releases: Array<[string, string]>): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'remediation-'));
  scratch.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [image, id] of releases) {
    commitAll(dir, shape.files(release(image, id)), `release ${id}`);
  }
  return dir;
}

function applyCheck(dir: string, patch: string): void {
  const p = join(dir, '..', `${dir.split('/').pop()}.patch`);
  writeFileSync(p, patch);
  scratch.push(p);
  git(dir, ['apply', '--check', p]);
  git(dir, ['apply', p]);
}

const ctx = (over: Partial<RemediationContext>): RemediationContext => ({
  incident: { id: 'inc-1' },
  root: null,
  cards: {},
  alerts: [],
  ...over,
});

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
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

const stuck = ctx({
  root: { cluster_id: 'c1', kind: 'Deployment', namespace: 'shop', name: 'api' },
  cards: { 'workload/release/init-waiting': { verdict: 'abnormal' } },
  root_cards: { 'workload/release/init-waiting': { verdict: 'abnormal' } },
});

it('发布回退只看根因自己的卡：别处的 init 卡异常、根因上正常或没有执行时不适用（ADR 0139）', () => {
  const keys = (c: RemediationContext) => applicableRemediations(set, c).applicable.map((a) => a.key);
  // 根因是节点：事件里另一个工作负载的 init 卡异常
  expect(
    keys(
      ctx({
        root: { cluster_id: 'c1', kind: 'Node', namespace: null, name: 'worker-1' },
        cards: { 'workload/release/init-waiting': { verdict: 'abnormal' } },
      }),
    ),
  ).not.toContain('gitops/release-to-serving-version');
  // 根因上的两张卡都正常
  expect(
    keys(
      ctx({
        ...stuck,
        root_cards: {
          'workload/release/init-waiting': { verdict: 'normal' },
          'workload/release/replicasets': { verdict: 'normal' },
        },
      }),
    ),
  ).not.toContain('gitops/release-to-serving-version');
  // 根因上 ReplicaSet 没有就绪也适用
  expect(keys(ctx({ ...stuck, root_cards: { 'workload/release/replicasets': { verdict: 'abnormal' } } }))).toContain(
    'gitops/release-to-serving-version',
  );
  // StatefulSet 的发布进度卡：窗口结束时仍有副本未就绪才适用，只有 spec 变更的异常不算
  const sts = (missing: number) =>
    ctx({
      root: { cluster_id: 'c1', kind: 'StatefulSet', namespace: 'shop', name: 'gateway' },
      root_cards: {
        'workload/release/init-waiting': { verdict: 'normal' },
        'workload/rollout/statefulset': { verdict: 'abnormal', observations: { missing, stale: 0, specChanges: 1 } },
      },
    });
  expect(keys(sts(2))).toContain('gitops/release-to-serving-version');
  expect(keys(sts(0))).not.toContain('gitops/release-to-serving-version');
});

describe.each(SHAPES)('$name', (shape) => {
  it('发布卡住：发布输入改回就绪 Pod 正在运行的版本，补丁能应用到基准提交', async () => {
    const dir = makeRepo(shape, [
      [OLD, 'r1'],
      [NEW, 'r2'],
    ]);
    const repo = new GitRepoReader(dir);
    expect(applicableRemediations(set, stuck).applicable.map((a) => a.key)).toEqual([
      'gitops/release-to-serving-version',
    ]);
    const plan = await planRemediation(
      set,
      'gitops/release-to-serving-version',
      stuck,
      { repo, layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    expect(plan.base).toBe(git(dir, ['rev-parse', 'HEAD']).trim());
    expect(
      plan.patch.startsWith(`diff --git a/${shape.layout.release_input!.path} b/${shape.layout.release_input!.path}\n`),
    ).toBe(true);
    expect(plan.change['zh-CN']).toContain('r1');
    applyCheck(dir, plan.patch);
    // 应用后与 r1 的提交内容逐字节相同
    expect(readFileSync(join(dir, shape.layout.release_input!.path), 'utf8')).toBe(release(OLD, 'r1'));
  });

  it('坏版本换了镜像仓库：从发布输入历史中的仓库找到正在服务的 r1 并回退（Zzhihon/SreNautix#5）', async () => {
    const dir = makeRepo(shape, [
      [OLD, 'r1'],
      [OTHER_REPO, 'r2'],
    ]);
    const plan = await planRemediation(
      set,
      'gitops/release-to-serving-version',
      stuck,
      { repo: new GitRepoReader(dir), layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    expect(plan.change['zh-CN']).toContain('r1');
    applyCheck(dir, plan.patch);
    expect(readFileSync(join(dir, shape.layout.release_input!.path), 'utf8')).toBe(release(OLD, 'r1'));
  });

  it('发布输入已经指向正在服务的版本时跳过', async () => {
    const dir = makeRepo(shape, [
      [NEW, 'r2'],
      [OLD, 'r1'],
    ]);
    const plan = await planRemediation(
      set,
      'gitops/release-to-serving-version',
      stuck,
      { repo: new GitRepoReader(dir), layout: shape.layout },
      ds,
      AT,
    );
    expect(plan).toMatchObject({ kind: 'skipped', code: 'skip_if' });
    expect(plan.kind === 'skipped' && plan.reason['zh-CN']).toContain('r1');
  });

  it('HPA 顶到上限：maxReplicas 加 2，保留注释与其他文档', async () => {
    const dir = makeRepo(shape, [[OLD, 'r1']]);
    const c = ctx({
      root: { cluster_id: 'c1', kind: 'HorizontalPodAutoscaler', namespace: 'shop', name: 'api' },
      cards: { 'workload/capacity/hpa': { verdict: 'abnormal' } },
    });
    const plan = await planRemediation(
      set,
      'gitops/hpa-max-replicas-raise',
      c,
      { repo: new GitRepoReader(dir), layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    expect(plan.patch).toContain('-  maxReplicas: 5\n+  maxReplicas: 7\n');
    applyCheck(dir, plan.patch);
    const text = readFileSync(join(dir, shape.layout.autoscaling!.path), 'utf8');
    expect(text).toContain('# 上限按节点容量估算');
  });

  it('容器 OOMKilled：内存 limit 乘 1.5，只改这个容器', async () => {
    const dir = makeRepo(shape, [[OLD, 'r1']]);
    const c = ctx({
      root: { cluster_id: 'c1', kind: 'Deployment', namespace: 'shop', name: 'web' },
      cards: { 'workload/pod-restarts/memory': { verdict: 'abnormal' } },
      root_cards: { 'workload/pod-restarts/memory': { verdict: 'abnormal' } },
    });
    // 只看根因自己的内存卡：别的工作负载被 OOMKilled（全局卡异常、根因上正常）时不适用（ADR 0139）
    expect(
      applicableRemediations(set, {
        ...c,
        root_cards: { 'workload/pod-restarts/memory': { verdict: 'normal' } },
      }).applicable.map((a) => a.key),
    ).not.toContain('gitops/memory-limit-raise');
    const plan = await planRemediation(
      set,
      'gitops/memory-limit-raise',
      c,
      { repo: new GitRepoReader(dir), layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    expect(plan.patch).toContain('-            memory: 512Mi\n+            memory: 768Mi\n');
    expect(plan.patch.match(/^\+/gm)?.length).toBe(2);
    applyCheck(dir, plan.patch);
  });

  it('长期 critical 告警、影响卡全部正常：降为 warning，for 至少 1h', async () => {
    const dir = makeRepo(shape, [[OLD, 'r1']]);
    const c = ctx({
      alerts: [
        {
          alertname: 'KubeHpaMaxedOut',
          labels: { severity: 'critical', namespace: 'shop' },
          annotations: {},
          role: 'cause',
          source: 'catalog',
          catalog_entry: 'alerts-kps/kube-hpa-maxed-out',
          chronic: true,
          entity: null,
        },
      ],
      cards: {
        'workload/capacity/hpa': { verdict: 'abnormal' },
        'workload/capacity/hpa-throttling': { verdict: 'normal', impact: true },
        'workload/capacity/hpa-latency': { verdict: 'normal', impact: true },
      },
    });
    expect(applicableRemediations(set, c).applicable.map((a) => a.key)).toEqual(['gitops/noisy-alert-relax']);
    // 影响卡有一张异常或无法判定、或者事件没有影响卡时不适用（ADR 0139）
    const keys = (over: Partial<RemediationContext>) =>
      applicableRemediations(set, { ...c, ...over }).applicable.map((a) => a.key);
    expect(
      keys({ cards: { ...c.cards, 'workload/capacity/hpa-latency': { verdict: 'undeterminable', impact: true } } }),
    ).not.toContain('gitops/noisy-alert-relax');
    expect(
      keys({ cards: { ...c.cards, 'workload/capacity/hpa-throttling': { verdict: 'abnormal', impact: true } } }),
    ).not.toContain('gitops/noisy-alert-relax');
    expect(keys({ cards: { 'workload/capacity/hpa': { verdict: 'abnormal' } } })).not.toContain(
      'gitops/noisy-alert-relax',
    );
    const plan = await planRemediation(
      set,
      'gitops/noisy-alert-relax',
      c,
      { repo: new GitRepoReader(dir), layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    expect(plan.patch).toContain('-      for: 30m\n+      for: 1h\n');
    expect(plan.patch).toContain('-        severity: critical\n+        severity: warning\n');
    applyCheck(dir, plan.patch);
  });

  it('研判结论为不需要处理：不是长期告警的症状告警也降级并补上 for；同名有两条规则时跳过', async () => {
    const dir = makeRepo(shape, [[OLD, 'r1']]);
    const alert = (alertname: string) => ({
      alertname,
      labels: { severity: 'critical', namespace: 'shop' },
      annotations: {},
      role: 'symptom',
      source: 'label',
      catalog_entry: null,
      chronic: false,
      entity: null,
    });
    const ignore = { disposition: 'ignore', level: 'likely' };
    const repo = new GitRepoReader(dir);
    // 没有研判结论时，非长期告警不适用
    expect(
      applicableRemediations(set, ctx({ alerts: [alert('ShopPodRestarted')] })).applicable.map((a) => a.key),
    ).not.toContain('gitops/noisy-alert-relax');
    const c = ctx({ alerts: [alert('ShopPodRestarted')], research: ignore });
    expect(applicableRemediations(set, c).applicable.map((a) => a.key)).toContain('gitops/noisy-alert-relax');
    // 根因是集群外部组件（外部上游服务方）时，研判判为 ignore 也不降级：外部上游出故障时告警本身是对的（ADR 0139）
    const upstream = ctx({
      alerts: [alert('ShopProviderErrorsCritical')],
      research: ignore,
      root: { cluster_id: 'c1', kind: 'provider', namespace: null, name: 'openai', external: true },
    });
    expect(applicableRemediations(set, upstream).applicable.map((a) => a.key)).not.toContain(
      'gitops/noisy-alert-relax',
    );
    expect(
      applicableRemediations(set, { ...upstream, root: { ...upstream.root!, external: false } }).applicable.map(
        (a) => a.key,
      ),
    ).toContain('gitops/noisy-alert-relax');
    const plan = await planRemediation(set, 'gitops/noisy-alert-relax', c, { repo, layout: shape.layout }, ds, AT);
    expect(plan.kind).toBe('plan');
    if (plan.kind === 'plan') {
      expect(plan.patch).toContain('+      for: 1h\n');
      expect(plan.change['zh-CN']).toContain('研判结论为不需要处理');
      applyCheck(dir, plan.patch);
    }
    const paired = await planRemediation(
      set,
      'gitops/noisy-alert-relax',
      ctx({ alerts: [alert('ShopLatencyHigh')], research: ignore }),
      { repo, layout: shape.layout },
      ds,
      AT,
    );
    expect(paired).toMatchObject({ kind: 'skipped', code: 'skip_if' });
  });

  it('未覆盖的告警只带 service 标签：实体为逻辑组件', async () => {
    const dir = makeRepo(shape, [[OLD, 'r1']]);
    const c = ctx({
      alerts: [
        {
          alertname: 'ShopCatalogStale',
          labels: { severity: 'warning', service: 'catalog' },
          annotations: {},
          role: 'symptom',
          source: 'default',
          catalog_entry: null,
          chronic: false,
          entity: null,
        },
      ],
    });
    const plan = await planRemediation(
      set,
      'gitops/alert-catalog-entry',
      c,
      { repo: new GitRepoReader(dir), layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    applyCheck(dir, plan.patch);
    const doc = parse(readFileSync(join(dir, shape.layout.pack_alerts!.path), 'utf8')) as { entries: unknown[] };
    expect(doc.entries[1]).toEqual({
      id: 'shop-catalog-stale',
      alertname: 'ShopCatalogStale',
      role: 'symptom',
      entity: { kind: 'component', name_labels: ['service'] },
    });
  });

  it('未覆盖的告警：按 deployment 标签加目录条目；已有条目时跳过', async () => {
    const dir = makeRepo(shape, [[OLD, 'r1']]);
    const alert = (alertname: string) => ({
      alertname,
      labels: { severity: 'critical', namespace: 'shop', deployment: 'worker', component: 'worker' },
      annotations: {},
      role: 'cause',
      source: 'label',
      catalog_entry: null,
      chronic: false,
      entity: null,
    });
    const repo = new GitRepoReader(dir);
    const plan = await planRemediation(
      set,
      'gitops/alert-catalog-entry',
      ctx({ alerts: [alert('ShopWorkerNoAvailableReplicas')] }),
      { repo, layout: shape.layout },
      ds,
      AT,
    );
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') {
      return;
    }
    applyCheck(dir, plan.patch);
    const doc = parse(readFileSync(join(dir, shape.layout.pack_alerts!.path), 'utf8')) as { entries: unknown[] };
    expect(doc.entries[1]).toEqual({
      id: 'shop-worker-no-available-replicas',
      alertname: 'ShopWorkerNoAvailableReplicas',
      role: 'cause',
      entity: { kind: 'Deployment', name_labels: ['deployment'] },
    });
    const again = await planRemediation(
      set,
      'gitops/alert-catalog-entry',
      ctx({ alerts: [alert('ShopApiDown')] }),
      { repo, layout: shape.layout },
      ds,
      AT,
    );
    expect(again).toMatchObject({ kind: 'skipped', code: 'skip_if' });
  });
});

it('模板函数：组件键、时长、数量与 kebab-case', () => {
  expect(Object.fromEntries(componentRef('ClusterRole:system%3Anode'))).toEqual({
    kind: 'ClusterRole',
    namespace: null,
    name: 'system:node',
  });
  expect(Object.fromEntries(componentRef('Deployment:shop/api'))).toEqual({
    kind: 'Deployment',
    namespace: 'shop',
    name: 'api',
  });
  expect(() => componentRef('not a key')).toThrow(TypeError);
  expect(durationSecondsOf('1h30m')).toBe(5400);
  expect(() => durationSecondsOf('30 minutes')).toThrow(TypeError);
  expect(quantityBytes('1.5Gi')).toBe(1.5 * 2 ** 30);
  expect(quantityCores('250m')).toBe(0.25);
  expect(kebabOf('CCHPImageBelowCompatFloor')).toBe('cchp-image-below-compat-floor');
  expect(kebabOf('KubeHpaMaxedOut')).toBe('kube-hpa-maxed-out');
});

it('根因是管理工作负载的 Argo 应用：从事件组件取工作负载查询正在服务的版本', async () => {
  const dir = makeRepo(SHAPES[0]!, [
    [OLD, 'r1'],
    [NEW, 'r2'],
  ]);
  const c = ctx({
    incident: {
      id: 'inc-2',
      components: ['Application.argoproj.io:argocd/shop', 'Deployment:shop/api', 'Namespace:shop'],
    },
    root: { cluster_id: 'c1', kind: 'Application.argoproj.io', namespace: 'argocd', name: 'shop' },
    cards: { 'workload/release/replicasets': { verdict: 'abnormal' } },
    // 应用管理的 Deployment shop/api 上的卡属于这个根因（ADR 0139）
    root_cards: { 'workload/release/replicasets': { verdict: 'abnormal' } },
  });
  const plan = await planRemediation(
    set,
    'gitops/release-to-serving-version',
    c,
    { repo: new GitRepoReader(dir), layout: SHAPES[0]!.layout },
    ds,
    AT,
  );
  expect(plan.kind).toBe('plan');
  // 事件里没有工作负载组件时没有可查询的实体
  const none = await planRemediation(
    set,
    'gitops/release-to-serving-version',
    { ...c, incident: { id: 'inc-3', components: ['Application.argoproj.io:argocd/shop'] } },
    { repo: new GitRepoReader(dir), layout: SHAPES[0]!.layout },
    ds,
    AT,
  );
  expect(none).toMatchObject({ kind: 'skipped', code: 'input_failed' });
});

it('布局缺少模板用到的文件角色时跳过', async () => {
  const dir = makeRepo(SHAPES[1]!, [[OLD, 'r1']]);
  const layout = Object.fromEntries(Object.entries(SHAPES[1]!.layout).filter(([role]) => role !== 'release_input'));
  const plan = await planRemediation(
    set,
    'gitops/release-to-serving-version',
    stuck,
    { repo: new GitRepoReader(dir), layout },
    ds,
    AT,
  );
  expect(plan).toMatchObject({ kind: 'skipped', code: 'layout_missing' });
});
