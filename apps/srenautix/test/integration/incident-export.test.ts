import type {
  ExportedIncident,
  Incident,
  IncidentCategory,
  IncidentExport,
  IncidentExportRecord,
  LabelProfile,
  TopologyEdge,
  TopologyNode,
} from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import {
  LokiAdapter,
  PrometheusApiAdapter,
  startLoki,
  startPrometheus,
  type FixtureLogStream,
  type RunningProcess,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { runIncidentsExport } from '../../src/export/cli.js';
import { kubeEventsSource } from '../../src/export/kube-events.js';
import { DEFAULT_GROUPING, type KubeWarningsDeps } from '../../src/export/kube-warnings.js';
import { registerExportRoutes } from '../../src/export/routes.js';
import type { Auth } from '../../src/identity/auth.js';
import type { RoleBinding } from '../../src/identity/bindings.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore, type TopologyChange } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 批量导出（ADR 0186）经真实的 PostgreSQL、Loki 与 Prometheus：一次调用「最近 3 天、exclude_category=provider」，
// 同一告警的复发按系列汇成一项（发生次数、累计时长、同一个 issue），每个事件都有研判结论或无法判定的原因，
// node-a 的内存驱逐成为一个 node_memory_eviction 分组并列出关联告警；供应商类的事件不导出，读取作用域之外的事件不可见。

const CLUSTER = 'c1';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const T0 = NOW - 2 * 86_400_000;
const min = (m: number) => T0 + m * MIN;
const at = (m: number) => new Date(min(m)).toISOString();

const API = 'Deployment:shop/api';
const CONTROL = 'StatefulSet:shop/control';
const LLM = 'component:llm-provider';
const BATCH = 'Deployment:batch/report';
const HPA_SERIES = `${CONTROL}|KubeHpaMaxedOut`;
const id = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: TestDb;
let loki: RunningProcess;
let prom: TsdbInstance;
let store: TopologyStore;
let app: FastifyInstance;
/** 本测试的读取作用域：每个请求前设置 */
let scopes: RoleBinding[] | 'all' = 'all';

interface Seed {
  n: number;
  component: string;
  alertname: string;
  category: IncidentCategory;
  /** 成员告警的 [开始, 结束] 分钟；结束为 null 表示仍在触发 */
  spans: Array<[number, number | null]>;
  seriesKey?: string;
  reopened?: number;
}

async function seed(s: Seed): Promise<void> {
  const first = Math.min(...s.spans.map(([a]) => a));
  const ended = s.spans.every(([, b]) => b !== null) ? Math.max(...s.spans.map(([, b]) => b as number)) : null;
  const namespace =
    s.component.includes(':') && s.component.includes('/') ? s.component.split(':')[1]!.split('/')[0]! : null;
  const body = {
    incident_id: id(s.n),
    cluster_id: CLUSTER,
    label: `${s.component}:${at(first).slice(0, 15)}0:00Z~${s.n}`,
    incident_version: 1 + (s.reopened ?? 0),
    state: ended === null ? 'firing' : 'resolved',
    severity: 'warning',
    first_firing_at: at(first),
    ended_at: ended === null ? null : at(ended),
    root: {
      component: s.component,
      entity: namespace ? { cluster_id: CLUSTER, kind: 'Deployment', namespace, name: 'x', uid: null } : null,
      ambiguous: false,
      margin: null,
      silent_root: false,
    },
    candidates: [],
    members: s.spans.map(([a, b], i) => ({
      alert_id: `${String(s.n).padStart(8, '0')}${String(i).padStart(8, '0')}@${min(a) / 1000}`,
      alertname: s.alertname,
      role: 'symptom',
      component: s.component,
      severity: 'warning',
      category: s.category,
      status: b === null ? 'firing' : 'resolved',
      starts_at: at(a),
      ends_at: b === null ? null : at(b),
      joined_version: 1,
      left_version: null,
    })),
    components: [s.component],
    categories: [s.category],
    primary_category: s.category,
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 1,
    created_at: at(first),
    updated_at: at(first),
  } as unknown as Incident;
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at, root_component,
       body, categories, primary_category, series_key)
     VALUES ($1, $2, $3, $4, $5, 'warning', $6, $7, $8, $9, $10, $11, $12)`,
    [
      id(s.n),
      CLUSTER,
      body.label,
      body.incident_version,
      body.state,
      at(first),
      body.ended_at,
      s.component,
      JSON.stringify(body),
      [s.category],
      s.category,
      s.seriesKey ?? null,
    ],
  );
  for (let v = 1; v <= body.incident_version; v++) {
    await db.server.query(
      'INSERT INTO server.incident_versions (incident_id, version, body, reason) VALUES ($1, $2, $3, $4)',
      [id(s.n), v, JSON.stringify(body), v === 1 ? 'created' : 'reopened'],
    );
  }
}

async function stageA(n: number, disposition: string, cards: unknown[]): Promise<void> {
  await db.server.query(
    `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body,
       first_firing_at, rendered_at)
     SELECT gen_random_uuid(), incident_id, version, $2, 'sha256:0', false, $3, first_firing_at, first_firing_at + interval '1 minute'
       FROM server.incidents WHERE incident_id = $1`,
    [id(n), disposition, JSON.stringify({ disposition_reason: 'default', cards })],
  );
}

async function research(n: number, disposition: string, level: string, output: Record<string, unknown>): Promise<void> {
  await db.server.query(
    `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, disposition, conclusion_level, summary,
       output, started_at, finished_at)
     SELECT gen_random_uuid(), incident_id, version, 'new_incident', 'completed', $2, $3, '研判摘要', $4,
       first_firing_at + interval '2 minutes', first_firing_at + interval '4 minutes'
       FROM server.incidents WHERE incident_id = $1`,
    [id(n), disposition, level, JSON.stringify(output)],
  );
}

async function issue(n: number, reusedFrom: number | null): Promise<void> {
  await db.server.query(
    `INSERT INTO server.github_issues (incident_id, repo, state, reason, number, url, opened_at, reused_from)
     VALUES ($1, 'acme/ops', 'open', 'escalate', 7, 'https://github.com/acme/ops/issues/7', now(), $2)`,
    [id(n), reusedFrom === null ? null : id(reusedFrom)],
  );
}

const EVICTED = 'The node was low on resource: memory. Threshold quantity: 100Mi, available: 80Mi.';

function alloy(m: number, kind: string, name: string, reason: string, host: string, msg: string) {
  return {
    t: min(m),
    line: JSON.stringify({ name, kind, objectAPIversion: 'v1', reason, type: 'Warning', sourcehost: host, msg }),
  };
}

function logStreams(): FixtureLogStream[] {
  const job = 'loki.source.kubernetes_events';
  return [
    {
      labels: { job, type: 'Warning' },
      lines: [alloy(9.5, 'Node', 'node-a', 'EvictionThresholdMet', 'node-a', 'Attempting to reclaim memory')],
    },
    {
      labels: { job, namespace: 'shop', type: 'Warning' },
      lines: [
        alloy(11.5, 'Pod', 'api-1', 'Evicted', 'node-a', EVICTED),
        alloy(11.6, 'Pod', 'control-0', 'Evicted', 'node-a', EVICTED),
      ],
    },
  ];
}

const tnode = (kind: string, namespace: string | null, name: string): TopologyNode => ({
  key: namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`,
  kind,
  namespace,
  name,
  uid: `uid-${name}`,
  labels: {},
  component_type: null,
  hub: false,
});
const tedge = (from: string, relation: string, to: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: relation === 'runs_on' ? 'instance' : 'service',
  evidence: 'test',
});

