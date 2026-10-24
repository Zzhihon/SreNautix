import type { Alert, EvidenceResult, Incident } from '@srenautix/contract';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { observabilityBlind } from '../../src/stage-a/report.js';
import { PACKS } from '../support/packs.js';
import { incident } from '../support/scenario.js';

/**
 * 阶段 A 证据卡的窗口锚点（ADR 0107 §7）：卡片窗口以事件首次触发为锚点；实体上最晚开始的在场成员告警落在卡片窗口之后时
 * （事件持续数小时、之后才升级的告警），这个实体上的卡按那条告警重新锚定，不再只看事件开始时的那一段。
 */
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const T0 = NOW - 8 * 60 * MIN;
const metrics = new ServerMetrics('server', false);

let prom: TsdbInstance;
let evidence: PackEvidence;

const alert = (n: number, name: string, startsAt: number): Alert => ({
  alert_id: `${n.toString(16).padStart(16, '0')}@${startsAt / 1000}`,
  cluster_id: 'test',
  source: 'alertmanager',
  fingerprint: n.toString(16).padStart(16, '0'),
  alertname: `Alert${n}`,
  labels: { alertname: `Alert${n}`, namespace: 'shop', deployment: name },
  annotations: {},
  severity: 'critical',
  status: 'firing',
  suppressed: 'none',
  starts_at: new Date(startsAt).toISOString(),
  ends_at: null,
  generator_url: null,
  classification: { role: 'cause', source: 'label', confidence: 1, catalog_entry: null, chronic: false },
  entity: { cluster_id: 'test', kind: 'Deployment', namespace: 'shop', name, uid: null },
  entity_resolution: 'labels',
  component: `Deployment:shop/${name}`,
  received_at: new Date(startsAt).toISOString(),
});

beforeAll(async () => {
  prom = await startPrometheus([]);
  const rt = await PackRuntime.load({
    dirs: [PACKS],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
  });
  evidence = new PackEvidence(
    rt,
    await EvidenceSource.create({
      id: 'prometheus',
      url: prom.url,
      dialect: 'promql',
      bearerTokenFile: null,
      timeoutMs: 5_000,
    }),
    async () => null,
    { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 5_000 },
    metrics,
  );
}, 120_000);

afterAll(async () => {
  await prom?.stop();
});

const windowTo = (cards: EvidenceResult[], name: string) =>
  cards.filter((c) => c.entity?.name === name).map((c) => Date.parse(c.window.to));

describe('阶段 A 卡片窗口的锚点', () => {
  it('首次触发之后 6 小时才开始的成员告警：它的实体上的卡按它锚定；窗口内开始的告警仍按首次触发锚定', async () => {
    const base = incident();
    const inc: Incident = {
      ...base,
      first_firing_at: new Date(T0).toISOString(),
      root: {
        ...base.root,
        component: 'Deployment:shop/api',
        entity: { cluster_id: 'test', kind: 'Deployment', namespace: 'shop', name: 'api', uid: null },
      },
      candidates: [],
      components: ['Deployment:shop/api', 'Deployment:shop/web'],
    };
    const late = T0 + 6 * 60 * MIN;
    const run = await evidence.run(
      inc,
      [alert(1, 'api', T0), alert(2, 'api', late), alert(3, 'web', T0 + 5 * MIN)],
      AbortSignal.timeout(60_000),
      NOW,
    );
    const of = (name: string) => run.cards.filter((c) => c.entity?.name === name);
    expect(of('api').length).toBeGreaterThan(0);
    expect(of('web').length).toBeGreaterThan(0);
    // 事件持续 8 小时，评估时刻晚于锚定窗口的终点：窗口终点都取评估时刻（ADR 0149）
    expect([...windowTo(run.cards, 'api'), ...windowTo(run.cards, 'web')].every((t) => t === NOW)).toBe(true);
    // 起点仍在各自的锚点之前：api 按升级的告警重新锚定，web 按首次触发
    for (const c of of('api')) {
      expect(Date.parse(c.window.from)).toBeLessThan(late);
      expect(Date.parse(c.window.from)).toBeGreaterThan(T0);
    }
    for (const c of of('web')) {
      expect(Date.parse(c.window.from)).toBeLessThan(T0);
    }
  }, 120_000);
});

/**
 * 长期事件（#13 第 3 项，ADR 0149）：CCHP 的 PDB 事件首次触发在 13 天前，kube_poddisruptionbudget_* 指标 11 天前才开始。
 * 卡片窗口锚在首次触发时窗口里没有任何样本，PDB 的卡全部无法判定，处置变成观测失明。
 */
