import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

// 按旧版 Ops-Agent 回放种子格式（cchp-srenautix-seed v1，见种子目录 FORMAT.md）写一份合成的种子目录：
// 两个事件单元（db 磁盘写满，有知识条目给出根因；api 发布后报错，没有标准答案），
// 每个单元有证据卡与调用，另有日志块、原始序列、快照行与 catalog.json。数据全部是虚构的。

export const T = Date.parse('2026-09-10T08:03:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function jsonl(dir: string, file: string, records: unknown[]): void {
  const header = {
    type: 'header',
    format: 'cchp-srenautix-seed',
    version: 1,
    file,
    description: 'synthetic',
    created_at: iso(T),
  };
  const text = [header, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, file), zstdCompressSync(Buffer.from(text)));
}

function alert(id: string, alertname: string, component: string, role: string, activeAt: number) {
  return {
    id,
    alertname,
    component,
    role,
    severity: 'critical',
    status: 'resolved',
    activeAt,
    firedAt: activeAt + MIN,
    endedAt: activeAt + 40 * MIN,
    summary: `${alertname} on ${component}`,
    labels: {},
    entityKind: '',
    entity: '',
    chain: '',
    layer: '',
    pair: '',
    dashboardUid: '',
    dashboardPanel: '',
    description: '',
    runbookUrl: '',
  };
}

function windows(a: number, e: number) {
  return {
    W: { from: iso(a - 120 * MIN), to: iso(e) },
    R: { from: iso(a - 30 * MIN), to: iso(e) },
    A: { from: iso(a), to: iso(e) },
    B: { from: iso(a - 10 * MIN), to: iso(a) },
    N: { from: iso(e - 30 * MIN), to: iso(e) },
    Q: { from: iso(e - 15 * MIN), to: iso(e) },
  };
}

