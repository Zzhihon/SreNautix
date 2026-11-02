import type { V1Pod } from '@kubernetes/client-node';
import type { FixtureLogStream, FixtureMetricSeries } from '@srenautix/integration-sdk';

/**
 * 技能 oom-rootcause 的夹具（ADR 0181 §11）：按一次真实的网关内存终止排查整理的虚构工作负载 StatefulSet shop/api-gateway
 * （4 个副本，limit 4 GiB，GOMEMLIMIT 3865470566，GOMAXPROCS 2）。48 小时内 3 次 OOMKilled：
 * - E1 11-01 07:53:42 api-gateway-0：流量接近零，不可重试的上游拒绝被反复重试，归档积压上涨，存活堆从 0.5 GB 涨到 3.3 GiB；
 * - E2 11-02 00:09:14 api-gateway-3、E3 11-02 00:44:22 api-gateway-0：32–51 MB 的大请求体在途，转换字节与归档积压一起上涨；
 * 11-02 01:00–09:00 各副本有大请求体的繁忙时段（存活堆高、没有终止）；导出推迟（deferred）多出现在内存不高的时段（反例）。
 * 指标是模型函数在每分钟的取值（计数器按速率累加），日志是 JSON 行，Kubernetes 是录制的 Pod 状态，代码是业务仓库的文件。
 */

export const NS = 'shop';
export const STS = 'api-gateway';
export const CONTAINER = 'gateway';
export const PODS = ['api-gateway-0', 'api-gateway-1', 'api-gateway-2', 'api-gateway-3'];
export const NODES = ['node-a', 'node-b', 'node-c', 'node-d'];
export const LIMIT = 4 * 1024 ** 3;
export const GOMEMLIMIT = 3865470566;
export const AT = Date.parse('2026-11-02T12:00:00Z');
export const START = Date.parse('2026-10-31T11:00:00Z');
export const K1 = Date.parse('2026-11-01T07:53:42Z');
export const K2 = Date.parse('2026-11-02T00:09:14Z');
export const K3 = Date.parse('2026-11-02T00:44:22Z');
const MIN = 60_000;
const t = (iso: string) => Date.parse(iso);

/** a 到 b 之间线性插值，t 在区间外时取端点 */
function ramp(x: number, a: number, b: number, va: number, vb: number): number {
  if (x <= a) {
    return va;
  }
  if (x >= b) {
    return vb;
  }
  return va + ((vb - va) * (x - a)) / (b - a);
}

/** 确定性的小扰动（0..1） */
function noise(p: number, x: number, salt: number): number {
  const s = Math.sin((x / MIN) * 0.37 + p * 1.7 + salt * 3.1) * 43758.5453;
  return s - Math.floor(s);
}

interface Busy {
  pod: number;
  from: number;
  to: number;
  /** 存活堆高（true）或保持低位（false，反例） */
  memory: boolean;
}

/** 大请求体的繁忙时段：前 15 分钟存活堆上涨，之后贴近 3.0–3.4 GB；memory 为 false 的时段存活堆不涨（反例） */
const BUSY: Busy[] = [
  { pod: 1, from: t('2026-11-02T01:30:00Z'), to: t('2026-11-02T02:20:00Z'), memory: true },
  { pod: 2, from: t('2026-11-02T02:30:00Z'), to: t('2026-11-02T03:20:00Z'), memory: true },
  { pod: 3, from: t('2026-11-02T03:30:00Z'), to: t('2026-11-02T04:20:00Z'), memory: true },
  { pod: 0, from: t('2026-11-02T04:30:00Z'), to: t('2026-11-02T05:20:00Z'), memory: true },
  { pod: 1, from: t('2026-11-02T05:30:00Z'), to: t('2026-11-02T06:20:00Z'), memory: true },
  { pod: 2, from: t('2026-11-02T06:30:00Z'), to: t('2026-11-02T07:20:00Z'), memory: true },
  { pod: 3, from: t('2026-11-02T07:30:00Z'), to: t('2026-11-02T08:20:00Z'), memory: true },
  { pod: 0, from: t('2026-11-02T08:30:00Z'), to: t('2026-11-02T09:20:00Z'), memory: true },
  { pod: 2, from: t('2026-11-01T12:00:00Z'), to: t('2026-11-01T12:40:00Z'), memory: false },
  { pod: 1, from: t('2026-11-01T18:00:00Z'), to: t('2026-11-01T18:30:00Z'), memory: false },
];