function topology(): Array<{ at: number; changes: Array<Omit<TopologyChange, 'at' | 'source'>> }> {
  return [
    {
      at: -600,
      changes: [
        { op: 'node_upsert', node: tnode('Node', null, 'node-a') },
        { op: 'node_upsert', node: tnode('Deployment', 'shop', 'api') },
        { op: 'node_upsert', node: tnode('StatefulSet', 'shop', 'control') },
        { op: 'node_upsert', node: tnode('Pod', 'shop', 'api-1') },
        { op: 'edge_upsert', edge: tedge('Pod:shop/api-1', 'owned_by', API) },
        { op: 'edge_upsert', edge: tedge('Pod:shop/api-1', 'runs_on', 'Node:node-a') },
        { op: 'node_upsert', node: tnode('Pod', 'shop', 'control-0') },
        { op: 'edge_upsert', edge: tedge('Pod:shop/control-0', 'owned_by', CONTROL) },
        { op: 'edge_upsert', edge: tedge('Pod:shop/control-0', 'runs_on', 'Node:node-a') },
      ],
    },
    {
      at: 12,
      changes: [
        { op: 'edge_delete', edge: tedge('Pod:shop/api-1', 'runs_on', 'Node:node-a') },
        { op: 'edge_delete', edge: tedge('Pod:shop/control-0', 'runs_on', 'Node:node-a') },
      ],
    },
  ];
}

