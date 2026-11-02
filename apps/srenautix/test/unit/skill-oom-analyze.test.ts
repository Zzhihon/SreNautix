import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { skills as sdk } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CONTAINER,
  K1,
  K2,
  K3,
  logLines,
  NS,
  PODS,
  pods,
  previousLogs,
  state,
  STS,
} from '../support/oom-skill-fixture.js';
import { podSummary } from '../../src/skills/kube.js';

// 技能 oom-rootcause 的确定性分析（docs/skills/oom-rootcause.zh-CN.md §4）：输入是夹具模型在各个时刻的取值（与指标数据源
// 按同样的步长返回的序列一致），检验分类、嫌疑项的支持与反例、分组与置信度、大请求的组织份额、堆画像与渲染出的 issue 正文

const ROOT = resolve(import.meta.dirname, '../../../..');
const SKILL = sdk.loadSkillDir(resolve(ROOT, 'skills/oom-rootcause'), 'builtin', { hostVersion: '0.2.0' });
const BINDING = (
  parse(readFileSync(resolve(import.meta.dirname, '../fixtures/skills/packs/shop/skill-bindings.yaml'), 'utf8')) as {
    bindings: Array<{ data: Record<string, unknown> }>;
  }
).bindings[0]!.data as Record<string, unknown> & {
  suspects: sdk.SuspectDecl[];
  context: sdk.SuspectSeries[];
  logs: sdk.LogEventDecl[];
  identifiers: sdk.Identifiers;
  profiles: sdk.ProfilesDecl & { log: sdk.LogEventDecl };
  top_requests: {
    event: string;
    by: string[];
    columns: Array<{ field: string; title: unknown; code?: boolean }>;
    value_field: string;
    group_field: string;
    large_bytes: number;
  };
};
const P = SKILL.manifest.params as Record<string, number>;
const MIN = 60_000;
const AT = Date.parse('2026-11-02T12:00:00Z');

/** 一个信号在各个 Pod 上的取值（规范标签 pod） */
function series(key: string, podsIn: readonly number[], from: number, to: number, step: number): sdk.SignalData {
  const f = (p: number, x: number): number | null => {
    const s = state(p, x);
    switch (key) {
      case 'go-runtime/heap_inuse':
        return s.heap;
      case 'go-runtime/next_gc':
        return s.nextGc;
      case 'go-runtime/gomemlimit':
        return 3865470566;
      case 'go-runtime/gomaxprocs':
        return 2;
      case 'workload/container_memory_rss':
        return s.rss;
      case 'workload/container_memory_limit':
        return 4 * 1024 ** 3;
      case 'workload/container_cpu_cores':
        return s.cpu;
      case 'workload/pod_node_memory_available':
        return s.nodeAvail;
      case 'shop/body_bytes_rate':
        return s.bodyRate;
      case 'shop/archive_backlog_bytes':
        return s.backlog;
      case 'shop/export_deferred_rate':
        return s.deferredRate;
      case 'shop/active_requests':
        return s.active;
      default:
        return null;
    }
  };
  return {
    expr: `${key}{namespace="${NS}"}`,
    series: podsIn.map((p) => {
      const points: sdk.Point[] = [];
      for (let x = Math.ceil(from / step) * step; x <= to; x += step) {
        const v = f(p, x);
        if (v !== null) {
          points.push({ t: x, v });
        }
      }
      return { labels: { namespace: NS, pod: PODS[p]!, container: CONTAINER }, points };
    }),
  };
}

const AROUND_SIGNALS = [
  'go-runtime/heap_inuse',
  'go-runtime/next_gc',
  'go-runtime/gomemlimit',
  'go-runtime/gc_cpu_cores',
  'go-runtime/gomaxprocs',
  'workload/container_memory_rss',
  'workload/container_memory_limit',
  'workload/container_cpu_cores',
  'workload/pod_node_memory_available',
  'shop/body_bytes_rate',
  'shop/archive_backlog_bytes',
  'shop/export_deferred_rate',
  'shop/active_requests',
];

function occurrences(): sdk.Occurrence[] {
  return [
    {
      pod: 'api-gateway-0',
      container: CONTAINER,
      at: Math.floor(K1 / MIN) * MIN,
      cause: 'oom_killed',
      source: 'metric',
      new: true,
    },
    { pod: 'api-gateway-3', container: CONTAINER, at: K2, cause: 'oom_killed', source: 'pod_status', new: true },
    { pod: 'api-gateway-0', container: CONTAINER, at: K3, cause: 'oom_killed', source: 'pod_status', new: true },
  ];
}

function around(occ: sdk.Occurrence[]): sdk.AroundWindow[] {
  return occ.map((o) => {
    const p = PODS.indexOf(o.pod);
    const from = o.at - 30 * MIN;
    const to = Math.min(AT, o.at + 30 * MIN);
    return {
      pod: o.pod,
      container: o.container,
      at: o.at,
      from,
      to,
      signals: Object.fromEntries(AROUND_SIGNALS.map((k) => [k, series(k, [p], from, to, 30_000)])),
    };
  });
}

