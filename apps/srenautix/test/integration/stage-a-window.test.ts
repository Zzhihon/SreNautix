import type { Alert, EvidenceResult, Incident } from '@srenautix/contract';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
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
    const api = windowTo(run.cards, 'api');
    const web = windowTo(run.cards, 'web');
    expect(api.length).toBeGreaterThan(0);
    expect(web.length).toBeGreaterThan(0);
    // api：窗口终点在升级的告警之后（不早于它，不晚于研判时刻）
    expect(api.every((t) => t >= late && t <= NOW)).toBe(true);
    // web：窗口终点在首次触发之后不远处（卡片窗口的 after，默认最多几十分钟）
    expect(web.every((t) => t < late && t > T0)).toBe(true);
  }, 120_000);
});
