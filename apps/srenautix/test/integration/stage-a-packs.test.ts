import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Alert, Incident } from '@srenautix/contract';
import { startPrometheus, type FixtureMetricSeries, type TsdbInstance } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { PackEvidence, PackRules } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { exampleWithTemplate, PACKS } from '../support/packs.js';

/**
 * 阶段 A 接入领域包运行时：真实 Prometheus（夹具回填成块）、仓库中的 _example 包、真实的拓扑存储。
 * 证据链按告警目录条目与根因的组件类型选择，规则提议引用动作目录中的动作。
 */
const REPO = resolve(import.meta.dirname, '../../../..');
const SCRATCH = join(REPO, '.scratch', `stage-a-packs-${process.pid}`);
const CAPS = new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const);

const MIN = 60_000;
// 夹具的时间轴以当前时间为终点：首次触发在 15 分钟前
const T = Math.floor(Date.now() / MIN) * MIN;
const FIRST = T - 15 * MIN;

const range = (from: number, to: number, step: number, v: (t: number) => number) => {
  const out: Array<{ t: number; v: number }> = [];
  for (let t = from; t <= to; t += step) {
    out.push({ t, v: v(t) });
  }
  return out;
};

function fixtures(): FixtureMetricSeries[] {
  const from = T - 60 * MIN;
  const limit = (pod: string): FixtureMetricSeries => ({
    labels: {
      __name__: 'kube_pod_container_resource_limits',
      namespace: 'shop',
      pod,
      container: 'web',
      resource: 'memory',
      unit: 'byte',
    },
    points: range(from, T, MIN, () => 1e9),
  });
  const ws = (pod: string, v: (t: number) => number): FixtureMetricSeries => ({
    labels: { __name__: 'container_memory_working_set_bytes', namespace: 'shop', pod, container: 'web' },
    points: range(from, T, MIN, v),
  });
  const info = (pod: string): FixtureMetricSeries => ({
    labels: { __name__: 'kube_pod_container_info', namespace: 'shop', pod, container: 'web', node: 'worker-1' },
    points: range(from, T, MIN, () => 1),
  });
  const oom = (pod: string): FixtureMetricSeries => ({
    labels: { __name__: 'container_oom_events_total', namespace: 'shop', pod, container: 'web' },
    points: range(from, T, MIN, () => 0),
  });
  return [
    // web-0：首次触发前 20 分钟升到 limit 的 95%，没有 OOM
    ws('web-0', (t) => (t < FIRST - 20 * MIN ? 5e8 : 9.5e8)),
    limit('web-0'),
    info('web-0'),
    oom('web-0'),
    // shop/api 的 Deployment Pod：一直在 40%
    ws('api-7d9c8b6f5-x2x7k', () => 4e8),
    limit('api-7d9c8b6f5-x2x7k'),
    info('api-7d9c8b6f5-x2x7k'),
    oom('api-7d9c8b6f5-x2x7k'),
    // 抓取间隔 30 秒
    { labels: { __name__: 'up', job: 'kubelet', instance: 'worker-1' }, points: range(from, T, MIN / 2, () => 1) },
  ];
}

function incident(root: { kind: string; namespace: string; name: string }): Incident {
  const key = `${root.kind}:${root.namespace}/${root.name}`;
  return {
    incident_id: '0b0c4c1e-7c8e-4d55-9a57-3f1f1c2a9e10',
    cluster_id: 'east',
    label: `${key}:x`,
    incident_version: 1,
    state: 'firing',
    severity: 'warning',
    first_firing_at: new Date(FIRST).toISOString(),
    ended_at: null,
    root: {
      component: key,
      entity: { cluster_id: 'east', ...root, uid: null },
      ambiguous: false,
      margin: null,
      silent_root: false,
    },
    candidates: [],
    members: [],
    components: [key],
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 1,
    created_at: new Date(FIRST).toISOString(),
    updated_at: new Date(FIRST).toISOString(),
  } as Incident;
}