function history(): sdk.HistoryWindow {
  const from = AT - 48 * 3600_000;
  const keys = [
    'go-runtime/heap_inuse',
    'go-runtime/gomemlimit',
    'shop/body_bytes_rate',
    'shop/archive_backlog_bytes',
    'shop/export_deferred_rate',
  ];
  return {
    from,
    to: AT,
    step_seconds: 300,
    signals: Object.fromEntries(keys.map((k) => [k, series(k, [0, 1, 2, 3], from, AT, 300_000)])),
  };
}

/** logs.events 的结果：每个 Pod 在发生之前 30 分钟（through 时到参考时刻）的声明事件 */
function logsOf(occ: sdk.Occurrence[], events: sdk.LogEventDecl[], through: boolean): sdk.LogsOutput {
  const all = logLines();
  const records: sdk.LogRecord[] = [];
  for (const pod of [...new Set(occ.map((o) => o.pod))]) {
    for (const l of all.get(pod) ?? []) {
      const inWindow = occ.some((o) => o.pod === pod && l.t >= o.at - 30 * MIN && l.t <= (through ? AT : o.at));
      if (!inWindow) {
        continue;
      }
      const r = sdk.extractRecord(l.line, l.t, pod, events, BINDING.identifiers);
      if (r && (!events.find((e) => e.id === r.event)?.min || (r.fields.request_body_bytes as number) > 16777216)) {
        records.push(r);
      }
    }
  }
  return {
    records: records.sort((a, b) => a.time - b.time),
    queries: Object.fromEntries(events.map((e) => [e.id, [`{pod=~".+"} |= "${e.message}"`]])),
    truncated: false,
  };
}

function analyze(lang: sdk.Lang) {
  const occ = occurrences();
  const win = around(occ);
  const podStatus = pods().map(podSummary);
  const kind = sdk.classifyMemory({
    runtime: 'go',
    container: CONTAINER,
    occurrences: occ,
    pods: podStatus,
    kubeEvents: [],
    around: win,
    signals: {
      heap: 'go-runtime/heap_inuse',
      next_gc: 'go-runtime/next_gc',
      gomemlimit: 'go-runtime/gomemlimit',
      gc_cpu: 'go-runtime/gc_cpu_cores',
      gomaxprocs: 'go-runtime/gomaxprocs',
      rss: 'workload/container_memory_rss',
      container_limit: 'workload/container_memory_limit',
      cpu: 'workload/container_cpu_cores',
      node_memory_available: 'workload/pod_node_memory_available',
    },
    thresholds: {
      heap_near_limit_ratio: P.heap_near_limit_ratio!,
      next_gc_near_limit_ratio: P.next_gc_near_limit_ratio!,
      gc_cpu_ratio: P.gc_cpu_ratio!,
      gc_cpu_sustain_seconds: P.gc_cpu_sustain_seconds!,
      node_available_min: P.node_available_min!,
    },
    lang,
  });
  const logs = logsOf(occ, BINDING.logs, false);
  const prev = sdk.extractLogs(
    [...previousLogs()].map(([pod, text]) => ({ pod, container: CONTAINER, text, read_at: AT })),
    BINDING.logs,
    BINDING.identifiers,
  );
  const rank = sdk.rankSuspects({
    suspects: BINDING.suspects,
    context: BINDING.context,
    classified: kind,
    around: win,
    history: history(),
    logs: [logs, prev],
    thresholds: {
      rise_corr: P.rise_corr!,
      lift_min: P.lift_min!,
      counter_max: P.counter_max!,
      reverse_margin: P.reverse_margin!,
      min_history_samples: P.min_history_samples!,
      memory_high_ratio: P.memory_high_ratio!,
    },
    lang,
  });
  const requests = sdk.topRecords({
    logs: [logs, prev],
    event: 'request_end',
    pods: rank.main_group.pods,
    by: BINDING.top_requests.by,
    limit: 10,
    columns: BINDING.top_requests.columns,
    group: { field: 'org', value_field: 'request_body_bytes', min_value: 16777216, share_min: P.org_share_min! },
    lang,
  });
  const profileLogs = logsOf(occ, [BINDING.profiles.log], true);
  const prevProfiles = sdk.extractLogs(
    [...previousLogs()].map(([pod, text]) => ({ pod, container: CONTAINER, text, read_at: AT })),
    [BINDING.profiles.log],
    BINDING.identifiers,
  );
  const profiles = sdk.listProfiles({
    logs: [profileLogs, prevProfiles],
    profiles: BINDING.profiles,
    limitPerPod: 4,
    namespace: NS,
    container: CONTAINER,
  });
  return { occ, kind, rank, requests, profiles, logs };
}

