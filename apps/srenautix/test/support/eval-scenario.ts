import type { EvalCase, EvalSnapshot, MetricsQueryResult } from '@srenautix/contract';
import { metricLines, researchCase, T0 } from './scenario.js';
import { startVictoria, type Victoria } from './victoria.js';

// 评测测试用的用例：scenario.ts 的数据卷写满场景，快照中的查询结果来自真实的 VictoriaMetrics。

export const SCENARIO_QUERIES = [
  'kubelet_volume_stats_used_ratio{namespace="shop"}',
  'http_error_ratio{namespace="shop"}',
];

const iso = (ms: number) => new Date(ms).toISOString();

async function queryRange(
  vm: Victoria,
  expr: string,
  from: number,
  to: number,
  step: number,
): Promise<MetricsQueryResult> {
  const u = new URL(`${vm.url}/api/v1/query_range`);
  u.searchParams.set('query', expr);
  u.searchParams.set('start', String(from / 1000));
  u.searchParams.set('end', String(to / 1000));
  u.searchParams.set('step', `${step}s`);
  const r = await fetch(u);
  if (!r.ok) {
    throw new Error(`VictoriaMetrics 查询失败：HTTP ${r.status}`);
  }
  const body = (await r.json()) as {
    data: { result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
  };
  return {
    series: body.data.result.map((s) => ({
      labels: s.metric,
      times: s.values.map(([t]) => t * 1000),
      values: s.values.map(([, v]) => Number(v)),
    })),
    truncated: false,
    warnings: [],
  };
}

export async function scenarioEvalCase(vm: Victoria): Promise<{ c: EvalCase; s: EvalSnapshot }> {
  await vm.importLines(metricLines());
  const rc = researchCase();
  const from = T0 - 60 * 60_000;
  const to = T0 + 30 * 60_000;
  const entries: EvalSnapshot['queries']['entries'] = [];
  for (const q of SCENARIO_QUERIES) {
    entries.push({
      op: 'query_range',
      request: { expr: q, dialect: 'promql', window: { from: iso(from), to: iso(to) }, step_seconds: 60 },
      result: (await queryRange(vm, q, from, to, 60)) as never,
    });
  }
  const snapshotId = '7a1b2c3d-0000-4000-8000-0000000000e1';
  const c: EvalCase = {
    case_id: 'scenario:pvc-full',
    version: 1,
    suite: 'scenario',
    type: 'scenario',
    cluster_id: 'test',
    incident_id: rc.incident.incident_id,
    label: rc.incident.label,
    started_at: rc.incident.first_firing_at,
    as_of: rc.asOf,
    truth: {
      root_components: ['StatefulSet:shop/postgres', 'PersistentVolumeClaim:shop/data-postgres-0'],
      granularity: 'workload',
      mechanism: '数据卷写满',
      disposition: 'escalate',
      forbid_evidence_consistent: false,
    },
    truth_source: { kind: 'injected', principal: null, ref: null },
    leakage: { exclude_incident_ids: [], exclude_refs: [], learned_from_keys: [] },
    pack_timing: 'pack_before_incident',
    snapshot_id: snapshotId,
    derived_from: null,
    authored_by: 'maintainer',
    created_at: iso(T0 + 3600_000),
  };
  const s: EvalSnapshot = {
    snapshot_id: snapshotId,
    case_id: c.case_id,
    format_version: 1,
    window: { from: iso(from), to: iso(to) },
    as_of: rc.asOf,
    context: {
      incident: rc.incident,
      stage_a: rc.stageA,
      subgraph: rc.subgraph,
      alerts: [],
      actions: rc.actions,
      runbooks: rc.runbooks,
      knowledge: [],
      cases: [],
      templates: [],
    },
    queries: {
      api_version: 'srenautix.io/query-snapshot/v1',
      snapshot_id: snapshotId,
      recorded_at: iso(T0 + 3600_000),
      clock_window: { from: iso(from), to: iso(to) },
      ids: { metrics: 'vm', logs: null, traces: null },
      capabilities: ['metrics.query', 'metrics.query_range'],
      metrics_dialects: ['promql'],
      label_profile: null,
      logs_profile: null,
      entries,
      cases: [],
    },
    created_at: iso(T0 + 3600_000),
    source: { kind: 'scenario', ref: 'test/support/scenario.ts', code_sha: null, pack_lock: null },
  };
  return { c, s };
}

export { startVictoria };