/** 导出推迟的时段：大多在内存不高的时候（反例），另有 E2、E3 之前最后几分钟 */
const DEFERRED: Array<{ pod: number; from: number; to: number; rate: number }> = [
  { pod: 0, from: t('2026-11-01T07:01:00Z'), to: t('2026-11-01T07:29:00Z'), rate: 0.03 },
  { pod: 1, from: t('2026-11-01T15:00:00Z'), to: t('2026-11-01T16:00:00Z'), rate: 0.04 },
  { pod: 2, from: t('2026-11-01T20:00:00Z'), to: t('2026-11-01T20:30:00Z'), rate: 0.02 },
  { pod: 3, from: t('2026-11-02T10:00:00Z'), to: t('2026-11-02T10:40:00Z'), rate: 0.025 },
  { pod: 1, from: t('2026-10-31T22:00:00Z'), to: t('2026-10-31T23:00:00Z'), rate: 0.02 },
  { pod: 3, from: t('2026-11-02T00:07:00Z'), to: K2, rate: 0.05 },
  { pod: 0, from: t('2026-11-02T00:42:00Z'), to: K3, rate: 0.05 },
];

export interface PodState {
  heap: number;
  rss: number;
  nextGc: number;
  bodyRate: number;
  backlog: number;
  deferredRate: number;
  active: number;
  cpu: number;
  nodeAvail: number;
}

