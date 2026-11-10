import type { EvidenceResult, Incident, IncidentExport, IncidentExportRecord } from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/kernel/errors.js';
import {
  assembleExport,
  conclusionOf,
  evidenceOf,
  exportedIncident,
  parseExportQuery,
  seriesOf,
  warningInputs,
  warningWindow,
  type ExportRequest,
  type Facts,
} from '../../src/export/incidents.js';
import { buildKubeWarningReport, DEFAULT_GROUPING, type Placement } from '../../src/export/kube-warnings.js';
import type { Observation } from '../../src/export/kube-events.js';
import { exportMarkdown, exportRecords, humanDuration, mdText } from '../../src/export/render.js';
import type { IncidentRow } from '../../src/incident/read.js';

// 批量导出（ADR 0186）的参数解析、每个事件的内容、按系列汇总与三种输出形式。场景：node-a 内存不足驱逐 api 与 control
// 的 Pod，之后 control 的 HPA 到顶反复发生（同一系列、复用同一个 issue）、api 的 5xx 与错误预算燃烧；node-c 上的 worker
// 积压与它们无关。

const T0 = Date.parse('2026-11-03T08:00:00Z');
const min = (m: number) => T0 + m * 60_000;
const at = (m: number) => new Date(min(m)).toISOString();
const NOW = min(600);

const API = 'Deployment:shop/api';
const CONTROL = 'StatefulSet:shop/control';
const WORKER = 'Deployment:jobs/worker';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const request = (q: Record<string, unknown>): ExportRequest => parseExportQuery({ from: at(0), to: at(600), ...q });

interface MemberSpec {
  alertname: string;
  from: number;
  to: number | null;
  left?: number;
}

