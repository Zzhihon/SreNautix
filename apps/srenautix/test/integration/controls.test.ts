import { resolve } from 'node:path';
import type { Incident } from '@srenautix/contract';
import { startPrometheus, type FixtureMetricSeries } from '@srenautix/integration-sdk';
import { describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';

// 对照对象（ADR 0179）：外部上游事件的阶段 A 在真实 Prometheus 上执行带 controls 的卡，
// 故障上游自己的判定是卡的主结果，同一入口上的其他上游按请求量取前 2 个、再以事件 id 为种子随机取 1 个，
// 各判定一次，写在 controls.results

const PACKS = resolve(import.meta.dirname, '../fixtures/packs-controls');
const CAPS = new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const);
const CARD = 'upstream-peers/upstream-errors/peer-errors';

const MIN = 60_000;
const T = Math.floor(Date.now() / MIN) * MIN;
const FIRST = T - 15 * MIN;
const INCIDENT_ID = '0b0c4c1e-7c8e-4d55-9a57-3f1f1c2a9e11';

/** 每分钟增长 perMin 的计数器，从 T 之前 60 分钟起 */
function counter(name: string, target: string, perMin: number): FixtureMetricSeries {
  const from = T - 60 * MIN;
  const points: Array<{ t: number; v: number }> = [];
  for (let t = from; t <= T; t += MIN) {
    points.push({ t, v: (perMin * (t - from)) / MIN });
  }
  return { labels: { __name__: name, target }, points };
}

/** 故障上游 up-0 的错误率 0.9；同一入口的其余五个上游请求量依次为每分钟 50、40、30、20、10，错误率为 ratio */
function fixtures(ratio: number): FixtureMetricSeries[] {
  const out = [counter('upstream_requests_total', 'up-0', 10), counter('upstream_errors_total', 'up-0', 9)];
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((target, i) => {
    const perMin = 50 - i * 10;
    out.push(
      counter('upstream_requests_total', target, perMin),
      counter('upstream_errors_total', target, perMin * ratio),
    );
  });
  return out;
}

function incident(): Incident {
  const key = 'Upstream:up-0';
  return {
    incident_id: INCIDENT_ID,
    cluster_id: 'east',
    label: `${key}:x`,
    incident_version: 1,
    state: 'firing',
    severity: 'warning',
    first_firing_at: new Date(FIRST).toISOString(),
    ended_at: null,
    root: {
      component: key,
      entity: { cluster_id: 'east', kind: 'Upstream', namespace: null, name: 'up-0', uid: null },
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

/** 在 ratio 给定的一批上游上执行阶段 A，返回带 controls 的卡 */
async function peerCard(ratio: number) {
  const prom = await startPrometheus(fixtures(ratio));
  try {
    const rt = await PackRuntime.load({
      dirs: [PACKS],
      only: ['upstream-peers'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: CAPS,
    });
    const source = await EvidenceSource.create({
      id: 'prometheus',
      url: prom.url,
      dialect: 'promql',
      bearerTokenFile: null,
      timeoutMs: 10_000,
    });
    const evidence = new PackEvidence(
      rt,
      source,
      async () => null,
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 10_000 },
      new ServerMetrics('server', false),
    );
    const run = await evidence.run(incident(), [], AbortSignal.timeout(30_000));
    const card = run.cards.find((c) => c.card_id === CARD);
    expect(card, run.cards.map((c) => c.card_id).join('、')).toBeDefined();
    return card!;
  } finally {
    await prom.stop();
  }
}

describe('阶段 A 的对照对象', () => {
  it('共因：故障上游与同一入口上多数上游同时失败，对照结果全部异常，请求量最多的两个先入选', async () => {
    const card = await peerCard(0.9);
    expect(card.verdict).toBe('abnormal');
    expect(card.controls).toMatchObject({ method: 'entry_peers', by: 'target', subject: 'up-0', candidates: 5 });
    const results = card.controls!.results;
    expect(results.map((r) => [r.picked_by, r.verdict])).toEqual([
      ['top_n', 'abnormal'],
      ['top_n', 'abnormal'],
      ['sampled', 'abnormal'],
    ]);
    expect(results.slice(0, 2).map((r) => r.subject)).toEqual(['p1', 'p2']);
    expect(results.map((r) => r.subject)).not.toContain('up-0');
    expect(results[0]!.value_number).toBeCloseTo(0.9, 1);
  });

  it('单一上游故障：同一入口上的其他上游同时段正常，对照结果全部正常', async () => {
    const card = await peerCard(0.01);
    expect(card.verdict).toBe('abnormal');
    expect(card.controls!.subject).toBe('up-0');
    expect(card.controls!.results.map((r) => r.verdict)).toEqual(['normal', 'normal', 'normal']);
  });

  it('同一个事件重复执行得到同一批对照对象', async () => {
    const a = await peerCard(0.9);
    const b = await peerCard(0.9);
    expect(a.controls!.results.map((r) => r.subject)).toEqual(b.controls!.results.map((r) => r.subject));
  });
}, 180_000);
