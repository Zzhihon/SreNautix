import type { Alert, EvidenceResult } from '@srenautix/contract';
import {
  compilePackSet,
  loadActionCatalog,
  loadBuiltinPacks,
  loadPackDir,
  type PackSet,
  type RemediationContext,
} from '@srenautix/packs-sdk';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { matchTemplates, remediationContext } from '../../src/remediation/facts.js';
import { deriveDisposition } from '../../src/research/disposition.js';
import { incidentBook } from '../../src/research/incident.js';
import { PACKS } from '../support/packs.js';
import { incident, researchCase, stageA } from '../support/scenario.js';

// Kind 的 alert-too-sensitive（ADR 0139）：api 的 db-check 容器重启一次，critical 的 ShopPodRestarted 立即触发，业务不受影响。
// 阶段 A 的卡取自 kind-e2e 39719813915（48747db）的 stage-a-cards.tsv：重启、未就绪、容器等待与 spec 变更判为异常，
// web 的限流异常，api 的内存卡无法判定。那次运行 shop 没有任何影响卡，处置推导没有 ignore 的依据，noisy-alert-relax 不适用；
// kind-shop 包的 traffic/client-errors（外部客户端经 web 访问 api 的请求失败比例）在 api 与 web 上正常之后，处置为 ignore，
// noisy-alert-relax 适用，并且没有别的模板适用。

const ROOT = 'Deployment:shop/api';
const POD = 'api-5b7bb87bc4-848gs';
const T = '2026-10-22T04:12:11.900Z';
const KIND_SHOP = resolve(import.meta.dirname, '../../../../deploy/kind/gitops/srenautix/packs/kind-shop');

type Row = [
  card: string,
  kind: string,
  name: string,
  verdict: EvidenceResult['verdict'],
  observations?: Record<string, number>,
];

// 39719813915 的 30 张卡（incident 2bcb16b6，版本 1）
const ROWS: Row[] = [
  ['workload/pod-pending/init-stuck', 'Deployment', 'api', 'normal'],
  ['workload/pod-pending/init-stuck', 'Deployment', 'web', 'normal'],
  ['workload/pod-pending/init-stuck', 'Pod', POD, 'normal'],
  ['workload/pod-pending/pending', 'Pod', POD, 'normal'],
  ['workload/pod-pending/pending', 'Deployment', 'web', 'normal'],
  ['workload/pod-pending/pending', 'Deployment', 'api', 'normal'],
  ['workload/pod-pending/waiting', 'Deployment', 'web', 'normal'],
  ['workload/pod-pending/waiting', 'Deployment', 'api', 'abnormal'],
  ['workload/pod-pending/waiting', 'Pod', POD, 'normal'],
  ['workload/pod-restarts/memory', 'Pod', POD, 'undeterminable'],
  ['workload/pod-restarts/memory', 'Deployment', 'api', 'undeterminable'],
  ['workload/pod-restarts/memory', 'Deployment', 'web', 'normal'],
  ['workload/pod-restarts/readiness', 'Deployment', 'api', 'abnormal'],
  ['workload/pod-restarts/readiness', 'Deployment', 'web', 'abnormal'],
  ['workload/pod-restarts/readiness', 'Pod', POD, 'normal'],
  ['workload/pod-restarts/restarts', 'Deployment', 'api', 'abnormal'],
  ['workload/pod-restarts/restarts', 'Deployment', 'web', 'normal'],
  ['workload/pod-restarts/restarts', 'Pod', POD, 'abnormal'],
  ['workload/pod-restarts/throttling', 'Deployment', 'web', 'abnormal'],
  ['workload/pod-restarts/throttling', 'Pod', POD, 'normal'],
  ['workload/pod-restarts/throttling', 'Deployment', 'api', 'normal'],
  ['workload/release/init-waiting', 'Deployment', 'api', 'normal'],
  ['workload/release/init-waiting', 'Pod', POD, 'normal'],
  ['workload/release/migration-jobs', 'Deployment', 'api', 'normal'],
  ['workload/release/migration-jobs', 'Pod', POD, 'normal'],
  ['workload/release/replicasets', 'Deployment', 'api', 'normal'],
  ['workload/release/serving-versions', 'Pod', POD, 'normal'],
  ['workload/release/serving-versions', 'Deployment', 'api', 'normal'],
  // 只因 spec 变更判为异常：窗口结束时没有不可用的副本
  ['workload/rollout/deployment', 'Deployment', 'api', 'abnormal', { missing: 0, specChanges: 1 }],
  ['workload/rollout/deployment', 'Deployment', 'web', 'normal', { missing: 0, specChanges: 0 }],
];

// kind-shop 包的影响卡：外部客户端的请求在窗口内全部成功
const IMPACT: Row[] = [
  ['kind-shop/traffic/client-errors', 'Deployment', 'api', 'normal', { peak: 0 }],
  ['kind-shop/traffic/client-errors', 'Deployment', 'web', 'normal', { peak: 0 }],
];