function row(n: number, component: string, members: MemberSpec[], seriesKey: string | null = null): IncidentRow {
  const first = Math.min(...members.map((m) => m.from));
  const ended = members.every((m) => m.to !== null) ? Math.max(...members.map((m) => m.to as number)) : null;
  const body = {
    incident_id: id(n),
    cluster_id: 'c1',
    label: `${component}:${at(first).slice(0, 15)}0:00Z`,
    incident_version: 1,
    state: ended === null ? 'firing' : 'resolved',
    severity: 'warning',
    first_firing_at: at(first),
    ended_at: ended === null ? null : at(ended),
    root: {
      component,
      entity: { cluster_id: 'c1', kind: 'Deployment', namespace: 'shop', name: 'api', uid: null },
      ambiguous: false,
      margin: null,
      silent_root: false,
    },
    candidates: [],
    members: members.map((m, i) => ({
      alert_id: `${String(n).padStart(8, '0')}${String(i).padStart(8, '0')}@${min(m.from) / 1000}`,
      alertname: m.alertname,
      role: 'symptom',
      component,
      severity: 'warning',
      category: 'performance',
      status: m.to === null ? 'firing' : 'resolved',
      starts_at: at(m.from),
      ends_at: m.to === null ? null : at(m.to),
      joined_version: 1,
      left_version: m.left ?? null,
    })),
    components: [component],
    categories: ['performance'],
    primary_category: 'performance',
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
  return {
    incident_id: id(n),
    cluster_id: 'c1',
    label: body.label,
    version: 1,
    state: body.state,
    severity: 'warning',
    first_firing_at: new Date(min(first)),
    ended_at: ended === null ? null : new Date(min(ended)),
    root_component: component,
    suppressed: false,
    observability_blind: false,
    split_from: null,
    merged_into: null,
    body,
    updated_at: new Date(min(first)),
    categories: ['performance'],
    primary_category: 'performance',
    series_key: seriesKey,
    services: [],
    primary_service: null,
    primary_service_source: null,
    business_domain: null,
  };
}

const HPA_SERIES = `${CONTROL}|KubeHpaMaxedOut`;
// 新到旧：导出的顺序
const rows: IncidentRow[] = [
  row(6, WORKER, [{ alertname: 'WorkerQueueBacklog', from: 200, to: 260 }]),
  row(5, CONTROL, [{ alertname: 'KubeHpaMaxedOut', from: 120, to: null }], HPA_SERIES),
  row(
    4,
    CONTROL,
    [
      { alertname: 'KubeHpaMaxedOut', from: 60, to: 80 },
      { alertname: 'KubeHpaMaxedOut', from: 90, to: 100 },
    ],
    HPA_SERIES,
  ),
  row(3, API, [
    { alertname: 'ApiErrorBudgetBurnFast', from: 30, to: 90 },
    // 拆分时仍在触发、转到了别的事件的成员不算
    { alertname: 'ApiLatencyHigh', from: 31, to: null, left: 2 },
  ]),
  row(2, API, [
    { alertname: 'ApiHigh5xxRate', from: 11, to: 40 },
    { alertname: 'ApiReadyzFailing', from: 12, to: 30 },
  ]),
  row(1, CONTROL, [{ alertname: 'KubeHpaMaxedOut', from: 14, to: 50 }], HPA_SERIES),
];

const card = (ref: string, verdict: EvidenceResult['verdict'], kind: string, text: string, value: string | null) =>
  ({
    ref,
    card_id: `kubernetes/workload/${ref.replace(':', '-')}`,
    title: { 'zh-CN': `卡 ${ref}` },
    entity: null,
    window: { from: at(0), to: at(60) },
    verdict,
    display_state: verdict,
    reason: { kind, text },
    value,
    threshold: null,
    table: null,
    series: [],
    queries: [],
    egress: 'none',
    evaluated_at: at(60),
  }) as unknown as EvidenceResult;

const facts: Facts = {
  stageA: new Map([
    [
      id(2),
      {
        incident_id: id(2),
        incident_version: 1,
        disposition: 'escalate',
        disposition_reason: 'default',
        cards: [
          card('card:1', 'normal', 'all_clear', '没有命中任何规则。', '0'),
          card('card:2', 'undeterminable', 'no_data', '查询没有返回样本。之后的说明不进摘要', null),
          card('card:3', 'abnormal', 'rule', '5xx 比例超过阈值！', '12%'),
        ],
        rendered_at: new Date(min(12)),
      },
    ],
    [
      id(6),
      {
        incident_id: id(6),
        incident_version: 1,
        disposition: 'undetermined',
        disposition_reason: 'default',
        cards: [],
        rendered_at: new Date(min(201)),
      },
    ],
  ]),
  completed: new Map([
    [
      id(1),
      {
        run_id: id(101),
        incident_id: id(1),
        incident_version: 1,
        state: 'completed',
        disposition: 'act',
        conclusion_level: 'likely',
        summary: '节点内存不足导致驱逐',
        stop_reason: 'leader_supported',
        undetermined_reason: null,
        error: null,
        started_at: new Date(min(16)),
        finished_at: new Date(min(18)),
      },
    ],
    [
      id(3),
      {
        run_id: id(103),
        incident_id: id(3),
        incident_version: 1,
        state: 'completed',
        disposition: 'escalate',
        conclusion_level: 'undetermined',
        summary: '无法确定',
        stop_reason: 'step_limit',
        undetermined_reason: '错误预算的查询没有返回样本',
        error: null,
        started_at: new Date(min(32)),
        finished_at: new Date(min(35)),
      },
    ],
  ]),
  latestRun: new Map(),
  skips: new Map([[id(6), { incident_id: id(6), incident_version: 1, skip_reason: 'storm' }]]),
  reasons: new Map([
    [
      id(6),
      [
        { incident_id: id(6), incident_version: 1, stage: 'research', code: 'storm', detail: '同时有 40 个事件' },
        { incident_id: id(6), incident_version: 1, stage: 'research', code: 'rule_only', detail: null },
      ],
    ],
    [id(5), [{ incident_id: id(5), incident_version: 1, stage: 'stage_a', code: 'stage_a_missing', detail: '超时' }]],
  ]),
  aliases: new Map([[id(3), 2]]),
  reopened: new Map([[id(4), 1]]),
  issues: new Map([
    [id(1), [issueRow(1, null)]],
    [id(4), [issueRow(4, 1)]],
    [id(5), [issueRow(5, 1)]],
  ]),
};

/** 同一个 issue（acme/ops#7）：reusedFrom 为开出它的事件，为 null 时是这个事件自己开出的 */
function issueRow(n: number, reusedFrom: number | null) {
  return {
    incident_id: id(n),
    repo: 'acme/ops',
    number: 7,
    url: 'https://github.com/acme/ops/issues/7',
    closed_at: null,
    reused_from: reusedFrom === null ? null : id(reusedFrom),
  };
}

/** node-a 的内存驱逐（第 10–12 分钟）与 node-c 上 worker 的重启退避 */
const pod = (ns: string, name: string) => ({ kind: 'Pod', namespace: ns, name });
const ev = (m: number, reason: string, object: Observation['object'], node: string, memory: boolean, count = 1) =>
  ({ t: min(m), reason, source: 'events', unit: 'occurrences', object, node, memory, count }) as Observation;
const observations: Observation[] = [
  ev(10, 'EvictionThresholdMet', { kind: 'Node', namespace: null, name: 'node-a' }, 'node-a', true),
  ev(12, 'Evicted', pod('shop', 'api-1'), 'node-a', true),
  ev(12, 'Evicted', pod('shop', 'control-0'), 'node-a', true),
  ev(210, 'BackOff', pod('jobs', 'worker-1'), 'node-c', false, 4),
];
const placements: Placement[] = [
  { component: API, object: 'Pod:shop/api-1', node: 'node-a', from: min(-60), to: min(12), scales: null },
  { component: CONTROL, object: 'Pod:shop/control-0', node: 'node-a', from: min(-60), to: min(12), scales: null },
  {
    component: WORKER,
    object: 'Pod:jobs/worker-1',
    node: 'node-c',
    from: min(-60),
    to: Number.POSITIVE_INFINITY,
    scales: null,
  },
];

function exported(q: Record<string, unknown> = {}): IncidentExport {
  const req = request(q);
  const inputs = warningInputs(rows, req, NOW);
  const windows = inputs.map((i) => ({ from: Date.parse(i.window.from), to: Date.parse(i.window.to as string) }));
  const report = buildKubeWarningReport({
    clusterId: 'c1',
    incidents: inputs,
    windows,
    span: { from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) },
    stepMs: 60_000,
    observations,
    placements,
    queries: [{ name: 'events', source: 'events', query: 'q', status: 'ok', series: 4, detail: null, duration_ms: 1 }],
    grouping: req.grouping,
  });
  return assembleExport({ req, rows, suppressedCount: 1, more: false, facts, reports: [report], now: NOW });
}