/** 副本 p 在时刻 x 的状态 */
export function state(p: number, x: number): PodState {
  let heap = 0.8e9 + 0.15e9 * noise(p, x, 1);
  let body = 3e6 + 2e6 * noise(p, x, 2);
  let backlog = 50e6 + 10e6 * noise(p, x, 3);
  let active = 20 + Math.round(10 * noise(p, x, 4));
  let cpu = 0.3 + 0.1 * noise(p, x, 5);
  let deferred = 0.0004 * noise(p, x, 6);
  for (const b of BUSY.filter((y) => y.pod === p && x >= y.from && x < y.to)) {
    body = 60e6 + 40e6 * noise(p, x, 7);
    active = 40;
    backlog = b.memory ? 420e6 + 60e6 * noise(p, x, 8) : 120e6;
    heap = b.memory
      ? ramp(x, b.from, b.from + 15 * MIN, 1.2e9, 3.05e9 + 0.3e9 * noise(p, x, 9))
      : 1.2e9 + 0.1e9 * noise(p, x, 9);
    cpu = b.memory && x > b.from + 15 * MIN ? 0.6 : 0.4;
    // 推迟跟在存活堆之后出现，强度低于高位门槛
    deferred = b.memory && x > b.from + 20 * MIN ? 0.006 : deferred;
  }
  if (p === 1 && x >= t('2026-11-01T15:00:00Z') && x < t('2026-11-01T16:00:00Z')) {
    heap = 1.9e9;
  }
  // E1：api-gateway-0，07:37 起存活堆与积压上涨，流量接近零
  if (p === 0 && x >= t('2026-11-01T07:30:00Z') && x < K1) {
    // 存活堆在终止前 2 分钟到顶，之后贴着 GOMEMLIMIT，GC 连续运行也收不回
    heap = ramp(x, t('2026-11-01T07:37:00Z'), K1 - 2 * MIN, 0.5e9, 3.55e9);
    backlog = ramp(x, t('2026-11-01T07:37:00Z'), K1, 38e6, 215e6);
    body = 0.5e6;
    active = 2;
    cpu = x < t('2026-11-01T07:46:00Z') ? 0.2 : 1.15;
  }
  // E2：api-gateway-3，23:45 起大请求体
  if (p === 3 && x >= t('2026-11-01T23:45:00Z') && x < K2) {
    body = ramp(x, t('2026-11-01T23:45:00Z'), K2, 10e6, 120e6);
    heap = ramp(x, t('2026-11-01T23:45:00Z'), K2 - 2 * MIN, 1.5e9, 3.52e9);
    backlog =
      x < t('2026-11-02T00:04:00Z')
        ? ramp(x, t('2026-11-01T23:45:00Z'), t('2026-11-02T00:04:00Z'), 300e6, 1058e6)
        : ramp(x, t('2026-11-02T00:04:00Z'), K2, 1058e6, 1477e6);
    active = 7;
    cpu = x < t('2026-11-02T00:03:00Z') ? 0.6 : 1.1;
  }
  // E3：api-gateway-0，00:20 起大请求体
  if (p === 0 && x >= t('2026-11-02T00:20:00Z') && x < K3) {
    body = ramp(x, t('2026-11-02T00:20:00Z'), K3, 15e6, 110e6);
    heap = ramp(x, t('2026-11-02T00:20:00Z'), K3 - 2 * MIN, 1.6e9, 3.55e9);
    backlog =
      x < t('2026-11-02T00:40:00Z')
        ? ramp(x, t('2026-11-02T00:20:00Z'), t('2026-11-02T00:40:00Z'), 120e6, 201e6)
        : ramp(x, t('2026-11-02T00:40:00Z'), K3, 201e6, 1277e6);
    active = 6;
    cpu = x < t('2026-11-02T00:38:00Z') ? 0.7 : 1.1;
  }
  for (const d of DEFERRED.filter((y) => y.pod === p && x >= y.from && x < y.to)) {
    // 终止之前的几分钟里推迟逐渐增多
    deferred = d.to === K2 || d.to === K3 ? ramp(x, d.from, d.to, 0.005, d.rate) : d.rate;
  }
  // 终止之后的几分钟：新容器，存活堆低
  for (const k of [K1, K2, K3]) {
    const pod = k === K2 ? 3 : 0;
    if (p === pod && x >= k && x < k + 10 * MIN) {
      heap = 0.4e9;
      backlog = 30e6;
      cpu = 0.3;
    }
  }
  const nextGc = Math.min(GOMEMLIMIT, heap * 1.08);
  const rss = Math.min(LIMIT, heap * 1.1 + 160e6);
  return { heap, rss, nextGc, bodyRate: body, backlog, deferredRate: deferred, active, cpu, nodeAvail: 0.55 };
}

/** 每分钟一个样本，从 START 到 AT */
export function minutes(): number[] {
  const out: number[] = [];
  for (let x = START; x <= AT; x += MIN) {
    out.push(x);
  }
  return out;
}

/** 容器重启：每次终止之后下一个整分钟计数加一 */
function restarts(p: number, x: number): number {
  const kills = p === 0 ? [K1, K3] : p === 3 ? [K2] : [];
  return kills.filter((k) => x >= Math.ceil(k / MIN) * MIN).length;
}