function result([card, kind, name, verdict, observations]: Row, i: number): EvidenceResult {
  return {
    ref: `card:${i + 1}`,
    card_id: card,
    title: { 'zh-CN': card, en: card },
    threshold: null,
    series: [],
    entity: { cluster_id: 'kind', kind, namespace: 'shop', name, uid: null },
    window: { from: '2026-10-22T03:41:48.521Z', to: T },
    verdict,
    display_state: verdict,
    reason: {
      kind: verdict === 'undeterminable' ? 'source_error' : verdict === 'abnormal' ? 'rule' : 'all_clear',
      text: verdict,
    },
    value: null,
    table: null,
    queries: [],
    egress: 'allow',
    anomaly_started_at: null,
    evaluated_at: T,
    ...(observations ? { observations } : {}),
    ...(card === 'kind-shop/traffic/client-errors' ? { impact: true } : {}),
  };
}

const ALERT = {
  alert_id: 'c9da744155007574@1792642308',
  alertname: 'ShopPodRestarted',
  labels: { alertname: 'ShopPodRestarted', severity: 'critical', namespace: 'shop', pod: POD, container: 'db-check' },
  annotations: { summary: `shop 的 ${POD} 在 5 分钟内重启过` },
  classification: {
    role: 'symptom',
    source: 'catalog',
    confidence: 1,
    catalog_entry: 'kind-shop/shop-pod-restarted',
    chronic: false,
  },
  component: ROOT,
  entity: { cluster_id: 'kind', kind: 'Pod', namespace: 'shop', name: POD, uid: null },
} as unknown as Alert;

const ROOT_ENTITY: RemediationContext['root'] = {
  cluster_id: 'kind',
  kind: 'Deployment',
  namespace: 'shop',
  name: 'api',
  node: null,
  component_type: 'shop.api',
  external: false,
};

function inc() {
  const base = incident();
  return {
    ...base,
    severity: 'critical' as const,
    root: {
      ...base.root,
      component: ROOT,
      entity: { cluster_id: 'kind', kind: 'Deployment', namespace: 'shop', name: 'api', uid: null },
    },
    components: [ROOT],
  };
}

/** 研判按代码推导的处置（模型的录制给出 ignore，没有提议），再按它匹配模板；返回处置与适用的模板 */
function run(set: PackSet, rows: Row[], root = ROOT_ENTITY) {
  const cards = rows.map(result);
  const s = stageA(cards);
  const book = incidentBook(researchCase({ incident: inc(), stageA: s }));
  const d = deriveDisposition({
    model: 'ignore',
    incident: inc(),
    stageA: s,
    level: 'likely',
    root: ROOT,
    ruleSupport: 0,
    proposals: 0,
    cards: book.allCards,
    facts: { external: [], remediations: [] },
  });
  // 根因自己的卡：api 与它的 Pod
  const own = cards.filter((c) => c.entity?.name === 'api' || c.entity?.name === POD);
  const facts = new Map([[ALERT.alert_id, { component_object: ROOT, external: false }]]);
  const ctx = remediationContext(
    inc(),
    [ALERT],
    cards,
    root,
    { disposition: d.disposition, level: 'likely' },
    own,
    facts,
  );
  return { disposition: d, templates: matchTemplates(set, ctx).map((t) => t.key) };
}

describe('alert-too-sensitive 的卡片组合', () => {
  let set: PackSet;
  beforeAll(async () => {
    const catalog = loadActionCatalog(resolve(PACKS, '../contract/gateway/v1/action-catalog.yaml'));
    set = await compilePackSet([...loadBuiltinPacks(PACKS), loadPackDir(KIND_SHOP, 'kind')], { catalog });
  });

  it('39719813915：shop 没有影响卡，处置推导没有 ignore 的依据，noisy-alert-relax 不适用', () => {
    const r = run(set, ROWS);
    expect(r.disposition).toMatchObject({ disposition: 'escalate', basis: null });
    expect(r.disposition.notes[0]).toMatch(/没有确定性依据/);
    expect(r.templates).not.toContain('gitops/noisy-alert-relax');
  });

  it('影响卡在 api 与 web 上正常：处置为 ignore，只有 noisy-alert-relax 适用', () => {
    const r = run(set, [...ROWS, ...IMPACT]);
    expect(r.disposition).toMatchObject({ disposition: 'ignore', basis: 'impact_normal', templates: [] });
    expect(r.templates).toEqual(['gitops/noisy-alert-relax']);
  });

  it('外部客户端的请求失败（影响卡异常）时不是 ignore，也不降级告警', () => {
    const failing = IMPACT.map(([c, k, n]): Row => [c, k, n, 'abnormal', { peak: 0.31 }]);
    const r = run(set, [...ROWS, ...failing]);
    expect(r.disposition.disposition).toBe('escalate');
    expect(r.templates).not.toContain('gitops/noisy-alert-relax');
  });

  it('根因是集群外部组件时，影响卡正常也不降级（#10 修掉的误触发不回来）', () => {
    const r = run(set, [...ROWS, ...IMPACT], { ...ROOT_ENTITY!, kind: 'provider', namespace: null, external: true });
    expect(r.templates).not.toContain('gitops/noisy-alert-relax');
  });
});