describe('oom-rootcause 的分析', () => {
  const a = analyze('zh-CN');

  it('三次发生都是容器 limit 触发，存活堆贴着 GOMEMLIMIT 且 GC 连续运行（用容器 CPU 代替 GC CPU，标为推断）', () => {
    expect(a.kind.occurrences.map((o) => [o.pod, o.kind, o.heap, o.gc_proxy])).toEqual([
      ['api-gateway-0', 'container_limit', 'live_heap_at_limit', true],
      ['api-gateway-3', 'container_limit', 'live_heap_at_limit', true],
      ['api-gateway-0', 'container_limit', 'live_heap_at_limit', true],
    ]);
    expect(a.kind.facts).toEqual({
      limit: '4.0 GiB',
      gomemlimit: '3865470566',
      gomaxprocs: '2',
      image: 'registry.example/api-gateway:1.42.0',
    });
    expect(a.kind.inferred.length).toBe(3);
  });

  it('主因是大请求体（11-02 的两次），E1 是另一种触发（不可重试的拒绝），导出看门狗被反例排除并是次要加重因素', () => {
    const v = Object.fromEntries(
      a.rank.ranked.map((r) => [r.id, [r.verdict, r.confidence, r.group.map((g) => g.pod)]]),
    );
    expect(v['body-buffering']).toEqual(['main', 'medium_high', ['api-gateway-3', 'api-gateway-0']]);
    expect(v['retry-backlog']).toEqual(['other', 'medium', ['api-gateway-0']]);
    expect(v['export-watchdog']?.[0]).toBe('ruled_out');
    const w = a.rank.ruled_out.find((r) => r.id === 'export-watchdog')!;
    expect(w.aggravating).toBe(true);
    expect(w.history!.counter!).toBeGreaterThan(0.5);
    expect(a.rank.main_id).toBe('body-buffering');
    expect(a.rank.main_code_path).toBe('internal/body/limit.go');
    expect(a.rank.unexplained).toEqual([]);
  });

  it('证据表的每一行都有依据，观测的行有查询', () => {
    expect(a.rank.evidence.length).toBeGreaterThan(10);
    for (const r of a.rank.evidence) {
      expect(['观测', '推断（统计）', '推断（代替）']).toContain(r.basis);
      if (r.basis !== '推断（统计）') {
        expect(r.query).not.toBe('');
      }
    }
  });

  it('大请求按请求体排序，组织只保留前缀，请求体字段不进入记录', () => {
    expect(a.requests.group.key).toBe('7f3c9a2b');
    expect(a.requests.items[0]!.fields.request_body_bytes).toBe(52_728_800);
    for (const r of [...a.logs.records, ...a.requests.items]) {
      expect(JSON.stringify(r)).not.toMatch(/user prompt|confidential|context window/);
    }
  });

  it('堆画像只列出符合文件名模式的路径，命令里的占位符被替换', () => {
    expect(a.profiles.items.map((p) => [p.pod, p.file])).toEqual([
      ['api-gateway-0', 'heap-20261102T063722Z-2883MiB.pb.gz'],
      ['api-gateway-0', 'heap-20261102T004350Z-3290MiB.pb.gz'],
      ['api-gateway-3', 'heap-20261102T061724Z-2330MiB.pb.gz'],
    ]);
    expect(a.profiles.items[0]!.fetch).toBe(
      `kubectl -n ${NS} cp api-gateway-0:/var/lib/app/heap-profiles/heap-20261102T063722Z-2883MiB.pb.gz ./heap-20261102T063722Z-2883MiB.pb.gz -c ${CONTAINER}`,
    );
  });

  it('渲染出的 issue 正文与期望一致（中英文）', () => {
    for (const lang of ['zh-CN', 'en'] as const) {
      const x = lang === 'zh-CN' ? a : analyze('en');
      const view = {
        skill: { name: SKILL.name, version: SKILL.manifest.version, digest: 'sha256:fixture' },
        run: {
          id: '00000000-0000-4000-8000-000000000001',
          url: 'https://srenautix.example.test/skills/runs/00000000-0000-4000-8000-000000000001',
        },
        subject: { kind: 'StatefulSet', namespace: NS, name: STS },
        params: SKILL.manifest.params,
        steps: {
          occ: { occurrences: x.occ, new: x.occ },
          kind: x.kind,
          rank: x.rank,
          requests: x.requests,
          profiles: x.profiles,
          code: { commit: null, items: [], stale: [] },
          related: { items: x.rank.references.map((number) => ({ number })) },
        },
        finding: { fingerprint: 'f', generation: 1, previous_number: null, occurrences: 1 },
      };
      const body = sdk.renderTemplate(SKILL.templates[`templates/issue.${lang}.md`]!, view);
      const golden = resolve(import.meta.dirname, `../fixtures/skills/oom-rootcause/issue.${lang}.md`);
      // 更新期望：SRENAUTIX_UPDATE_GOLDEN=1 时写出渲染结果，由人对照之后提交
      if (process.env.SRENAUTIX_UPDATE_GOLDEN === '1') {
        writeFileSync(golden, body);
      }
      expect(body).toBe(readFileSync(golden, 'utf8'));
    }
  });
});