describe('长期事件的卡片窗口', () => {
  const DAY = 24 * 60 * MIN;
  const FIRST = NOW - 13 * DAY;
  const METRIC_FROM = NOW - 11 * DAY;
  let tsdb: TsdbInstance;
  let rt: PackRuntime;
  let source: EvidenceSource;

  const series = (name: string, v: number) => ({
    labels: { __name__: name, namespace: 'shop', poddisruptionbudget: 'api' },
    points: Array.from({ length: Math.floor((NOW - METRIC_FROM) / (10 * MIN)) + 1 }, (_, i) => ({
      t: METRIC_FROM + i * 10 * MIN,
      v,
    })),
  });

  beforeAll(async () => {
    tsdb = await startPrometheus([
      series('kube_poddisruptionbudget_status_pod_disruptions_allowed', 0),
      series('kube_poddisruptionbudget_status_desired_healthy', 2),
      series('kube_poddisruptionbudget_status_current_healthy', 2),
    ]);
    rt = await PackRuntime.load({
      dirs: [PACKS],
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
  }, 120_000);

  afterAll(async () => {
    await tsdb?.stop();
  });

  const pdbIncident = (): Incident => {
    const base = incident();
    const entity = { cluster_id: 'test', kind: 'PodDisruptionBudget', namespace: 'shop', name: 'api', uid: null };
    return {
      ...base,
      first_firing_at: new Date(FIRST).toISOString(),
      root: { ...base.root, component: 'PodDisruptionBudget:shop/api', entity },
      candidates: [],
      components: ['PodDisruptionBudget:shop/api'],
    };
  };
  const pdbAlert = (): Alert => ({
    ...alert(9, 'api', FIRST),
    alertname: 'KubePdbNotEnoughHealthyPods',
    labels: { alertname: 'KubePdbNotEnoughHealthyPods', namespace: 'shop', poddisruptionbudget: 'api' },
    entity: { cluster_id: 'test', kind: 'PodDisruptionBudget', namespace: 'shop', name: 'api', uid: null },
    component: 'PodDisruptionBudget:shop/api',
  });
  const evidenceWith = (o: { maxCardWindowMs?: number; metricsRetentionMs?: number }) =>
    new PackEvidence(
      rt,
      source,
      async () => null,
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 5_000, ...o },
      metrics,
    );
  const pdbCards = (cards: EvidenceResult[]) => cards.filter((c) => c.entity?.kind === 'PodDisruptionBudget');

  it('首次触发在 13 天前、指标 11 天前才开始：窗口为评估时刻之前的 24 小时，PDB 的卡按数据判定，不是观测失明', async () => {
    const run = await evidenceWith({}).run(pdbIncident(), [pdbAlert()], AbortSignal.timeout(60_000), NOW);
    const cards = pdbCards(run.cards);
    expect(cards.map((c) => c.card_id).sort()).toEqual(['workload/pdb/disruptions', 'workload/pod-pending/pdb']);
    for (const c of cards) {
      expect(Date.parse(c.window.to)).toBe(NOW);
      expect(Date.parse(c.window.from)).toBe(NOW - DAY);
      expect(c.verdict).not.toBe('undeterminable');
    }
    expect(cards.find((c) => c.card_id === 'workload/pdb/disruptions')?.verdict).toBe('abnormal');
    expect(cards.find((c) => c.card_id === 'workload/pod-pending/pdb')?.verdict).toBe('normal');
    expect(observabilityBlind(run.cards)).toBe(false);
  }, 120_000);

  it('最大窗口覆盖首次触发时：指标在窗口前段不存在，卡照样按之后的数据判定，不是观测失明；起点不早于数据保留期', async () => {
    const wide = await evidenceWith({ maxCardWindowMs: 30 * DAY }).run(
      pdbIncident(),
      [pdbAlert()],
      AbortSignal.timeout(60_000),
      NOW,
    );
    const cards = pdbCards(wide.cards);
    expect(cards.length).toBe(2);
    for (const c of cards) {
      // 起点是锚点减去 window.before，早于指标出现两天
      expect(Date.parse(c.window.from)).toBeLessThan(METRIC_FROM - DAY);
      expect(Date.parse(c.window.to)).toBe(NOW);
      expect(c.verdict).not.toBe('undeterminable');
    }
    expect(observabilityBlind(wide.cards)).toBe(false);
    const kept = await evidenceWith({ maxCardWindowMs: 30 * DAY, metricsRetentionMs: 7 * DAY }).run(
      pdbIncident(),
      [pdbAlert()],
      AbortSignal.timeout(60_000),
      NOW,
    );
    for (const c of pdbCards(kept.cards)) {
      expect(Date.parse(c.window.from)).toBe(NOW - 7 * DAY);
    }
  }, 120_000);

  it('已恢复的长期事件：窗口终点取恢复时刻', async () => {
    const ended = NOW - 2 * DAY;
    const inc = { ...pdbIncident(), state: 'resolved' as const, ended_at: new Date(ended).toISOString() };
    const run = await evidenceWith({}).run(inc, [pdbAlert()], AbortSignal.timeout(60_000), NOW);
    const cards = pdbCards(run.cards);
    expect(cards.length).toBe(2);
    for (const c of cards) {
      expect(Date.parse(c.window.to)).toBe(ended);
      expect(Date.parse(c.window.from)).toBe(ended - DAY);
    }
  }, 120_000);
});
