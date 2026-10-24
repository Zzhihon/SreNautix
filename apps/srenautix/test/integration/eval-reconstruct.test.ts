import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValid, type EvalSnapshot, type TopologyEdge, type TopologyNode } from '@srenautix/contract';
import { DEFAULT_REVISION_LABELS } from '../../src/changes/kubernetes.js';
import { NOVELTY_CONFIG_DEFAULT } from '../../src/config/novelty.js';
import { ServerMetrics } from '../../src/metrics.js';
import { Catalog } from '../../src/proposals/catalog.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackEvidence, PackRules } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { summarizeAgreement } from '../../src/eval/agreement.js';
import { exportBundle, readBundle, readOnlyClient, writeBundle, type Bundle } from '../../src/eval/bundle.js';
import { discoveryCase, liveAgreement, liveStats } from '../../src/eval/discovery.js';
import type { Label } from '../../src/eval/labels.js';
import { loadRuntime } from '../../src/eval/phase2.js';
import {
  faultAlertIds,
  mainIncident,
  reconstructCase,
  ReconstructedQueryRunner,
  replay,
} from '../../src/eval/reconstruct.js';
import { checkPatch, scoreRemediation } from '../../src/eval/remediation.js';
import type { RunRecord } from '../../src/eval/score.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { exampleWithTemplate, PACKS } from '../support/packs.js';
import { startVictoria, type Victoria } from '../support/victoria.js';

/**
 * 重建评测（ADR 0110）在真实后端上：VictoriaMetrics 存告警与 kube-state-metrics 历史，PostgreSQL 是 server 的状态库
 * （拓扑事件由 server 的 TopologyStore 写入）。导出 → 重放 → 重建阶段 A 与研判输入 → 查询模板；
 * 自愈 PR 的补丁在真实的 git 仓库上检查。
 */
const REPO = resolve(import.meta.dirname, '../../../..');
const SCRATCH = join(REPO, '.scratch');
const CLUSTER = 'shop';
const MIN = 60_000;
// 数据放在三小时前，查询都在过去
const T0 = Math.floor(Date.now() / MIN) * MIN - 3 * 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

let vm: Victoria;
let db: TestDb;
let state: pg.Client;
let dir: string;
let bundle: Bundle;

const ALERT = 'alertname="KubeDeploymentRolloutStuck",deployment="api",namespace="shop",severity="critical"';

function series(name: string, labels: string, from: number, to: number, value: (t: number) => number): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += 30_000) {
    out.push(`${name}{${labels}} ${value(t)} ${t}`);
  }
  return out;
}

const label: Label = {
  id: 'shop-rollout',
  title: '发布后 api 停滞',
  type: 'incident',
  window: { from: iso(T0), to: iso(T0 + 60 * MIN) },
  as_of: iso(T0 + 30 * MIN),
  fault_alerts: [{ alertname: 'KubeDeploymentRolloutStuck', labels: { deployment: 'api' } }],
  roots: ['Deployment:shop/api', 'Application.argoproj.io:argocd/shop'],
  discovery_roots: [],
  revisions: [],
  granularity: 'workload',
  mechanism: null,
  disposition: 'act',
  required_members: [['Deployment:shop/api']],
  required_change_near: iso(T0 + 2 * MIN),
  legacy_case: null,
  legacy_roots: [],
  learned_from: [],
  fix: {
    class: 'release_rollback',
    repository: 'acme/gitops',
    commit: 'abcdef0',
    expect: [{ path: 'apps/shop/release.json', select: {}, pointer: '/data/image', value: 'registry/api@sha256:aaa' }],
  },
  noise: [],
  evidence: [{ kind: 'state', ref: 'test' }],
};