function memoryAlert(pod: string): Alert {
  return {
    alert_id: `0000000000000001@${FIRST / 1000}`,
    cluster_id: 'east',
    source: 'alertmanager',
    fingerprint: '0000000000000001',
    alertname: 'ExampleContainerMemoryHigh',
    labels: { alertname: 'ExampleContainerMemoryHigh', namespace: 'shop', pod, container: 'web' },
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(FIRST).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: {
      role: 'cause',
      source: 'catalog',
      confidence: 1,
      catalog_entry: '_example/example-container-memory-high',
      chronic: false,
    },
    entity: { cluster_id: 'east', kind: 'Pod', namespace: 'shop', name: pod, uid: 'uid-web-0' },
    entity_resolution: 'informer',
    component: `Pod:shop/${pod}`,
    received_at: new Date(FIRST).toISOString(),
  };
}

let db: TestDb;
let prom: TsdbInstance;
let rt: PackRuntime;
let evidence: PackEvidence;
let rules: PackRules;
let source: EvidenceSource;
const metrics = new ServerMetrics('server', false);

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  prom = await startPrometheus(fixtures());
  rt = await PackRuntime.load({
    dirs: [PACKS],
    only: ['_example'],
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: CAPS,
  });
  const topology = new TopologyStore(db.server);
  await topology.apply('east', [
    {
      op: 'node_upsert',
      at: new Date(T - 60 * MIN),
      source: 'informer',
      node: {
        key: 'Deployment:shop/api',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'api',
        uid: 'uid-api',
        labels: { 'app.kubernetes.io/part-of': 'example-shop' },
        component_type: 'example.web',
        hub: false,
      },
    },
  ]);
  source = await EvidenceSource.create({
    id: 'prometheus',
    url: prom.url,
    dialect: 'promql',
    bearerTokenFile: null,
    timeoutMs: 10_000,
  });
  evidence = new PackEvidence(
    rt,
    source,
    (clusterId, key) => topology.componentType(clusterId, key),
    { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 10_000 },
    metrics,
  );
  rules = new PackRules(rt, metrics);
}, 180_000);

