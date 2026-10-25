import { resolve } from 'node:path';
import type { Alert, Incident } from '@srenautix/contract';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { DEFAULT_NOVELTY } from '../../src/stage-a/novelty.js';
import { PACKS } from '../support/packs.js';
import { incident } from '../support/scenario.js';

/**
 * 证据基线（ADR 0153）在真实 Prometheus 上：两个 Pod 在事件窗口内都有重启，重启卡都判为异常。
 * - api-0 过去 8 天每 20 分钟重启一次：每个基线样本同样异常，判为常态；
 * - web-0 过去 8 天没有重启，事件前 10 分钟重启 5 次：基线样本都正常，判为明显异常。
 * 基线样本按卡片窗口的长度（40 分钟）在事件之前的时段执行，对照时段为 1 小时、24 小时、7 天。
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const T0 = NOW - 10 * MIN;
const FROM = NOW - 8 * DAY;
const metrics = new ServerMetrics('server', false);
const CARD = 'workload/pod-restarts/restarts';
// 同样读重启计数、声明 baseline: false 的卡（ADR 0164）
const BASELINE_OFF = resolve(import.meta.dirname, '../fixtures/packs-baseline');
const KIND_CARD = 'baseline-off/restart-kind/restarting';

let tsdb: TsdbInstance;
let rt: PackRuntime;
let source: EvidenceSource;

function restarts(pod: string, at: (t: number) => number) {
  return {
    labels: { __name__: 'kube_pod_container_status_restarts_total', namespace: 'shop', pod, container: 'app' },
    points: Array.from({ length: Math.floor((NOW - FROM) / MIN) + 1 }, (_, i) => {
      const t = FROM + i * MIN;
      return { t, v: at(t) };
    }),
  };
}

const pod = (name: string) => ({ cluster_id: 'test', kind: 'Pod', namespace: 'shop', name, uid: null });

const podIncident = (): Incident => {
  const base = incident();
  return {
    ...base,
    first_firing_at: new Date(T0).toISOString(),
    root: { ...base.root, component: 'Pod:shop/api-0', entity: pod('api-0') },
    candidates: [],
    components: ['Pod:shop/api-0', 'Pod:shop/web-0'],
  };
};

const evidenceWith = (novelty: typeof DEFAULT_NOVELTY | undefined) =>
  new PackEvidence(
    rt,
    source,
    async () => null,
    { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 5_000, ...(novelty ? { novelty } : {}) },
    metrics,
  );

beforeAll(async () => {
  tsdb = await startPrometheus([
    // 每 20 分钟加 1
    restarts('api-0', (t) => Math.floor((t - FROM) / (20 * MIN))),
    // 一直是 0，事件前 10 分钟到 5
    restarts('web-0', (t) => (t >= T0 - 10 * MIN ? 5 : 0)),
  ]);
  rt = await PackRuntime.load({
    dirs: [PACKS, BASELINE_OFF],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
  });
  source = await EvidenceSource.create({
    id: 'prometheus',
    url: tsdb.url,
    dialect: 'promql',
    bearerTokenFile: null,
    timeoutMs: 5_000,
  });
}, 180_000);

afterAll(async () => {
  await tsdb?.stop();
});

const alerts: Alert[] = [];

describe('证据基线', () => {
  it('长期每隔 20 分钟重启的 Pod 判为常态，事件前才重启的 Pod 判为明显异常，对照时段给出主值', async () => {
    const e = evidenceWith(DEFAULT_NOVELTY);
    const signal = AbortSignal.timeout(120_000);
    const api = await e.runCardCheck(podIncident(), CARD, {}, pod('api-0'), alerts, NOW, signal);
    const web = await e.runCardCheck(podIncident(), CARD, {}, pod('web-0'), alerts, NOW, signal);
    expect(api.verdict).toBe('abnormal');
    expect(web.verdict).toBe('abnormal');

    expect(api.novelty).toMatchObject({ status: 'routine', rule: 'abnormal_share', samples: 29, abnormal_share: 1 });
    expect(api.novelty!.comparisons.map((c) => [c.offset, c.verdict])).toEqual([
      ['1h', 'abnormal'],
      ['24h', 'abnormal'],
      ['7d', 'abnormal'],
    ]);
    // 对照时段的窗口与事件窗口长度相同，整体提前
    const len = Date.parse(api.window.to) - Date.parse(api.window.from);
    for (const c of api.novelty!.comparisons) {
      expect(Date.parse(c.window.to) - Date.parse(c.window.from)).toBe(len);
    }
    expect(Date.parse(api.novelty!.comparisons[1]!.window.to)).toBe(Date.parse(api.window.to) - DAY);

    expect(web.novelty).toMatchObject({ status: 'novel', rule: null, value: 5, abnormal_share: 0 });
    expect(web.novelty!.comparisons.every((c) => c.verdict === 'normal' && c.value === 0)).toBe(true);
  }, 180_000);

  it('声明 baseline: false 的卡描述故障的类型：同样长期重启的 Pod 判为异常，不取基线样本，没有 novelty', async () => {
    const e = evidenceWith(DEFAULT_NOVELTY);
    const signal = AbortSignal.timeout(60_000);
    const api = await e.runCardCheck(podIncident(), KIND_CARD, {}, pod('api-0'), alerts, NOW, signal);
    expect(api.verdict).toBe('abnormal');
    expect(api.novelty).toBeUndefined();
    // 普通的卡照常取基线
    const restarts = await e.runCardCheck(podIncident(), CARD, {}, pod('api-0'), alerts, NOW, signal);
    expect(restarts.novelty).toMatchObject({ status: 'routine' });
  }, 120_000);

  it('数据只覆盖最近 1 天时样本不足，判为 unknown；关闭证据基线时没有 novelty', async () => {
    const e = evidenceWith({ ...DEFAULT_NOVELTY, span: '1d', samples: 4, comparisons: ['1h'], minSamples: 8 });
    const api = await e.runCardCheck(podIncident(), CARD, {}, pod('api-0'), alerts, NOW, AbortSignal.timeout(60_000));
    expect(api.novelty).toMatchObject({ status: 'unknown', samples: 5 });
    const off = await evidenceWith(undefined).runCardCheck(
      podIncident(),
      CARD,
      {},
      pod('api-0'),
      alerts,
      NOW,
      AbortSignal.timeout(60_000),
    );
    expect(off.verdict).toBe('abnormal');
    expect(off.novelty).toBeUndefined();
  }, 120_000);
});