beforeAll(async () => {
  vm = await startVictoria();
  // 第一次触发：T0+5m 进入 pending、T0+7m 起 firing，到 T0+40m；第二次：T0+50m pending、T0+52m 起 firing 到结束
  const first = (t: number) => (t >= T0 + 5 * MIN && t <= T0 + 40 * MIN ? (T0 + 5 * MIN) / 1000 : NaN);
  const second = (t: number) => (t >= T0 + 50 * MIN ? (T0 + 50 * MIN) / 1000 : NaN);
  const lines = [
    ...series('ALERTS_FOR_STATE', ALERT, T0 + 5 * MIN, T0 + 40 * MIN, first),
    ...series('ALERTS_FOR_STATE', ALERT, T0 + 50 * MIN, T0 + 60 * MIN, second),
    ...series('ALERTS', `${ALERT},alertstate="firing"`, T0 + 7 * MIN, T0 + 40 * MIN, () => 1),
    ...series('ALERTS', `${ALERT},alertstate="firing"`, T0 + 52 * MIN, T0 + 60 * MIN, () => 1),
    // 只 pending、从没 firing 的告警不是实例
    ...series(
      'ALERTS_FOR_STATE',
      'alertname="KubePodNotReady",namespace="shop",pod="api-1",severity="warning"',
      T0 + 10 * MIN,
      T0 + 12 * MIN,
      () => (T0 + 10 * MIN) / 1000,
    ),
    ...series('kube_node_info', 'node="n1"', T0 - 25 * 60 * MIN, T0 + 60 * MIN, () => 1),
    ...series(
      'kube_pod_info',
      'namespace="shop",pod="api-1",node="n1",uid="u1"',
      T0 - 25 * 60 * MIN,
      T0 + 60 * MIN,
      () => 1,
    ),
    ...series(
      'kube_pod_owner',
      'namespace="shop",pod="api-1",owner_kind="ReplicaSet",owner_name="api-7f",owner_is_controller="true"',
      T0 - 25 * 60 * MIN,
      T0 + 60 * MIN,
      () => 1,
    ),
    ...series(
      'kube_replicaset_owner',
      'namespace="shop",replicaset="api-7f",owner_kind="Deployment",owner_name="api"',
      T0 - 25 * 60 * MIN,
      T0 + 60 * MIN,
      () => 1,
    ),
  ].filter((l) => !l.includes(' NaN '));
  for (let i = 0; i < lines.length; i += 5000) {
    await vm.importLines(lines.slice(i, i + 5000));
  }

  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const dep = (rev: string): TopologyNode => ({
    key: 'Deployment:shop/api',
    kind: 'Deployment',
    namespace: 'shop',
    name: 'api',
    uid: 'd1',
    labels: { 'app.kubernetes.io/version': rev },
    component_type: null,
    hub: false,
  });
  const app: TopologyNode = {
    key: 'Application.argoproj.io:argocd/shop',
    kind: 'Application.argoproj.io',
    namespace: 'argocd',
    name: 'shop',
    uid: 'a1',
    labels: {},
    component_type: null,
    hub: false,
  };
  const managed: TopologyEdge = {
    from: 'Deployment:shop/api',
    to: 'Application.argoproj.io:argocd/shop',
    relation: 'managed_by',
    provenance: 'structural',
    confidence: 1,
    scope: 'service',
    evidence: 'argocd.argoproj.io/instance',
  };
  const before = new Date(T0 - 24 * 60 * MIN);
  await topo.apply(CLUSTER, [
    { op: 'node_upsert', at: before, source: 'informer', node: app },
    { op: 'node_upsert', at: before, source: 'informer', node: dep('1.0.0') },
    { op: 'edge_upsert', at: before, source: 'informer', edge: managed },
    { op: 'node_upsert', at: new Date(T0 + 2 * MIN), source: 'informer', node: dep('1.1.0') },
  ]);
  await db.server.query(
    `INSERT INTO server.change_events (change_id, cluster_id, source, time, targets, body) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      'gitops:abc',
      CLUSTER,
      'gitops',
      new Date(T0 + MIN),
      ['Deployment:shop/api'],
      JSON.stringify({
        change_id: 'gitops:abc',
        source: 'gitops',
        kind: 'gitops_sync',
        refs: ['abc'],
        revision: 'abc',
        actor: null,
        time: iso(T0 + MIN),
        link: null,
        targets: ['Deployment:shop/api'],
        summary: 'bump api',
      }),
    ],
  );
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, 'eval-reconstruct-'));
  const pw = join(dir, 'pw');
  writeFileSync(pw, db.serverConfig.password);
  state = await readOnlyClient({
    host: db.serverConfig.host,
    port: db.serverConfig.port,
    database: db.serverConfig.database,
    user: db.serverConfig.user,
    password_file: pw,
    ssl_mode: 'disable',
  });
  bundle = await exportBundle(label, {
    clusterId: CLUSTER,
    metrics: { url: vm.url, bearerTokenFile: null },
    state,
    stateId: 'state',
  });
}, 180_000);

afterAll(async () => {
  await state?.end();
  await db?.close();
  await vm?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('导出重建包', () => {
  it('告警按 pending 开始时刻切成实例，只 pending 的不算；拓扑来自 kube-state-metrics 与状态库；变更来自状态库', () => {
    const inst = bundle.alerts.filter((a) => a.alertname === 'KubeDeploymentRolloutStuck');
    expect(inst.map((a) => [a.active_at, a.firing_from])).toEqual([
      [iso(T0 + 5 * MIN), iso(T0 + 7 * MIN)],
      [iso(T0 + 50 * MIN), iso(T0 + 52 * MIN)],
    ]);
    // 结束时刻的精度是一个步长：后端在最后一个原始样本之后还会返回一个步长内的点
    const end = Date.parse(inst[0]!.firing_to!);
    expect(end).toBeGreaterThanOrEqual(T0 + 40 * MIN + 30_000);
    expect(end).toBeLessThanOrEqual(T0 + 41 * MIN);
    expect(inst[1]!.firing_to).toBeNull();
    expect(bundle.alerts.some((a) => a.alertname === 'KubePodNotReady')).toBe(false);
    const ksm = bundle.topology.filter((r) => r.source === 'ksm_history').map((r) => r.key);
    expect(ksm).toEqual(
      expect.arrayContaining(['Pod:shop/api-1', 'Node:n1', 'ReplicaSet:shop/api-7f', 'Deployment:shop/api']),
    );
    expect(bundle.topology.filter((r) => r.source === 'informer').map((r) => r.key)).toEqual(
      expect.arrayContaining(['Deployment:shop/api', 'Application.argoproj.io:argocd/shop']),
    );
    expect(bundle.changes.map((c) => c.change_id)).toEqual(['gitops:abc']);
  });

  it('状态库会话只读', async () => {
    await expect(state.query("DELETE FROM server.change_events WHERE change_id = 'gitops:abc'")).rejects.toThrow(
      /read-only/,
    );
  });

  it('写入用例目录后原样读回', () => {
    writeBundle(dir, bundle);
    expect(readBundle(dir, label.id)).toEqual(bundle);
  });
});

describe('重放、重建阶段 A 与研判输入', () => {
  it('发现：一个事件，根因是发布的 Deployment，引用了推导出的发布', async () => {
    const rt = await loadRuntime({
      cluster_id: CLUSTER,
      metrics: { url: vm.url, dialect: 'metricsql' },
      packs: { dirs: [PACKS] },
      revision_labels: [],
      group_within_seconds: 120,
      step_seconds: 30,
      locale: 'zh-CN',
      evidence_concurrency: 4,
      query_timeout_seconds: 30,
      novelty: NOVELTY_CONFIG_DEFAULT,
    });
    const r = await replay(
      bundle,
      Date.parse(label.window.to),
      {
        rt,
        params: rt.rcaParams(),
        revisionLabels: [...DEFAULT_REVISION_LABELS],
        groupWithinMs: 120_000,
        stepMs: 30_000,
      },
      Date.parse(label.as_of),
    );
    const d = discoveryCase(r, label);
    expect(d.fault_alerts).toBe(2);
    expect(d.root_hit, String(d.main_root)).toBe(true);
    expect(d.change_found).toBe(true);
    expect(d.detection_latency_s).toBe(120);

    const main = mainIncident(r, faultAlertIds(r, label), 'captured');
    expect(main).not.toBeNull();
    const source = await EvidenceSource.create({
      id: 'vm',
      url: vm.url,
      dialect: 'metricsql',
      bearerTokenFile: null,
      timeoutMs: 30_000,
    });
    const metrics = new ServerMetrics('server', false);
    const asOf = Date.parse(label.as_of);
    const evidence = new PackEvidence(
      rt,
      source,
      async (_c, key) => r.topology.componentType(key, asOf),
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 30_000 },
      metrics,
    );
    const rc = await reconstructCase(
      r,
      label,
      main!.incident,
      '7a1b2c3d-0000-4000-8000-0000000000aa',
      'test',
      `sha256:${'0'.repeat(64)}`,
      {
        evidence,
        rules: new PackRules(rt, metrics),
        rt,
        catalog: Catalog.load(),
        locale: 'zh-CN',
        signal: AbortSignal.timeout(60_000),
      },
    );
    assertValid<EvalSnapshot>('schemas/eval-snapshot.schema.json', rc.snapshot);
    expect(rc.snapshot.source.kind).toBe('reconstructed');
    expect(rc.cards.total).toBeGreaterThan(0);
    expect(rc.snapshot.context.subgraph.nodes.map((n) => n.component)).toContain('Deployment:shop/api');
    // 处置推导的依据（ADR 0138）：内置包没有声明外部组件
    expect(rc.snapshot.context.disposition_facts?.external).toEqual([]);
    // 分析时刻第一次触发仍在继续：一条告警，链级有卡。主卡是 kps-conditions 的告警条件卡（ADR 0109），
    // 夹具里没有它读取的 kube_deployment_status_condition，所以无法判定
    expect(rc.agreement).toHaveLength(1);
    expect(rc.agreement[0]!.primary_card).toBe('kps-conditions/kube-deployment-rollout-stuck/condition');
    expect(rc.agreement[0]!.primary).toBe('undeterminable');
    expect(rc.agreement[0]!.chain).not.toBe('uncatalogued');

    // 查询模板：内置包没有模板，用带模板的 _example 副本；评估时刻不晚于 as_of，实体取拓扑中的 Deployment
    const tplRt = await PackRuntime.load({
      dirs: [exampleWithTemplate(join(dir, 'packs'))],
      only: ['_example'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
    });
    const tplEvidence = new PackEvidence(
      tplRt,
      source,
      async () => null,
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 30_000 },
      metrics,
    );
    const tpl = tplRt.templates.find((t) => t.id === '_example/memory-ratio')!;
    const card = await new ReconstructedQueryRunner(
      tplEvidence,
      rc.incident,
      r.topology,
      asOf,
      rc.snapshot.context.alerts,
    ).run(
      { id: tpl.id, description: tpl.description, args: tpl.args },
      { limit_ratio: 0.9 },
      {
        hypothesisId: 'h1',
        rootComponent: 'Deployment:shop/api',
        bounds: { from: T0, to: asOf },
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(card.card_id).toBe('_example/templates/memory-ratio');
    expect(card.entity).toMatchObject({ kind: 'Deployment', namespace: 'shop', name: 'api', uid: 'd1' });
    expect(Date.parse(card.window.to)).toBeLessThanOrEqual(asOf);
  }, 180_000);
});

describe('影子环境统计（只读）', () => {
  it('没有事件时各项为 0，不报错', async () => {
    const rt = await loadRuntime({
      cluster_id: CLUSTER,
      metrics: { url: vm.url, dialect: 'metricsql' },
      packs: { dirs: [PACKS] },
      revision_labels: [],
      group_within_seconds: 120,
      step_seconds: 30,
      locale: 'zh-CN',
      evidence_concurrency: 4,
      query_timeout_seconds: 30,
      novelty: NOVELTY_CONFIG_DEFAULT,
    });
    const s = await liveStats(state, CLUSTER, new Date(T0), new Date(T0 + 60 * MIN));
    expect(s.incidents).toBe(0);
    expect(s.with_cards).toEqual({ n: 0, d: 0 });
    expect(
      summarizeAgreement(await liveAgreement(state, rt, CLUSTER, new Date(T0), new Date(T0 + 60 * MIN))).primary
        .abnormal,
    ).toBe(0);
  });
});

describe('自愈 PR 的补丁检查', () => {
  it('git apply --check 与期望：正确、取值不对、补丁不能应用、误触发', () => {
    const repo = join(dir, 'gitops');
    mkdirSync(join(repo, 'apps/shop'), { recursive: true });
    const g = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_DATE: iso(T0 - MIN), GIT_COMMITTER_DATE: iso(T0 - MIN) },
      });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'eval@example.com');
    g('config', 'user.name', 'eval');
    const body = (image: string) =>
      `${JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', data: { image, release_id: 'r' } }, null, 2)}\n`;
    writeFileSync(join(repo, 'apps/shop/release.json'), body('registry/api@sha256:bbb'));
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    const base = g('rev-parse', 'HEAD').trim();
    const patch = (image: string) => {
      writeFileSync(join(repo, 'apps/shop/release.json'), body(image));
      const p = g('diff');
      g('checkout', '--', '.');
      return p;
    };
    const good = patch('registry/api@sha256:aaa');
    const wrong = patch('registry/api@sha256:ccc');
    const broken = good.replace('sha256:bbb', 'sha256:zzz');
    expect(checkPatch(repo, base, good, label.fix!.expect, dir)).toMatchObject({ applies: true, correct: true });
    expect(checkPatch(repo, base, wrong, label.fix!.expect, dir)).toMatchObject({ applies: true, correct: false });
    expect(checkPatch(repo, base, broken, label.fix!.expect, dir)).toMatchObject({ applies: false, correct: false });
    // 工作区与索引没有被改动
    expect(g('status', '--porcelain')).toBe('');

    const run = (caseId: string, i: number, p: string | null, level: RunRecord['level']): RunRecord => ({
      caseId,
      run: i,
      routeId: 'r',
      model: 'm',
      state: 'completed',
      structuredFailure: false,
      level,
      disposition: 'act',
      top: [],
      cost: 0,
      currency: 'USD',
      inputTokens: 0,
      outputTokens: 0,
      missRate: null,
      fingerprints: [],
      durationMs: 0,
      error: null,
      proposals:
        p === null
          ? []
          : [{ action_id: 'gitops_pr', params: { repository: 'acme/gitops', base: 'main', title: 't', patch: p } }],
    });
    const other: Label = { ...label, id: 'no-fix', fix: null };
    const labels = new Map<string, Label>([
      ['label:shop-rollout', label],
      ['label:no-fix', other],
    ]);
    const s = scoreRemediation(
      [
        run('label:shop-rollout', 0, good, 'likely'),
        run('label:shop-rollout', 1, wrong, 'evidence_consistent'),
        run('label:shop-rollout', 2, null, 'likely'),
        run('label:shop-rollout', 3, null, 'inconclusive'),
        run('label:no-fix', 0, good, 'likely'),
      ],
      (id) => labels.get(id) ?? null,
      repo,
      dir,
    );
    expect(s).toMatchObject({
      eligible_runs: 3,
      triggered_runs: 2,
      false_triggers: 1,
      patches: 3,
      applicable: 2,
      correct: 1,
    });
    // 模板匹配（ADR 0138）：标注类别的模板适用为触发；没有仓库修复的标注上适用的模板按类别记误触发；
    // 低于 likely 的运行不计
    const runs = [
      run('label:shop-rollout', 0, null, 'likely'),
      run('label:shop-rollout', 1, null, 'evidence_consistent'),
      run('label:shop-rollout', 2, null, 'likely'),
      run('label:shop-rollout', 3, null, 'inconclusive'),
      run('label:no-fix', 0, null, 'likely'),
    ];
    const t = scoreRemediation(
      runs,
      (id) => labels.get(id) ?? null,
      null,
      dir,
      (r) =>
        r.caseId === 'label:no-fix'
          ? [{ key: 'gitops/noisy-alert-relax', category: 'alert_rule' }]
          : r.run === 0
            ? [{ key: 'gitops/release-to-serving-version', category: 'release_rollback' }]
            : r.run === 1
              ? [{ key: 'gitops/memory-limit-raise', category: 'config_resource' }]
              : [],
    );
    expect(t).toMatchObject({
      eligible_runs: 3,
      triggered_runs: 0,
      template_triggered_runs: 1,
      template_any_runs: 2,
      template_false_triggers: { alert_rule: 1 },
    });
    expect(t.template_matches).toHaveLength(4);
  });
});