export function metricSeries(): FixtureMetricSeries[] {
  const xs = minutes();
  const out: FixtureMetricSeries[] = [];
  const add = (name: string, labels: Record<string, string>, f: (x: number) => number) =>
    out.push({ labels: { __name__: name, ...labels }, points: xs.map((x) => ({ t: x, v: f(x) })) });
  for (const [p, pod] of PODS.entries()) {
    const pl = { namespace: NS, pod };
    const cl = { ...pl, container: CONTAINER };
    // 计数器按速率逐分钟累加
    const counter = (rate: (x: number) => number) => {
      let acc = 0;
      const vals = new Map<number, number>();
      for (const x of xs) {
        acc += rate(x) * 60;
        vals.set(x, acc);
      }
      return (x: number) => vals.get(x)!;
    };
    add('up', { job: 'api-gateway', ...pl }, () => 1);
    add('kube_pod_info', { ...pl, node: NODES[p]! }, () => 1);
    add('go_memstats_heap_inuse_bytes', pl, (x) => state(p, x).heap);
    add('go_memstats_next_gc_bytes', pl, (x) => state(p, x).nextGc);
    add('go_gc_gomemlimit_bytes', pl, () => GOMEMLIMIT);
    add('go_sched_gomaxprocs_threads', pl, () => 2);
    add('container_memory_rss', cl, (x) => state(p, x).rss);
    add('kube_pod_container_resource_limits', { ...cl, resource: 'memory' }, () => LIMIT);
    add(
      'container_cpu_usage_seconds_total',
      cl,
      counter((x) => state(p, x).cpu),
    );
    add('kube_pod_container_status_restarts_total', cl, (x) => restarts(p, x));
    if (p === 0 || p === 3) {
      const first = p === 0 ? K1 : K2;
      out.push({
        labels: { __name__: 'kube_pod_container_status_last_terminated_reason', ...cl, reason: 'OOMKilled' },
        points: xs.filter((x) => x >= first).map((x) => ({ t: x, v: 1 })),
      });
    }
    add(
      'shop_request_body_conversion_bytes_total',
      pl,
      counter((x) => state(p, x).bodyRate),
    );
    add('shop_archive_log_backlog_bytes', pl, (x) => state(p, x).backlog);
    add(
      'shop_archive_export_deferred_total',
      pl,
      counter((x) => state(p, x).deferredRate),
    );
    add('shop_active_requests', pl, (x) => state(p, x).active);
  }
  for (const [i, node] of NODES.entries()) {
    add('node_memory_MemAvailable_bytes', { node }, () => 0.55 * 64e9 + i);
    add('node_memory_MemTotal_bytes', { node }, () => 64e9);
  }
  return out;
}

const ORG_A = '7f3c9a2b5e6d4c1a';
const ORG_B = 'c0ffee1288aa0b11';
const ORG_C = '0b5e33d1c2a9f7e4';

function line(time: number, msg: string, fields: Record<string, unknown>): { t: number; line: string } {
  return { t: time, line: JSON.stringify({ time: new Date(time).toISOString(), level: 'INFO', msg, ...fields }) };
}