const status = (f: () => unknown): number => {
  try {
    f();
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
  return 200;
};

describe('导出参数', () => {
  it('from 与 to 必填、to 不早于 from、跨度不超过 31 天', () => {
    expect(status(() => parseExportQuery({ to: at(0) }))).toBe(400);
    expect(status(() => parseExportQuery({ from: at(0) }))).toBe(400);
    expect(status(() => parseExportQuery({ from: at(10), to: at(0) }))).toBe(400);
    expect(status(() => parseExportQuery({ from: 'yesterday', to: at(0) }))).toBe(400);
    expect(status(() => parseExportQuery({ from: at(0), to: at(31 * 1440) }))).toBe(200);
    expect(status(() => parseExportQuery({ from: at(0), to: at(31 * 1440 + 1) }))).toBe(400);
  });

  it('类别与组件筛选沿用列表接口：可以重复，unclassified 不能被排除；单值参数重复时 400', () => {
    const r = request({
      category: ['availability', 'performance'],
      exclude_category: 'provider',
      exclude_component: API,
    });
    expect(r.filters).toMatchObject({
      category: ['availability', 'performance'],
      excludeCategory: ['provider'],
      excludeComponent: [API],
      suppressed: false,
    });
    expect(status(() => request({ exclude_category: 'unclassified' }))).toBe(400);
    expect(status(() => request({ severity: ['warning', 'critical'] }))).toBe(400);
    expect(status(() => request({ severity: 'major' }))).toBe(400);
    expect(status(() => request({ component: 'not a key' }))).toBe(400);
  });

  it('format、group、limit 与分组参数的默认值和覆盖', () => {
    const d = request({});
    expect(d).toMatchObject({
      format: 'json',
      group: 'incident',
      limit: 5000,
      cursor: null,
      grouping: DEFAULT_GROUPING,
    });
    const r = request({
      format: 'md',
      group: 'series',
      limit: '500',
      group_gap: '10m',
      group_before: '1h',
      group_after: '0s',
      group_min_incidents: '3',
    });
    expect(r).toMatchObject({ format: 'md', group: 'series', limit: 500 });
    expect(r.grouping).toEqual({ gapMs: 600_000, beforeMs: 3600_000, afterMs: 0, minIncidents: 3 });
    expect(status(() => request({ limit: '5001' }))).toBe(400);
    expect(status(() => request({ limit: '0' }))).toBe(400);
    expect(status(() => request({ group_gap: '2d' }))).toBe(400);
    expect(status(() => request({ group_gap: '25h' }))).toBe(400);
    expect(status(() => request({ format: 'csv' }))).toBe(400);
  });
});

describe('每个事件的内容', () => {
  const x = exported();
  const byId = new Map(x.incidents.map((i) => [i.incident_id, i]));

  it('结果符合契约，顺序与读出的顺序相同', () => {
    expect(() => assertValid('schemas/incident-export.schema.json', x)).not.toThrow();
    expect(x.incidents.map((i) => i.incident_id)).toEqual(rows.map((r) => r.incident_id));
    expect(x.series).toBeNull();
    expect(x.grouping).toEqual({ gap_seconds: 1800, before_seconds: 1800, after_seconds: 1800, min_incidents: 2 });
  });

  it('告警名去重排序，离开时仍在触发的成员不算；首次、末次触发与累计时长按成员区间的并集', () => {
    const budget = byId.get(id(3))!;
    expect(budget.alertnames).toEqual(['ApiErrorBudgetBurnFast']);
    expect(budget.firing_seconds).toBe(60 * 60);
    const hpa = byId.get(id(4))!;
    expect(hpa).toMatchObject({ first_firing_at: at(60), last_firing_at: at(90), occurrences: 2, reopened_count: 1 });
    expect(hpa.firing_seconds).toBe(30 * 60);
    // 仍在触发的事件算到计算时刻
    expect(byId.get(id(5))!.firing_seconds).toBe((600 - 120) * 60);
    expect(byId.get(id(2))!).toMatchObject({ occurrences: 1, firing_seconds: 29 * 60, merged_count: 0 });
    expect(budget.merged_count).toBe(2);
  });

  it('研判结论：完成的研判优先，其次阶段 A；无法判定时附原因码与原因', () => {
    expect(byId.get(id(1))!.conclusion).toMatchObject({
      source: 'research',
      disposition: 'act',
      conclusion_level: 'likely',
      undetermined: null,
    });
    expect(byId.get(id(3))!.conclusion.undetermined).toEqual({
      codes: [expect.objectContaining({ stage: 'research', code: 'step_limit', level: 'info' })],
      undetermined_reason: '错误预算的查询没有返回样本',
    });
    expect(byId.get(id(2))!.conclusion).toMatchObject({
      source: 'stage_a',
      disposition: 'escalate',
      undetermined: null,
    });
    const worker = byId.get(id(6))!.conclusion;
    expect(worker).toMatchObject({ source: 'stage_a', disposition: 'undetermined', disposition_reason: 'default' });
    expect(worker.undetermined?.codes.map((c) => [c.code, c.detail])).toEqual([
      ['storm', null],
      ['rule_only', null],
    ]);
    // 没有任何结论
    const none = byId.get(id(5))!.conclusion;
    expect(none).toMatchObject({ source: 'none', disposition: null });
    expect(none.undetermined?.codes).toEqual([
      expect.objectContaining({ stage: 'stage_a', code: 'stage_a_missing', detail: '超时' }),
    ]);
  });

  it('证据卡只列 abnormal 与 undeterminable，abnormal 在前，摘要取主值与说明的第一句', () => {
    expect(byId.get(id(2))!.evidence).toEqual([
      expect.objectContaining({ ref: 'card:3', verdict: 'abnormal', summary: '12%：5xx 比例超过阈值！' }),
      expect.objectContaining({
        ref: 'card:2',
        verdict: 'undeterminable',
        reason_kind: 'no_data',
        summary: '查询没有返回样本。',
      }),
    ]);
    expect(evidenceOf([card('card:1', 'abnormal', 'rule', 'x'.repeat(400), null)])[0]!.summary).toHaveLength(300);
  });

  it('issue：复用的 issue 标为 reused', () => {
    expect(byId.get(id(4))!.issues).toEqual([
      { repo: 'acme/ops', number: 7, url: 'https://github.com/acme/ops/issues/7', state: 'open', reused: true },
    ]);
  });

  it('Kubernetes Warning：node-a 的内存驱逐与 HPA 到顶、5xx、错误预算燃烧归为一组，worker 不进组', () => {
    const k = x.kube_warnings[0]!;
    expect(k.groups).toHaveLength(1);
    const g = k.groups[0]!;
    expect(g.kind).toBe('node_memory_eviction');
    expect(g.incidents.map((i) => i.incident_id).sort()).toEqual([id(1), id(2), id(3)]);
    expect(g.alertnames).toEqual(
      expect.arrayContaining(['KubeHpaMaxedOut', 'ApiHigh5xxRate', 'ApiReadyzFailing', 'ApiErrorBudgetBurnFast']),
    );
    expect(g.alertnames).not.toContain('WorkerQueueBacklog');
    expect(byId.get(id(6))!.kube_warnings.nodes.map((n) => n.node)).toEqual(['node-c']);
    expect(x.complete).toBe(true);
  });

  it('Warning 的时间窗限定在导出时间窗与计算时刻之内', () => {
    const r = row(9, API, [{ alertname: 'A', from: -100, to: null }]);
    expect(warningWindow(r, { from: at(0), to: at(900) }, NOW)).toEqual({ from: at(0), to: at(600) });
    expect(warningWindow(r, { from: at(0), to: at(30) }, NOW)).toEqual({ from: at(0), to: at(30) });
  });

  it('单独的结论函数：没有任何记录时 codes 为空', () => {
    const empty: Facts = { ...facts, reasons: new Map(), skips: new Map(), stageA: new Map(), completed: new Map() };
    expect(conclusionOf(id(42), empty).undetermined).toEqual({ codes: [], undetermined_reason: null });
  });

  it('exportedIncident 不依赖 Warning 报告', () => {
    expect(exportedIncident(rows[1]!, facts, NOW)).not.toHaveProperty('kube_warnings');
  });
});

describe('按系列汇总', () => {
  const x = exported({ group: 'series' });

  it('同一系列的三个事件汇成一项：发生次数按区间并集、issue 去重、开出 issue 的事件在范围内时不算复用', () => {
    expect(() => assertValid('schemas/incident-export.schema.json', x)).not.toThrow();
    const hpa = x.series!.find((s) => s.key === HPA_SERIES)!;
    expect(hpa).toMatchObject({
      key_source: 'series_key',
      occurrences: 4,
      first_firing_at: at(14),
      last_firing_at: at(120),
      ended_at: null,
      incident_ids: [id(5), id(4), id(1)],
    });
    expect(hpa.firing_seconds).toBe((36 + 20 + 10 + 480) * 60);
    expect(hpa.issues).toEqual([
      { repo: 'acme/ops', number: 7, url: 'https://github.com/acme/ops/issues/7', state: 'open', reused: false },
    ]);
  });

  it('没有系列键的事件按 <根因组件>|<告警名> 汇总；按最近一次触发从新到旧', () => {
    const api = x.series!.find((s) => s.key === `${API}|ApiHigh5xxRate,ApiReadyzFailing`)!;
    expect(api).toMatchObject({ key_source: 'alertnames_root', incident_ids: [id(2)], ended_at: at(40) });
    expect(x.series!.map((s) => s.last_firing_at)).toEqual(
      [...x.series!.map((s) => s.last_firing_at)].sort((a, b) => Date.parse(b) - Date.parse(a)),
    );
  });

  it('seriesOf 与 incidents 一一对应', () => {
    expect(seriesOf(rows, x.incidents, NOW)).toEqual(x.series);
  });
});

describe('输出形式', () => {
  it('ndjson：header、每个事件、每个系列、每个集群、end，每行符合 IncidentExportRecord', () => {
    const x = exported({ group: 'series' });
    const lines = [...exportRecords(x)];
    for (const l of lines) {
      expect(() =>
        assertValid('schemas/incident-export.schema.json#/$defs/Record', JSON.parse(JSON.stringify(l))),
      ).not.toThrow();
    }
    const types = lines.map((l: IncidentExportRecord) => l.type);
    expect(types[0]).toBe('header');
    expect(types.filter((t) => t === 'incident')).toHaveLength(rows.length);
    expect(types.filter((t) => t === 'series')).toHaveLength(x.series!.length);
    expect(types.slice(-2)).toEqual(['kube_warnings', 'end']);
    expect(lines.at(-1)).toMatchObject({
      incidents: rows.length,
      suppressed_count: 1,
      truncated: false,
      next_cursor: null,
    });
  });

  it('Markdown：先分组、再按系列汇总、最后是事件明细；外部文字转义', () => {
    const x = exported({ format: 'md' });
    expect(x.series).not.toBeNull();
    const md = exportMarkdown(x);
    const pos = ['## 疑似同一根因', '## 按系列汇总', '## 事件明细'].map((h) => md.indexOf(h));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(md).toContain('### 节点内存驱逐（c1，疑似）');
    expect(md).toContain('KubeHpaMaxedOut');
    expect(md).toContain('`research/step_limit`');
    expect(md).toContain('[acme/ops#7](https://github.com/acme/ops/issues/7)');
    expect(md).toContain('另有 1 个被抑制的事件没有导出');
  });

  it('mdText 转义控制字符并把换行并为空格；humanDuration 取最大的两级', () => {
    expect(mdText('a|b\n*c* [x](y) <img>')).toBe('a\\|b \\*c\\* \\[x\\]\\(y\\) \\<img\\>');
    expect(humanDuration(0)).toBe('0 秒');
    expect(humanDuration(3725)).toBe('1 小时 2 分');
    expect(humanDuration(86_400 + 59)).toBe('1 天');
  });
});