afterAll(async () => {
  await prom?.stop();
  await db?.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('阶段 A 的领域包证据链', () => {
  it('按告警目录条目执行证据链：Pod 的内存卡异常，没有日志能力的卡显示能力缺失，规则提议重建 Pod', async () => {
    const inc = incident({ kind: 'Pod', namespace: 'shop', name: 'web-0' });
    const alerts = [memoryAlert('web-0')];
    const run = await evidence.run(inc, alerts, AbortSignal.timeout(30_000));
    expect(run.cards.map((c) => [c.ref, c.card_id, c.display_state])).toEqual([
      ['card:1', '_example/pod-memory/limit-ratio', 'abnormal'],
      ['card:2', '_example/pod-memory/oom-logs', 'capability_missing'],
    ]);
    const mem = run.cards[0]!;
    expect(mem.entity).toEqual({ cluster_id: 'east', kind: 'Pod', namespace: 'shop', name: 'web-0', uid: 'uid-web-0' });
    expect(mem.reason.kind).toBe('rule');
    expect(mem.queries.map((q) => [q.name, q.integration, q.error])).toEqual([
      ['mem', 'prometheus', null],
      ['oom', 'prometheus', null],
    ]);
    expect(mem.series.length).toBeGreaterThan(0);
    expect(run.chains).toEqual(['_example/pod-memory']);
    expect(run.runbooks).toEqual(['_example/container-memory.md']);
    expect(run.rootComponentType).toBeNull();
    expect(rules.excluded(inc, alerts, run)).toBeNull();

    const hits = rules.evaluate(inc, alerts, run);
    expect(hits).toEqual([
      {
        pack: '_example',
        ruleId: 'oom-restart-pod',
        action: 'pod_restart',
        params: { namespace: 'shop', pod: 'web-0' },
        title: { 'zh-CN': '重建反复 OOM 的 Pod', en: 'Recreate a pod that keeps getting OOM-killed' },
        expectedEffect: expect.objectContaining({ 'zh-CN': expect.any(String) }),
      },
    ]);
  });

  it('按根因的组件类型执行证据链：Deployment 汇总它的 Pod，内存平稳时判为正常且不出规则提议', async () => {
    const inc = incident({ kind: 'Deployment', namespace: 'shop', name: 'api' });
    const run = await evidence.run(inc, [], AbortSignal.timeout(30_000));
    expect(run.rootComponentType).toBe('example.web');
    // oom-logs 只适用于 Pod
    expect(run.cards.map((c) => [c.card_id, c.verdict, c.reason.kind])).toEqual([
      ['_example/pod-memory/limit-ratio', 'normal', 'all_clear'],
    ]);
    expect(rules.evaluate(inc, [], run)).toEqual([]);
  });

  it('执行过的证据链上的排除规则命中时返回规则引用', () => {
    const run = {
      cards: [],
      chains: ['_example/pod-memory'],
      runbooks: [],
      rootComponentType: null,
    };
    const loadtest = incident({ kind: 'Pod', namespace: 'loadtest-7', name: 'web-0' });
    expect(rules.excluded(loadtest, [], run)).toBe('_example/pod-memory#excludes[0]');
    // 没有执行这条证据链时不求值它的排除规则
    expect(rules.excluded(loadtest, [], { ...run, chains: [] })).toBeNull();
  });

  const labelled = (pod: string, component: string): Alert => ({
    ...memoryAlert(pod),
    alertname: 'CustomMemoryAlert',
    labels: { alertname: 'CustomMemoryAlert', role: 'cause', entity_kind: 'pod', entity: pod, namespace: 'shop' },
    classification: { role: 'cause', source: 'label', confidence: 1, catalog_entry: null, chronic: false },
    entity_resolution: 'labels',
    component,
  });

  it('按标签分类、没有目录条目的告警：按告警归属组件的组件类型执行证据链（ADR 0097）', async () => {
    const inc = incident({ kind: 'Pod', namespace: 'shop', name: 'web-0' });
    const run = await evidence.run(inc, [labelled('web-0', 'Deployment:shop/api')], AbortSignal.timeout(30_000));
    expect(run.cards.map((c) => [c.card_id, c.entity?.kind, c.entity?.name])).toEqual([
      ['_example/pod-memory/limit-ratio', 'Pod', 'web-0'],
      ['_example/pod-memory/oom-logs', 'Pod', 'web-0'],
      ['_example/pod-memory/limit-ratio', 'Deployment', 'api'],
    ]);
    expect(run.chains).toEqual(['_example/pod-memory']);
  });

  it('实体没有拓扑节点时按 kind 静态匹配组件类型；只按 kind 匹配的类型是兜底', async () => {
    const dir = join(SCRATCH, 'kind-fallback');
    mkdirSync(dir, { recursive: true });
    cpSync(join(PACKS, '_example'), join(dir, '_example'), { recursive: true });
    writeFileSync(
      join(dir, '_example', 'components.yaml'),
      [
        'component_types:',
        '  - id: example.web',
        '    match: { kind: Deployment, labels: { app.kubernetes.io/part-of: example-shop } }',
        '    chains: [pod-memory]',
        '  - id: example.pod',
        '    match: { kind: Pod }',
        '    chains: [pod-memory]',
        '',
      ].join('\n'),
    );
    const r = await PackRuntime.load({
      dirs: [dir],
      only: ['_example'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: CAPS,
    });
    const ev = new PackEvidence(
      r,
      source,
      async () => null,
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 10_000 },
      metrics,
    );
    const inc = incident({ kind: 'Pod', namespace: 'shop', name: 'web-0' });
    // 告警归属的组件就是实体本身，拓扑里没有它
    const run = await ev.run(inc, [labelled('web-0', 'Pod:shop/web-0')], AbortSignal.timeout(30_000));
    expect(run.rootComponentType).toBe('example.pod');
    expect(run.cards.map((c) => [c.card_id, c.display_state])).toEqual([
      ['_example/pod-memory/limit-ratio', 'abnormal'],
      ['_example/pod-memory/oom-logs', 'capability_missing'],
    ]);
  });

  it('事件开始数小时后评估（回放、重启后补跑）：信号在卡片窗口的终点探测，不按墙上时钟', async () => {
    // 新的数据源：标签档案与信号备选都没有缓存。数据只到 T；评估时刻是 T 之后 5 小时
    const fresh = await EvidenceSource.create({
      id: 'prometheus',
      url: prom.url,
      dialect: 'promql',
      bearerTokenFile: null,
      timeoutMs: 10_000,
    });
    const later = new PackEvidence(
      rt,
      fresh,
      async () => null,
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 10_000 },
      metrics,
    );
    const inc = incident({ kind: 'Pod', namespace: 'shop', name: 'web-0' });
    const run = await later.run(inc, [memoryAlert('web-0')], AbortSignal.timeout(30_000), T + 5 * 60 * MIN);
    expect(run.cards.map((c) => [c.card_id, c.verdict, c.reason.kind])).toEqual([
      ['_example/pod-memory/limit-ratio', 'abnormal', 'rule'],
      ['_example/pod-memory/oom-logs', 'undeterminable', 'capability_missing'],
    ]);
  });

  it('实时重跑只重跑已声明过的卡，编号沿用原结果', async () => {
    const inc = incident({ kind: 'Pod', namespace: 'shop', name: 'web-0' });
    const run = await evidence.run(inc, [memoryAlert('web-0')], AbortSignal.timeout(30_000));
    const again = await evidence.rerun(inc, [run.cards[0]!], new Date(T - 2 * MIN), AbortSignal.timeout(30_000));
    expect(again.map((c) => [c.ref, c.card_id, c.verdict])).toEqual([
      ['card:1', '_example/pod-memory/limit-ratio', 'abnormal'],
    ]);
    expect(Date.parse(again[0]!.window.to)).toBe(T - 2 * MIN);
    // 领域包中已经没有的卡不重跑
    const gone = { ...run.cards[0]!, card_id: '_example/pod-memory/removed' };
    expect(await evidence.rerun(inc, [gone], new Date(T), AbortSignal.timeout(30_000))).toEqual([]);
  });

  it('告警目录、根因排序参数与控制台的包状态来自加载的包', () => {
    expect(rt.alertCatalog().lookup({ alertname: 'ExampleContainerMemoryHigh' })?.entry.role).toBe('cause');
    expect(rt.rcaParams().mergeThreshold).toBe(0.6);
    expect(rt.componentTypes().map((t) => t.id)).toEqual(['example.web']);
    const [st] = rt.statuses();
    expect(st).toMatchObject({
      name: '_example',
      source: 'builtin',
      ref: 'builtin',
      maturity: 'stable',
      loaded: true,
      load_error: null,
      // _example 的 optional 能力 logs.match 不可用
      disabled_capabilities: ['logs.match'],
    });
    expect(st!.digest).toBe(rt.set.lock.packs[0]!.digest);
  });
});

describe('领域包加载失败', () => {
  beforeAll(() => {
    mkdirSync(SCRATCH, { recursive: true });
    cpSync(join(PACKS, '_example'), join(SCRATCH, '_example'), { recursive: true });
    // 第二个包引用动作目录中没有的动作
    cpSync(join(PACKS, '_example'), join(SCRATCH, 'broken'), { recursive: true });
    const manifest = join(SCRATCH, 'broken', 'pack.yaml');
    writeFileSync(
      manifest,
      'api_version: srenautix.io/pack/v1\nname: broken\nversion: 0.1.0\ndescription: 引用了不存在的动作\nmaturity: draft\nmin_srenautix_version: 0.1.0\nrequires: [metrics.query]\n',
    );
    writeFileSync(
      join(SCRATCH, 'broken', 'rules.yaml'),
      'rules:\n  - id: nuke\n    title: { zh-CN: 删除命名空间 }\n    when: "true"\n    action: namespace_delete\n    params: {}\n',
    );
  });

  it('校验不通过的包被禁用并列出原因，其余包照常加载', async () => {
    const r = await PackRuntime.load({
      dirs: [SCRATCH],
      only: ['_example', 'broken'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: CAPS,
    });
    expect(r.set.packs.map((p) => p.name)).toEqual(['_example']);
    expect(r.failures).toEqual([
      expect.objectContaining({
        name: 'broken',
        version: '0.1.0',
        maturity: 'draft',
        error: expect.stringContaining('namespace_delete'),
      }),
    ]);
    expect(r.statuses().map((s) => [s.name, s.loaded])).toEqual([
      ['_example', true],
      ['broken', false],
    ]);
  });

  it('pack.lock 与内容不一致时不加载任何包', async () => {
    const lock = join(SCRATCH, 'pack.lock.yaml');
    writeFileSync(
      lock,
      `api_version: srenautix.io/pack-lock/v1\npacks:\n  - name: _example\n    version: 1.0.0\n    source: builtin\n    digest: sha256:${'0'.repeat(64)}\nlayers: []\n`,
    );
    const r = await PackRuntime.load({
      dirs: [SCRATCH],
      only: ['_example'],
      lockFile: lock,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: CAPS,
    });
    expect(r.set.packs).toEqual([]);
    expect(r.failures.map((f) => f.name)).toEqual(['_example']);
    expect(r.alertCatalog().alertnames()).toEqual([]);
  });

  it('requires 中的能力缺失时整个包禁用', async () => {
    const r = await PackRuntime.load({
      dirs: [PACKS],
      only: ['_example'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query']),
    });
    expect(r.set.disabled).toEqual([{ name: '_example', reason: expect.stringContaining('metrics.query_range') }]);
    expect(r.statuses()[0]).toMatchObject({
      loaded: false,
      load_error: expect.stringContaining('metrics.query_range'),
    });
  });
});

describe('阶段 B 的领域包材料', () => {
  let tpl: PackRuntime;
  let tplEvidence: PackEvidence;

  beforeAll(async () => {
    tpl = await PackRuntime.load({
      dirs: [exampleWithTemplate(join(SCRATCH, 'tpl'))],
      only: ['_example'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: CAPS,
    });
    tplEvidence = new PackEvidence(
      tpl,
      source,
      async () => null,
      { locale: 'zh-CN', concurrency: 2, queryTimeoutMs: 10_000 },
      metrics,
    );
  });

  it('查询模板按附带的卡在真实数据上判定，参数覆盖卡片默认值', async () => {
    expect(tpl.templates.map((t) => [t.id, t.description])).toEqual([
      ['_example/memory-ratio', '容器 working set 占 limit 的峰值，超过 limit_ratio 判为异常'],
    ]);
    const inc = incident({ kind: 'Pod', namespace: 'shop', name: 'web-0' });
    const entity = { cluster_id: 'east', kind: 'Pod', namespace: 'shop', name: 'web-0', uid: 'uid-web-0' };
    const hot = await tplEvidence.runTemplate(
      inc,
      '_example/memory-ratio',
      { limit_ratio: 0.9 },
      entity,
      Date.now(),
      AbortSignal.timeout(30_000),
    );
    expect(hot).toMatchObject({
      card_id: '_example/templates/memory-ratio',
      verdict: 'abnormal',
      reason: { kind: 'rule' },
    });
    expect(hot.entity).toEqual(entity);
    const cool = await tplEvidence.runTemplate(
      inc,
      '_example/memory-ratio',
      { limit_ratio: 0.97 },
      entity,
      Date.now(),
      AbortSignal.timeout(30_000),
    );
    expect(cool.verdict).toBe('normal');
    await expect(
      tplEvidence.runTemplate(inc, '_example/nope', {}, entity, Date.now(), AbortSignal.timeout(30_000)),
    ).rejects.toThrow(/没有查询模板/);
  });

  it('知识条目按组件类型选择，文本取指定语言，id 带包名', () => {
    const zh = tpl.knowledge(new Set(['example.web']), 'zh-CN');
    expect(zh).toEqual([
      {
        id: '_example/working-set-vs-rss',
        components: ['example.web'],
        text: expect.stringContaining('working set'),
        learned_from: ['https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/'],
        learned_at: '2026-01-01T00:00:00Z',
        source: 'human',
      },
    ]);
    expect(zh[0]!.text).toMatch(/kubelet 按 working set/);
    expect(tpl.knowledge(new Set(['example.web']), 'en')[0]!.text).toMatch(/^The kubelet evicts/);
    expect(tpl.knowledge(new Set(['other.type']), 'zh-CN')).toEqual([]);
  });
});