export function logLines(): Map<string, Array<{ t: number; line: string }>> {
  const by = new Map<string, Array<{ t: number; line: string }>>(PODS.map((p) => [p, []]));
  const push = (pod: string, l: { t: number; line: string }) => by.get(pod)!.push(l);
  // E1 之前：不可重试的上游拒绝被重试 89 次
  for (let i = 0; i < 89; i++) {
    const x =
      t('2026-11-01T07:35:30Z') + Math.round((i * (t('2026-11-01T07:44:09Z') - t('2026-11-01T07:35:30Z'))) / 88);
    push(
      'api-gateway-0',
      line(x, 'executor_upstream_failure', {
        request_id: '01a19608-ee46-7301-8c47-9540c8336bfb',
        status_code: 400,
        error_category: 'context_overflow',
        retryable: false,
        error_message: 'input 1532947 tokens exceeds the context window of 1050000; prompt starts with "confidential"',
      }),
    );
  }
  // 普通请求（小请求体）与大请求体
  let n = 0;
  const req = (pod: string, x: number, org: string, bytes: number, duration: number, path = '/v1/responses') =>
    push(
      pod,
      line(x, 'request_end', {
        request_id: `0194${String(++n).padStart(4, '0')}-0000-7000-8000-${String(n).padStart(12, '0')}`,
        organization_id: `${org}-${'9'.repeat(8)}`,
        method: 'POST',
        path,
        status: 200,
        duration_ms: duration,
        request_body_bytes: bytes,
        response_body_bytes: 4096,
        request_body: 'user prompt text that must never leave the gateway',
      }),
    );
  for (let x = t('2026-11-01T23:40:00Z'); x < K2; x += 90_000) {
    req('api-gateway-3', x, ORG_C, 12_000 + (x % 7) * 100, 900);
  }
  for (let x = t('2026-11-02T00:12:00Z'); x < K3; x += 90_000) {
    req('api-gateway-0', x, ORG_C, 14_000, 800);
  }
  const big: Array<[string, string, string, number, number]> = [
    ['api-gateway-3', '2026-11-01T23:43:10Z', ORG_A, 33_554_432 + 1_200_000, 717_000],
    ['api-gateway-3', '2026-11-01T23:51:40Z', ORG_A, 41_943_040, 512_000],
    ['api-gateway-3', '2026-11-01T23:58:05Z', ORG_A, 50_331_648 + 900_000, 401_000],
    ['api-gateway-3', '2026-11-02T00:02:30Z', ORG_B, 18_874_368, 142_000],
    ['api-gateway-3', '2026-11-02T00:06:12Z', ORG_A, 46_137_344, 233_000],
    ['api-gateway-0', '2026-11-02T00:21:44Z', ORG_A, 35_651_584, 655_000],
    ['api-gateway-0', '2026-11-02T00:28:09Z', ORG_A, 52_428_800 + 300_000, 588_000],
    ['api-gateway-0', '2026-11-02T00:33:51Z', ORG_A, 39_845_888, 310_000],
    ['api-gateway-0', '2026-11-02T00:38:27Z', ORG_B, 20_971_520, 190_000],
    ['api-gateway-0', '2026-11-02T00:41:02Z', ORG_A, 44_040_192, 160_000],
  ];
  for (const [pod, at, org, bytes, d] of big) {
    req(pod, t(at), org, bytes, d, org === ORG_B ? '/v1beta/models/m:streamGenerateContent' : '/v1/responses');
  }
  push(
    'api-gateway-3',
    line(t('2026-11-02T00:07:21Z'), 'request_body_budget_tuned', {
      extra_bytes: 0,
      live_heap_bytes: 2773506824,
      held_bytes: 1055252092,
      memory_budget_bytes: 2791728742,
      effective_budget_bytes: 2791728742,
    }),
  );
  push(
    'api-gateway-0',
    line(t('2026-11-02T00:43:38Z'), 'request_body_budget_tuned', {
      extra_bytes: 0,
      live_heap_bytes: 2710751472,
      held_bytes: 573754494,
      memory_budget_bytes: 2791728742,
      effective_budget_bytes: 2791728742,
    }),
  );
  push(
    'api-gateway-3',
    line(t('2026-11-02T00:08:30Z'), 'request_archive_spool_full', {
      log_usage_bytes: 2_254_857_830,
      log_budget_bytes: 2_147_483_648,
    }),
  );
  push(
    'api-gateway-0',
    line(t('2026-11-02T00:43:55Z'), 'request_archive_spool_full', {
      log_usage_bytes: 2_297_771_212,
      log_budget_bytes: 2_147_483_648,
    }),
  );
  push(
    'api-gateway-3',
    line(t('2026-11-02T06:17:24Z'), 'heap_profile_captured', {
      path: '/var/lib/app/heap-profiles/heap-20261102T061724Z-2330MiB.pb.gz',
      heap_inuse_bytes: 2_443_182_080,
    }),
  );
  push(
    'api-gateway-0',
    line(t('2026-11-02T06:37:22Z'), 'heap_profile_captured', {
      path: '/var/lib/app/heap-profiles/heap-20261102T063722Z-2883MiB.pb.gz',
      heap_inuse_bytes: 3_023_044_608,
    }),
  );
  // 不符合文件名模式的路径不出现在 issue 里
  push(
    'api-gateway-0',
    line(t('2026-11-02T06:40:00Z'), 'heap_profile_captured', { path: '/tmp/x; rm -rf /', heap_inuse_bytes: 1 }),
  );
  for (const l of by.values()) {
    l.sort((a, b) => a.t - b.t);
  }
  return by;
}