export function writeSeedFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const a1 = T;
  const e1 = T + 40 * MIN;
  const dbKey = `db:${iso(Math.floor(a1 / (10 * MIN)) * 10 * MIN).replace('.000Z', 'Z')}`;
  const a2 = T + 3 * 3600_000;
  const e2 = a2 + 30 * MIN;
  const apiKey = `api:${iso(Math.floor(a2 / (10 * MIN)) * 10 * MIN).replace('.000Z', 'Z')}`;
  const dbAlert = alert('alertname="DiskFull",component="db"@1', 'DiskFull', 'db', 'cause', a1);
  const apiAlert = alert('alertname="ApiErrors",component="api"@1', 'ApiErrors', 'api', 'symptom', a1 + 4 * MIN);
  const units = [
    {
      type: 'unit',
      unit: dbKey,
      origin: 'research',
      incident_key: dbKey,
      case_ids: ['2026-09-10-db-disk-full'],
      snapshot_ids: ['00000000-0000-4000-8000-00000000aa01'],
      first_firing_at: iso(a1),
      end_at: iso(e1),
      windows: windows(a1, e1),
      incident: {
        key: dbKey,
        root: 'db',
        rootAlert: dbAlert,
        severity: 'critical',
        state: 'resolved',
        firstFiring: a1,
        endedAt: e1,
        alerts: [dbAlert, apiAlert],
        components: ['db', 'api'],
        changes: [
          {
            time: a1 - 20 * MIN,
            kind: 'release',
            components: ['web'],
            title: 'release web',
            detail: 'web 1.2.3',
            tone: 'info',
          },
        ],
        chain: 'db-disk',
        silenced: false,
        inhibited: 0,
      },
      incident_load: { incidents: 1, alerts: 2 },
      neighborhood: {
        basis: 'incident_components',
        seeds: ['db', 'api'],
        hops: 2,
        components: [
          { id: 'db', hops: 0, chains: ['db-disk'] },
          { id: 'api', hops: 1, chains: ['runtime'] },
          { id: 'node', hops: 1, chains: ['platform'] },
          { id: 'web', hops: 2, chains: ['runtime'] },
        ],
      },
      scopes: [],
      cards: [
        {
          scope: `db-disk@${dbAlert.id}`,
          card: 'db-disk.1',
          title: '数据卷用量',
          verdict: 'abnormal',
          value: '99%',
          reason: '用量 99%',
          calls: [`${dbKey}#2`],
        },
        {
          scope: `runtime@${apiAlert.id}`,
          card: 'runtime.1',
          title: 'api 错误率',
          verdict: 'abnormal',
          value: '30%',
          reason: '错误率 30%',
          calls: [`${dbKey}#3`],
        },
        {
          scope: 'runtime@component:web',
          card: 'runtime.1',
          title: 'web 错误率',
          verdict: 'ok',
          value: '0.1%',
          reason: '正常',
          calls: [],
        },
        {
          scope: 'platform@component:node',
          card: 'check.node_disk',
          title: '节点磁盘',
          verdict: 'undeterminable',
          value: null,
          reason: '无样本',
          calls: [],
        },
      ],
      trace_ids: [],
      log_groups: ['db'],
      log_window: { from: iso(a1 - 120 * MIN), to: iso(e1) },
      calls: { total: 4 },
      unavailable: [],
      exported_at: iso(T + 86400_000),
    },
    {
      type: 'unit',
      unit: apiKey,
      origin: 'research',
      incident_key: apiKey,
      case_ids: [],
      snapshot_ids: ['00000000-0000-4000-8000-00000000aa02'],
      first_firing_at: iso(a2),
      end_at: iso(e2),
      windows: windows(a2, e2),
      incident: {
        key: apiKey,
        root: 'api',
        severity: 'warning',
        state: 'resolved',
        firstFiring: a2,
        endedAt: e2,
        alerts: [{ ...apiAlert, id: 'alertname="ApiErrors",component="api"@2', activeAt: a2, severity: 'warning' }],
        components: ['api'],
        changes: [],
        chain: 'runtime',
        silenced: false,
        inhibited: 0,
      },
      neighborhood: {
        basis: 'incident_components',
        seeds: ['api'],
        hops: 2,
        components: [
          { id: 'api', hops: 0, chains: ['runtime'] },
          { id: 'db', hops: 1, chains: ['db-disk'] },
        ],
      },
      scopes: [],
      cards: [
        {
          scope: 'runtime@alertname="ApiErrors",component="api"@2',
          card: 'runtime.1',
          title: 'api 错误率',
          verdict: 'abnormal',
          value: '12%',
          reason: '错误率 12%',
          calls: [],
        },
      ],
      trace_ids: [],
      log_groups: [],
      log_window: { from: iso(a2 - 120 * MIN), to: iso(e2) },
      calls: { total: 1 },
      unavailable: [],
      exported_at: iso(T + 86400_000),
    },
    {
      type: 'case',
      case_id: '2026-09-10-db-disk-full',
      knowledge: {
        id: '2026-09-10-db-disk-full',
        title: 'db 数据卷写满',
        root_component: 'db',
        components: ['db', 'api'],
        mechanism: 'WAL 堆积写满数据卷',
        misjudgement_hints: [],
      },
      window: { from: iso(a1), to: iso(e1), open_ended: false },
      picked_incident_key: dbKey,
      load_error: null,
      unit: dbKey,
      basis: 'incident',
    },
    {
      type: 'unit',
      unit: 'case:2026-08-01-old',
      origin: 'knowledge',
      incident_key: 'case:2026-08-01-old',
      case_ids: ['2026-08-01-old'],
      snapshot_ids: [],
      first_firing_at: iso(T - 40 * 86400_000),
      end_at: iso(T - 40 * 86400_000 + 3600_000),
      windows: windows(T - 40 * 86400_000, T - 40 * 86400_000 + 3600_000),
      incident: {
        key: 'case:2026-08-01-old',
        root: '',
        severity: 'warning',
        state: 'resolved',
        firstFiring: T - 40 * 86400_000,
        alerts: [],
        components: [],
        changes: [],
        chain: '',
      },
      neighborhood: { basis: 'knowledge', seeds: ['db'], hops: 2, components: [] },
      scopes: [],
      cards: [],
      trace_ids: [],
      log_groups: [],
      log_window: { from: iso(T - 40 * 86400_000), to: iso(T - 40 * 86400_000 + 3600_000) },
      calls: { total: 0 },
      unavailable: [],
      exported_at: iso(T + 86400_000),
    },
  ];
  const step = 60;
  const times = Array.from({ length: 41 }, (_, i) => a1 - 30 * MIN + i * step * 1000);
  const calls = [
    {
      type: 'call',
      unit: dbKey,
      id: `${dbKey}#1`,
      op: 'vmalert_rules',
      backend: 'vmalert',
      request: {},
      purposes: ['incident_load'],
      refs: [],
      status: 'ok',
      error: null,
      http_status: null,
      duration_ms: 1,
      fetched_at: iso(T),
      result: [],
    },
    {
      type: 'call',
      unit: dbKey,
      id: `${dbKey}#2`,
      op: 'prom',
      backend: 'vm',
      request: {
        expr: 'volume_used_ratio{pvc="data-db-0"}',
        query: 'volume_used_ratio{pvc="data-db-0"}',
        range: true,
        window: { from: a1 - 30 * MIN, to: e1 },
        start: (a1 - 30 * MIN) / 1000,
        end: e1 / 1000,
        step,
      },
      purposes: ['cards'],
      refs: ['db-disk/db-disk.1.A'],
      status: 'ok',
      error: null,
      http_status: null,
      duration_ms: 5,
      fetched_at: iso(T),
      result: [{ labels: { pvc: 'data-db-0' }, times, values: times.map((_, i) => 0.8 + i * 0.005) }],
    },
    {
      type: 'call',
      unit: dbKey,
      id: `${dbKey}#3`,
      op: 'prom',
      backend: 'vm',
      request: {
        expr: 'http_error_ratio{app="api"}',
        query: 'http_error_ratio{app="api"}',
        range: false,
        window: { from: a1, to: e1 },
        time: e1 / 1000,
      },
      purposes: ['cards'],
      refs: [],
      status: 'error',
      error: 'HTTP 503',
      http_status: 503,
      duration_ms: 5,
      fetched_at: iso(T),
      result: null,
    },
    {
      type: 'call',
      unit: dbKey,
      id: `${dbKey}#4`,
      op: 'loki_lines',
      backend: 'loki',
      request: {
        expr: '{app="db"} |= "FATAL"',
        query: '{app="db"} |= "FATAL"',
        window: { from: a1 - 30 * MIN, to: e1 },
        limit: 50,
      },
      purposes: ['cards'],
      refs: [],
      status: 'ok',
      error: null,
      http_status: null,
      duration_ms: 5,
      fetched_at: iso(T),
      result: {
        streams: [{ app: 'db' }],
        lines: [[0, a1 + MIN, 'FATAL: could not write to file: No space left on device']],
      },
    },
    {
      type: 'call',
      unit: apiKey,
      id: `${apiKey}#1`,
      op: 'tempo_search',
      backend: 'tempo',
      request: { q: '{ status = error }', start: a2 / 1000, end: e2 / 1000, limit: 20, window: { from: a2, to: e2 } },
      purposes: ['traces'],
      refs: [],
      status: 'ok',
      error: null,
      http_status: null,
      duration_ms: 5,
      fetched_at: iso(T),
      result: [{ traceId: 'abc', rootService: 'api', rootName: 'GET /', start: a2, durationMs: 120, attributes: {} }],
    },
  ];
  const chunkStart = Math.floor((a1 - 120 * MIN) / (6 * 3600_000)) * 6 * 3600_000;
  const logUnit = `logs:db:${iso(chunkStart)}`;
  const logs = [
    {
      type: 'log_chunk',
      unit: logUnit,
      group: 'db',
      selector: '{app="db"}',
      filter: null,
      query: '{app="db"}',
      from: iso(chunkStart),
      to: iso(chunkStart + 6 * 3600_000),
      lines: 3,
      complete: true,
      leaves: [
        {
          from: iso(chunkStart),
          to: iso(chunkStart + 6 * 3600_000),
          call: `${logUnit}#1`,
          lines: 3,
          complete: true,
          error: null,
        },
      ],
      requests: 1,
    },
    {
      type: 'call',
      unit: logUnit,
      id: `${logUnit}#1`,
      op: 'loki_lines',
      backend: 'loki',
      request: { query: '{app="db"}', window: { from: chunkStart, to: chunkStart + 6 * 3600_000 }, limit: 5000 },
      purposes: ['logs:db'],
      refs: [],
      status: 'ok',
      error: null,
      http_status: null,
      duration_ms: 5,
      fetched_at: iso(T),
      result: {
        streams: [{ app: 'db', pod: 'db-0' }],
        lines: [
          [0, a1 + 2 * MIN, 'PANIC: could not write to file "pg_wal/xlogtemp": No space left on device'],
          [0, a1 - 10 * MIN, 'checkpoint starting: wal'],
          [0, chunkStart + 1000, 'outside the unit window'],
        ],
      },
    },
  ];
  const rawStart = Math.floor((a1 - 120 * MIN) / 1000 / 300) * 300;
  const raw = [
    {
      type: 'raw_selector',
      id: 's1',
      selector: 'volume_used_ratio',
      units: [dbKey],
      series_count: 1,
      status: 'exported',
      error: null,
      step_seconds: 300,
      query: 'rollup((volume_used_ratio)[300s]) keep_metric_names',
    },
    {
      type: 'raw_chunk',
      selector_id: 's1',
      from: iso(rawStart * 1000),
      to: iso(rawStart * 1000 + 6 * 3600_000),
      start: rawStart,
      step: 300,
      points: 72,
      status: 'ok',
      error: null,
      series: [
        {
          labels: { __name__: 'volume_used_ratio', pvc: 'data-db-0' },
          min: Array(72).fill(0.5),
          max: Array(72).fill(0.9),
          avg: Array.from({ length: 72 }, (_, i) => 0.5 + i * 0.005),
        },
      ],
    },
    {
      type: 'raw_selector',
      id: 's2',
      selector: 'too_many',
      units: [dbKey],
      series_count: 900,
      status: 'too_many_series',
      error: null,
      step_seconds: 300,
      query: '',
    },
  ];
  const snapshots = [
    {
      type: 'snapshot',
      row: {
        snapshot_id: '00000000-0000-4000-8000-00000000aa01',
        kind: 'research',
        incident_key: dbKey,
        ground_truth: null,
      },
    },
    {
      type: 'snapshot',
      row: {
        snapshot_id: '00000000-0000-4000-8000-00000000aa02',
        kind: 'research',
        incident_key: apiKey,
        ground_truth: null,
      },
    },
  ];
  jsonl(dir, 'units.jsonl.zst', units);
  jsonl(dir, 'calls.jsonl.zst', calls);
  jsonl(dir, 'logs.jsonl.zst', logs);
  jsonl(dir, 'raw.jsonl.zst', raw);
  jsonl(dir, 'snapshots.jsonl.zst', snapshots);
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      format: 'cchp-srenautix-seed',
      version: 1,
      topology: {
        type: 'topology_static',
        components: [],
        edges: [
          { caller: 'api', callee: 'db' },
          { caller: 'web', callee: 'api' },
          { caller: 'db', callee: 'node' },
        ],
      },
      knowledge_cases: [
        {
          id: '2026-09-10-db-disk-full',
          title: 'db 数据卷写满',
          root_component: 'db',
          components: ['db', 'api'],
          mechanism: 'WAL 堆积写满数据卷',
          misjudgement_hints: ['不要把 api 错误当作根因'],
          effective_window: { from: iso(a1), to: iso(e1) },
        },
        {
          id: '2026-08-01-old',
          title: '更早的 api 故障',
          root_component: 'api',
          components: ['api'],
          mechanism: '连接池耗尽',
          misjudgement_hints: [],
          effective_window: { from: iso(T - 40 * 86400_000), to: iso(T - 40 * 86400_000 + 3600_000) },
        },
      ],
    }),
  );
}