const profile: LabelProfile = {
  namespace: 'namespace',
  pod: 'pod',
  container: 'container',
  node: 'node',
  cluster: null,
  scrape_interval_seconds: 30,
  tenant: null,
};

function kubeWarnings(): KubeWarningsDeps {
  return {
    events: {
      adapter: new LokiAdapter({
        id: 'loki',
        url: loki.url,
        labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
      }),
      source: kubeEventsSource(
        { format: 'alloy_json', fields: {}, reasons: ['Evicted', 'EvictionThresholdMet', 'FailedScheduling'] },
        null,
      ),
      maxSeries: 5000,
      timeoutMs: 30_000,
    },
    metrics: {
      adapter: new PrometheusApiAdapter({ id: 'prometheus', url: prom.url, dialects: ['promql'] }),
      dialect: 'promql',
      profile,
      maxSeries: 5000,
      timeoutMs: 30_000,
    },
    placements: store,
    grouping: DEFAULT_GROUPING,
    now: () => NOW,
  };
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  store = new TopologyStore(db.server);
  for (const step of topology()) {
    await store.apply(
      CLUSTER,
      step.changes.map((c) => ({ ...c, at: new Date(min(step.at)), source: 'informer' as const })),
    );
  }
  loki = await startLoki(logStreams());
  prom = await startPrometheus([
    {
      labels: { __name__: 'kube_pod_info', namespace: 'shop', pod: 'api-1', node: 'node-a' },
      points: Array.from({ length: 61 }, (_, i) => ({ t: min(i), v: 1 })),
    },
  ]);

  // control 的 HPA 到顶：同一系列的三个事件（第二个重开过一次），复用同一个 issue
  await seed({
    n: 1,
    component: CONTROL,
    alertname: 'KubeHpaMaxedOut',
    category: 'performance',
    spans: [[14, 50]],
    seriesKey: HPA_SERIES,
  });
  await seed({
    n: 2,
    component: CONTROL,
    alertname: 'KubeHpaMaxedOut',
    category: 'performance',
    spans: [
      [600, 640],
      [700, 720],
    ],
    seriesKey: HPA_SERIES,
    reopened: 1,
  });
  await seed({
    n: 3,
    component: CONTROL,
    alertname: 'KubeHpaMaxedOut',
    category: 'performance',
    spans: [[1500, null]],
    seriesKey: HPA_SERIES,
  });
  // api 的 5xx 与错误预算燃烧
  await seed({ n: 4, component: API, alertname: 'ApiHigh5xxRate', category: 'availability', spans: [[11, 40]] });
  await seed({
    n: 5,
    component: API,
    alertname: 'ApiErrorBudgetBurnFast',
    category: 'availability',
    spans: [[30, 90]],
  });
  // 供应商类：被 exclude_category=provider 去掉
  await seed({ n: 6, component: LLM, alertname: 'UpstreamModelErrors', category: 'provider', spans: [[20, 60]] });
  // 读取作用域之外的命名空间
  await seed({ n: 7, component: BATCH, alertname: 'ReportJobFailed', category: 'availability', spans: [[100, 110]] });
  // 4 天前结束：在导出时间窗之外
  await seed({
    n: 8,
    component: API,
    alertname: 'ApiLatencyHigh',
    category: 'performance',
    spans: [[-4 * 1440, -4 * 1440 + 30]],
  });

  await research(1, 'act', 'likely', { stop_reason: 'leader_supported', conclusion: { undetermined_reason: null } });
  await research(5, 'escalate', 'undetermined', {
    stop_reason: 'step_limit',
    conclusion: { undetermined_reason: '错误预算的查询没有返回样本' },
  });
  await stageA(2, 'escalate', []);
  await stageA(4, 'escalate', [
    {
      ref: 'card:1',
      card_id: 'kubernetes/workload/http-errors',
      title: { 'zh-CN': '5xx 比例' },
      verdict: 'abnormal',
      reason: { kind: 'rule', text: '5xx 比例超过阈值。' },
      value: '12%',
    },
    {
      ref: 'card:2',
      card_id: 'kubernetes/workload/restarts',
      title: { 'zh-CN': '重启次数' },
      verdict: 'normal',
      reason: { kind: 'all_clear', text: '没有命中任何规则。' },
      value: '0',
    },
  ]);
  // 事件 3 没有阶段 A 报告：终态记录说明原因
  await db.server.query(
    `INSERT INTO server.incident_reasons (incident_id, incident_version, stage, code, detail) VALUES ($1, 1, 'stage_a', 'stage_a_missing', '超时')`,
    [id(3)],
  );
  await issue(1, null);
  await issue(2, 1);
  await issue(3, 1);

  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerExportRoutes(app, {
    pool: db.server,
    auth: { reader: async () => ({ scopes }) } as unknown as Auth,
    kubeWarnings: async () => kubeWarnings(),
    now: () => NOW,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await loki?.stop();
  await prom?.stop();
  await db?.close();
});

const window3d = `from=${new Date(NOW - 3 * 86_400_000).toISOString()}&to=${new Date(NOW).toISOString()}`;

async function get(query: string) {
  return app.inject({ method: 'GET', url: `/v1/incidents/export?${window3d}${query}` });
}

describe('GET /v1/incidents/export（ADR 0186）', () => {
  it('最近 3 天、exclude_category=provider：同一告警按系列合并，每个事件都有结论或无法判定的原因，节点内存驱逐成组', async () => {
    scopes = 'all';
    const r = await get('&exclude_category=provider&group=series');
    expect(r.statusCode).toBe(200);
    const x = r.json() as IncidentExport;
    expect(() => assertValid('schemas/incident-export.schema.json', x)).not.toThrow();
    const ids = x.incidents.map((i) => i.incident_id);
    expect(ids).toEqual([id(3), id(2), id(7), id(5), id(1), id(4)]);
    expect(ids).not.toContain(id(6));
    expect(ids).not.toContain(id(8));

    const hpa = x.series!.find((s) => s.key === HPA_SERIES)!;
    expect(hpa).toMatchObject({
      key_source: 'series_key',
      occurrences: 4,
      incident_ids: [id(3), id(2), id(1)],
      ended_at: null,
    });
    expect(hpa.issues).toEqual([
      { repo: 'acme/ops', number: 7, url: 'https://github.com/acme/ops/issues/7', state: 'open', reused: false },
    ]);
    const byId = new Map(x.incidents.map((i) => [i.incident_id, i] as [string, ExportedIncident]));
    expect(byId.get(id(2))).toMatchObject({ reopened_count: 1, occurrences: 2, firing_seconds: 60 * 60 });

    for (const i of x.incidents) {
      const c = i.conclusion;
      expect(c.disposition !== null && c.disposition !== 'undetermined' && c.conclusion_level !== 'undetermined').toBe(
        c.undetermined === null,
      );
    }
    expect(byId.get(id(5))!.conclusion.undetermined).toEqual({
      codes: [expect.objectContaining({ stage: 'research', code: 'step_limit' })],
      undetermined_reason: '错误预算的查询没有返回样本',
    });
    expect(byId.get(id(3))!.conclusion).toMatchObject({ source: 'none' });
    expect(byId.get(id(3))!.conclusion.undetermined!.codes).toEqual([
      expect.objectContaining({ stage: 'stage_a', code: 'stage_a_missing', detail: '超时' }),
    ]);
    expect(byId.get(id(4))!.evidence.map((e) => [e.ref, e.summary])).toEqual([['card:1', '12%：5xx 比例超过阈值。']]);

    const k = x.kube_warnings.find((w) => w.cluster_id === CLUSTER)!;
    expect(k.queries.map((q) => [q.name, q.status])).toEqual([
      ['events', 'ok'],
      ['oom_killed', 'ok'],
    ]);
    expect(k.groups).toHaveLength(1);
    const g = k.groups[0]!;
    expect(g.kind).toBe('node_memory_eviction');
    expect(g.suspected).toBe(true);
    expect(g.incidents.map((i) => i.incident_id).sort()).toEqual([id(1), id(4), id(5)].sort());
    expect(g.alertnames).toEqual(['ApiErrorBudgetBurnFast', 'ApiHigh5xxRate', 'KubeHpaMaxedOut']);
    expect(x.grouping).toEqual({ gap_seconds: 1800, before_seconds: 1800, after_seconds: 1800, min_incidents: 2 });
  }, 60_000);

  it('读取作用域之外的事件不导出；分组参数由查询参数覆盖并写进结果', async () => {
    scopes = [
      {
        subject: { kind: 'user', name: 'alice' },
        role: 'viewer',
        scope: { clusters: ['*'], namespaces: ['shop'], component_labels: {} },
      },
    ] as RoleBinding[];
    const r = await get('&exclude_category=provider&group_min_incidents=4');
    const x = r.json() as IncidentExport;
    expect(x.incidents.map((i) => i.incident_id)).not.toContain(id(7));
    expect(x.grouping.min_incidents).toBe(4);
    expect(x.kube_warnings[0]!.groups).toEqual([]);
    scopes = 'all';
  }, 60_000);

  it('limit 与 next_cursor：分页导出全部事件，不重复也不遗漏', async () => {
    scopes = 'all';
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await get(`&exclude_category=provider&limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      const x = r.json() as IncidentExport;
      seen.push(...x.incidents.map((y) => y.incident_id));
      expect(x.truncated).toBe(x.next_cursor !== null);
      cursor = x.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([id(3), id(2), id(7), id(5), id(1), id(4)]);
  }, 60_000);

  it('ndjson 逐行符合 IncidentExportRecord；md 依次给出分组、系列与明细', async () => {
    scopes = 'all';
    const nd = await get('&exclude_category=provider&format=ndjson');
    expect(nd.headers['content-type']).toMatch(/application\/x-ndjson/);
    const lines = nd.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as IncidentExportRecord);
    for (const l of lines) {
      expect(() => assertValid('schemas/incident-export.schema.json#/$defs/Record', l)).not.toThrow();
    }
    expect(lines[0]!.type).toBe('header');
    expect(lines.at(-1)).toMatchObject({ type: 'end', incidents: 6, truncated: false });

    const md = await get('&exclude_category=provider&format=md');
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    const i = ['## 疑似同一根因', '## 按系列汇总', '## 事件明细'].map((h) => md.body.indexOf(h));
    expect(i[0]).toBeGreaterThan(0);
    expect(i[1]).toBeGreaterThan(i[0]!);
    expect(i[2]).toBeGreaterThan(i[1]!);
    expect(md.body).toContain('节点内存驱逐');
  }, 60_000);

  it('命令行 incidents export 经 HTTP 调用导出接口，结果写到输出；中心返回错误时以中心的说明报错', async () => {
    scopes = 'all';
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const dir = resolve(import.meta.dirname, '../../../../.scratch', `export-cli-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'export-token-0123456789abcdef\n');
    try {
      const chunks: Buffer[] = [];
      const out = new Writable({
        write(chunk: Buffer, _enc, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
      const args = [`--hub-url=${url}`, `--token-file=${tokenFile}`, '--from=3d', '--exclude-category=provider'];
      await runIncidentsExport([...args, '--format=ndjson', '--group=series'], out, {});
      const lines = Buffer.concat(chunks)
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as IncidentExportRecord);
      expect(lines.filter((l) => l.type === 'incident')).toHaveLength(6);
      expect(lines.some((l) => l.type === 'series')).toBe(true);
      await expect(runIncidentsExport([...args, '--exclude-category=unclassified'], out, {})).rejects.toThrow(
        /HTTP 400：unclassified 不能被排除/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('研判失败的事件：队列 done 行的 skip_reason 是终态 failed，不当作原因码；原因取研判的失败类型', async () => {
    scopes = 'all';
    await db.server.query(
      `WITH run AS (
         INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, error, started_at, finished_at)
         SELECT gen_random_uuid(), incident_id, version, 'new_incident', 'failed', $2, first_firing_at + interval '5 minutes',
           first_firing_at + interval '6 minutes'
           FROM server.incidents WHERE incident_id = $1
         RETURNING run_id, incident_id, incident_version)
       INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state, skip_reason, finished_at)
       SELECT run_id, incident_id, incident_version, 'new_incident', 'warning', true, 'done', 'failed', now() FROM run`,
      [id(7), JSON.stringify({ kind: 'internal', message: '模型输出无法解析' })],
    );
    const r = await get('&exclude_category=provider');
    expect(r.statusCode).toBe(200);
    const inc = (r.json() as IncidentExport).incidents.find((i) => i.incident_id === id(7))!;
    const codes = inc.conclusion.undetermined?.codes ?? [];
    expect(codes.map((c) => c.code)).not.toContain('failed');
    expect(codes).toContainEqual(
      expect.objectContaining({ stage: 'research', code: 'internal', detail: '模型输出无法解析' }),
    );
  });

  it('参数不合法时 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/incidents/export' })).statusCode).toBe(400);
    expect((await get('&exclude_category=unclassified')).statusCode).toBe(400);
    const far = `from=${new Date(NOW - 40 * 86_400_000).toISOString()}&to=${new Date(NOW).toISOString()}`;
    expect((await app.inject({ method: 'GET', url: `/v1/incidents/export?${far}` })).statusCode).toBe(400);
  });
});