export function logStreams(): FixtureLogStream[] {
  return [...logLines()].map(([pod, lines]) => ({ labels: { namespace: NS, pod, container: CONTAINER }, lines }));
}

/** 录制的 Pod 状态（kube.read 的 pod_status 与上一次退出的容器日志） */
export function pods(): V1Pod[] {
  const term = (p: number) => (p === 0 ? new Date(K3) : p === 3 ? new Date(K2) : null);
  return PODS.map((name, p) => ({
    metadata: { name, namespace: NS, labels: { app: STS } },
    spec: {
      nodeName: NODES[p],
      containers: [
        {
          name: CONTAINER,
          image: 'registry.example/api-gateway:1.42.0',
          resources: { limits: { memory: '4Gi', cpu: '2' }, requests: { memory: '4Gi', cpu: '1' } },
          env: [{ name: 'API_KEY', value: 'sk-should-never-leak-0123456789' }],
        },
      ],
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: CONTAINER,
          image: 'registry.example/api-gateway:1.42.0',
          imageID: '',
          ready: true,
          restartCount: p === 0 ? 2 : p === 3 ? 1 : 0,
          lastState: term(p)
            ? {
                terminated: {
                  reason: 'OOMKilled',
                  exitCode: 137,
                  finishedAt: term(p)!,
                  startedAt: new Date(term(p)!.getTime() - 3600_000),
                },
              }
            : {},
          state: { running: { startedAt: new Date((term(p)?.getTime() ?? START) + 2000) } },
        },
      ],
    },
  }));
}

/** 上一次退出的容器日志尾部：E3 之前的几行，含一行带请求体字段的访问日志 */
export function previousLogs(): Map<string, string> {
  const l0 = [
    line(t('2026-11-02T00:43:38Z'), 'request_body_budget_tuned', {
      live_heap_bytes: 2710751472,
      held_bytes: 573754494,
      memory_budget_bytes: 2791728742,
    }).line,
    line(t('2026-11-02T00:43:50Z'), 'heap_profile_captured', {
      path: '/var/lib/app/heap-profiles/heap-20261102T004350Z-3290MiB.pb.gz',
      heap_inuse_bytes: 3_449_815_040,
    }).line,
    'panic-free plain text line that is not JSON',
  ];
  const l3 = [
    line(t('2026-11-02T00:09:01Z'), 'request_end', {
      request_id: '01940099-0000-7000-8000-000000000099',
      organization_id: `${ORG_A}-xxxx`,
      path: '/v1/responses',
      status: 499,
      duration_ms: 300_000,
      request_body_bytes: 47_185_920,
      request_body: 'another user prompt',
    }).line,
  ];
  return new Map([
    ['api-gateway-0', l0.join('\n')],
    ['api-gateway-3', l3.join('\n')],
  ]);
}

/** 业务仓库的文件（代码路径提示的模式） */
export const CODE: Record<string, string> = {
  'internal/body/limit.go': `package body

// 预算之外，一个超大请求还会临时多占内存
const defaultSpikeAllowance = int64(1 << 30)

func budgetCeiling(limit, allowance int64) int64 {
	if allowance >= limit {
		return limit / 2
	}
	return limit - allowance
}
`,
  'internal/capture/writer.go': `package capture

func (w *Writer) wholeSegment(chunks []chunk, read func(chunk) ([]byte, error)) ([]byte, error) {
	var whole []byte
	for _, c := range chunks {
		body, err := read(c)
		if err != nil {
			return nil, err
		}
		whole = append(whole, body...)
	}
	return whole, nil
}
`,
  'internal/executor/retry.go': `package executor

func retryConfig(rc *RequestContext) Config {
	return Config{MaxAttempts: 84, RetryNonRetryable: true}
}
`,
  'internal/export/memory.go': `package export

const heapObjectsMetric = "/memory/classes/heap/objects:bytes"
`,
};
