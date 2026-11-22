import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Alert, AlertCatalogEntry, EntityRef, EvidenceResult, Incident, LabelProfile } from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import { DatasourceError, loadPromqlEngine } from '@srenautix/integration-sdk';
import type { EvidenceDataSource } from '@srenautix/packs-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { agreeAlerts } from '../../src/eval/agreement.js';
import { ServerMetrics } from '../../src/kernel/metrics.js';
import {
  GENERIC_ALERT_CONDITION_PREFIX,
  genericAlertConditionCardId,
  isGenericAlertConditionCard,
  MAX_GENERIC_ALERT_CONDITIONS,
  runGenericAlertCondition,
} from '../../src/stage-a/alert-condition.js';
import { DEFAULT_NOVELTY } from '../../src/stage-a/novelty.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { evidenceCapabilities, PackRuntime, type EvidenceSource } from '../../src/stage-a/packs.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const CATALOG_PATH = resolve(REPO_ROOT, 'contract/gateway/v1/action-catalog.yaml');
const TMP_ROOT = join(REPO_ROOT, '.scratch', `alert-condition-unit-${process.pid}`);

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const FIRST = NOW - 10 * 60_000;

const PROFILE: LabelProfile = {
  namespace: 'namespace',
  pod: 'pod',
  container: 'container',
  node: 'node',
  cluster: null,
  scrape_interval_seconds: 30,
  tenant: null,
};

function makeEntity(over: Partial<EntityRef> = {}): EntityRef {
  return {
    cluster_id: 'cchp',
    kind: 'Pod',
    namespace: 'cchp-prod',
    name: 'gateway-0',
    uid: 'uid-gw-0',
    ...over,
  };
}

function makeAlert(over: Partial<Alert> = {}): Alert {
  const entity = over.entity === undefined ? makeEntity() : over.entity;
  const alertname = over.alertname ?? 'CchpGatewayHigh5xx';
  return {
    alert_id: `fp-${alertname}@${FIRST / 1000}`,
    cluster_id: 'cchp',
    source: 'alertmanager',
    fingerprint: `fp-${alertname}`,
    alertname,
    labels: {
      alertname,
      namespace: 'cchp-prod',
      pod: 'gateway-0',
      severity: 'warning',
    },
    annotations: {
      summary: 'Gateway 5xx rate elevated',
      description: '5xx exceeded 5% over 5m',
    },
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(FIRST).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: {
      role: 'symptom',
      source: 'catalog',
      confidence: 1,
      catalog_entry: 'testpack/cchp-gateway-high-5xx',
      chronic: false,
    },
    entity,
    entity_resolution: 'informer',
    component: entity ? `${entity.kind}:${entity.namespace}/${entity.name}` : null,
    received_at: new Date(FIRST).toISOString(),
    ...over,
  };
}

function makeEntry(over: Partial<AlertCatalogEntry> = {}): AlertCatalogEntry {
  return {
    id: 'cchp-gateway-high-5xx',
    alertname: 'CchpGatewayHigh5xx',
    category: 'observability',
    role: 'symptom',
    entity: { kind: 'Pod', name_labels: ['pod'] },
    chains: [],
    ...over,
  };
}

function makeIncident(): Incident {
  const key = 'Pod:cchp-prod/gateway-0';
  return {
    incident_id: '0b0c4c1e-7c8e-4d55-9a57-3f1f1c2a9e99',
    cluster_id: 'cchp',
    label: `${key}:generic`,
    incident_version: 1,
    state: 'firing',
    severity: 'warning',
    first_firing_at: new Date(FIRST).toISOString(),
    ended_at: null,
    root: {
      component: key,
      entity: makeEntity(),
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

function mockDataSource(handlers: {
  queryRange?: EvidenceDataSource['queryRange'];
  query?: EvidenceDataSource['query'];
  labelProfile?: LabelProfile | null;
}): EvidenceDataSource {
  return {
    ids: { metrics: 'prom-main', logs: null, traces: null },
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
    metricsDialects: new Set(['promql']),
    labelProfile: handlers.labelProfile === undefined ? PROFILE : handlers.labelProfile,
    logsProfile: null,
    query:
      handlers.query ??
      (async () => ({
        series: [],
        truncated: false,
        warnings: [],
      })),
    queryRange:
      handlers.queryRange ??
      (async () => ({
        series: [],
        truncated: false,
        warnings: [],
      })),
    metricExists: async () => false,
    logsMatch: async () => ({ lines: [], truncated: false }),
    logsQuery: async () => ({ lines: [], truncated: false }),
    tracesSearch: async () => ({ hits: [], truncated: false }),
  };
}

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('genericAlertConditionCardId', () => {
  const CARD_ID_RE = /^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_-]*$/;

  it('生成的卡片 id 全部符合 EvidenceResult.card_id 契约正则', () => {
    for (const raw of [
      'cchp-gateway-high-5xx',
      'CchpGatewayHigh5xx',
      'HTTPServerErrorRate',
      'v1.alert.with.dots',
      '__leading_underscore__',
      '---',
      '',
    ]) {
      const id = genericAlertConditionCardId(raw);
      expect(isGenericAlertConditionCard(id)).toBe(true);
      expect(id.startsWith(GENERIC_ALERT_CONDITION_PREFIX)).toBe(true);
      expect(id).toMatch(CARD_ID_RE);
    }
    expect(isGenericAlertConditionCard('cchp-alerts/foo/condition')).toBe(false);
  });
});

describe('runGenericAlertCondition', () => {
  it('精确标签命中 ALERTS firing 且读取 ALERTS_FOR_STATE 起始时间，结果通过 EvidenceResult schema 校验', async () => {
    const forStateEpochSec = Math.floor((FIRST - 120_000) / 1000);
    const seenRangeExprs: string[] = [];
    const seenInstantExprs: string[] = [];

    const ds = mockDataSource({
      queryRange: async (req) => {
        seenRangeExprs.push(req.expr);
        return {
          series: [
            {
              labels: {
                alertname: 'CchpGatewayHigh5xx',
                alertstate: 'firing',
                namespace: 'cchp-prod',
                pod: 'gateway-0',
              },
              times: [FIRST, FIRST + 60_000, NOW],
              values: [1, 1, 1],
            },
          ],
          truncated: false,
          warnings: [],
        };
      },
      query: async (req) => {
        seenInstantExprs.push(req.expr);
        return {
          series: [
            {
              labels: { alertname: 'CchpGatewayHigh5xx', namespace: 'cchp-prod', pod: 'gateway-0' },
              times: [NOW],
              values: [forStateEpochSec],
            },
          ],
          truncated: false,
          warnings: [],
        };
      },
    });

    const alert = makeAlert();
    const entry = makeEntry();
    const res = await runGenericAlertCondition({
      task: {
        cardId: genericAlertConditionCardId(entry.id),
        alert,
        entry,
        entity: makeEntity(),
        component: 'Pod:cchp-prod/gateway-0',
      },
      anchor: FIRST,
      now: NOW,
      ds,
      locale: 'zh-CN',
      timeoutMs: 5_000,
    });

    expect(res).not.toBeNull();
    const full: EvidenceResult = { ...res!, ref: 'card:1' };
    expect(() => assertValid('schemas/evidence-result.schema.json', full)).not.toThrow();

    expect(seenRangeExprs).toEqual([
      'ALERTS{alertname="CchpGatewayHigh5xx", alertstate="firing", namespace="cchp-prod", pod="gateway-0"}',
    ]);
    expect(seenInstantExprs).toEqual([
      'ALERTS_FOR_STATE{alertname="CchpGatewayHigh5xx", namespace="cchp-prod", pod="gateway-0"}',
    ]);
    expect(full.verdict).toBe('abnormal');
    expect(full.display_state).toBe('abnormal');
    expect(full.anomaly_started_at).toBe(new Date(forStateEpochSec * 1000).toISOString());
    expect(full.reason.text).toContain('Gateway 5xx rate elevated');
    expect(full.reason.text).toContain('5xx exceeded 5% over 5m');
    expect(full.observations).toMatchObject({
      alertname: 'CchpGatewayHigh5xx',
      alertstate: 'firing',
      label_precision: 'scoped',
    });
    expect(full.series).toHaveLength(1);
    expect(full.queries.map((q) => q.name)).toEqual(['alerts', 'alerts_for_state']);
  });

  it('精确标签未命中时回退一次同名 ALERTS 查询并标注精度降级；ALERTS_FOR_STATE 失败时回退到 alert.starts_at', async () => {
    const seenRangeExprs: string[] = [];
    const ds = mockDataSource({
      queryRange: async (req) => {
        seenRangeExprs.push(req.expr);
        if (seenRangeExprs.length === 1) {
          return { series: [], truncated: false, warnings: [] };
        }
        return {
          series: [
            {
              labels: { alertname: 'CchpGatewayHigh5xx', alertstate: 'firing' },
              times: [FIRST, NOW],
              values: [1, 1],
            },
          ],
          truncated: false,
          warnings: [],
        };
      },
      query: async () => {
        throw new DatasourceError('prom-main', 'ALERTS_FOR_STATE unsupported', false);
      },
    });

    const alert = makeAlert();
    const entry = makeEntry();
    const res = await runGenericAlertCondition({
      task: {
        cardId: genericAlertConditionCardId(entry.id),
        alert,
        entry,
        entity: makeEntity(),
        component: 'Pod:cchp-prod/gateway-0',
      },
      anchor: FIRST,
      now: NOW,
      ds,
      locale: 'zh-CN',
      timeoutMs: 5_000,
    });

    const full: EvidenceResult = { ...res!, ref: 'card:1' };
    expect(() => assertValid('schemas/evidence-result.schema.json', full)).not.toThrow();
    expect(seenRangeExprs).toEqual([
      'ALERTS{alertname="CchpGatewayHigh5xx", alertstate="firing", namespace="cchp-prod", pod="gateway-0"}',
      'ALERTS{alertname="CchpGatewayHigh5xx", alertstate="firing"}',
    ]);
    expect(full.verdict).toBe('abnormal');
    expect(full.anomaly_started_at).toBe(alert.starts_at);
    expect(full.reason.text).toContain('未按实体标签精确匹配');
    expect(full.observations).toMatchObject({ label_precision: 'alertname_only' });
  });

  it('无 ALERTS firing 序列时必须判为 undeterminable（绝不误判为 normal）', async () => {
    const ds = mockDataSource({
      queryRange: async () => ({ series: [], truncated: false, warnings: [] }),
    });
    const res = await runGenericAlertCondition({
      task: {
        cardId: genericAlertConditionCardId('cchp-webhook-only'),
        alert: makeAlert({ alertname: 'CchpWebhookOnly' }),
        entry: makeEntry({ id: 'cchp-webhook-only', alertname: 'CchpWebhookOnly' }),
        entity: makeEntity(),
        component: 'Pod:cchp-prod/gateway-0',
      },
      anchor: FIRST,
      now: NOW,
      ds,
      locale: 'zh-CN',
      timeoutMs: 5_000,
    });
    const full: EvidenceResult = { ...res!, ref: 'card:1' };
    expect(() => assertValid('schemas/evidence-result.schema.json', full)).not.toThrow();
    expect(full.verdict).toBe('undeterminable');
    expect(full.display_state).toBe('undeterminable');
    expect(full.reason.kind).toBe('no_data');
  });

  it('数据源报错返回 source_error，缺少 labelProfile 返回 capability_missing', async () => {
    const errDs = mockDataSource({
      queryRange: async () => {
        throw new DatasourceError('prom-main', 'timeout', true);
      },
    });
    const errRes = await runGenericAlertCondition({
      task: {
        cardId: genericAlertConditionCardId('cchp-err'),
        alert: makeAlert(),
        entry: makeEntry({ id: 'cchp-err' }),
        entity: makeEntity(),
        component: null,
      },
      anchor: FIRST,
      now: NOW,
      ds: errDs,
      locale: 'en',
      timeoutMs: 5_000,
    });
    expect(errRes?.verdict).toBe('undeterminable');
    expect(errRes?.reason.kind).toBe('source_error');

    const noProfileDs = mockDataSource({ labelProfile: null });
    const capRes = await runGenericAlertCondition({
      task: {
        cardId: genericAlertConditionCardId('cchp-cap'),
        alert: makeAlert(),
        entry: makeEntry({ id: 'cchp-cap' }),
        entity: makeEntity(),
        component: null,
      },
      anchor: FIRST,
      now: NOW,
      ds: noProfileDs,
      locale: 'en',
      timeoutMs: 5_000,
    });
    expect(capRes?.verdict).toBe('undeterminable');
    expect(capRes?.display_state).toBe('capability_missing');
  });
});

describe('PackEvidence 集成：通用条件卡兜底、上限保护、跳过 novelty 与 agreeAlerts 排除', () => {
  async function buildTestRuntime(): Promise<PackRuntime> {
    const packDir = join(TMP_ROOT, 'packs', 'testpack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'pack.yaml'),
      stringify({
        api_version: 'srenautix.io/pack/v1',
        name: 'testpack',
        version: '0.1.0',
        maturity: 'beta',
        requires: ['metrics.query_range'],
      }),
    );
    writeFileSync(
      join(packDir, 'signals.yaml'),
      stringify({
        signals: [
          {
            id: 'up_sig',
            kind: 'metrics',
            alternatives: [{ expr: 'up{$selector}' }],
          },
        ],
      }),
    );
    writeFileSync(join(packDir, 'components.yaml'), stringify({ component_types: [] }));
    writeFileSync(
      join(packDir, 'chains.yaml'),
      stringify({
        chains: [
          {
            id: 'static-cond',
            title: { 'zh-CN': '静态条件链', en: 'Static condition chain' },
            cards: [
              {
                id: 'condition',
                title: { 'zh-CN': '静态条件', en: 'Static condition' },
                applies_to: { kinds: ['Pod'] },
                refs: [{ name: 'q', signal: 'up_sig', mode: 'range' }],
                judge: {
                  abnormal_if: [{ cel: 'count(q) > 0', say: { 'zh-CN': '命中', en: 'hit' } }],
                },
                display: { value: 'count(q)', unit: 'none' },
                egress: 'allow',
              },
            ],
          },
          {
            id: 'explicit-primary',
            title: { 'zh-CN': '显式主卡链', en: 'Explicit primary chain' },
            cards: [
              {
                id: 'main',
                title: { 'zh-CN': '主卡', en: 'Main card' },
                applies_to: { kinds: ['Pod'] },
                refs: [{ name: 'q', signal: 'up_sig', mode: 'range' }],
                judge: {
                  abnormal_if: [{ cel: 'count(q) > 0', say: { 'zh-CN': '命中', en: 'hit' } }],
                },
                display: { value: 'count(q)', unit: 'none' },
                egress: 'allow',
              },
            ],
          },
        ],
      }),
    );

    const stormEntries = Array.from({ length: MAX_GENERIC_ALERT_CONDITIONS + 5 }, (_, i) => ({
      id: `storm-alert-${i + 1}`,
      alertname: `StormAlert${i + 1}`,
      category: 'observability',
      role: 'symptom',
      entity: { kind: 'Pod', name_labels: ['pod'] },
      chains: [],
    }));
    writeFileSync(
      join(packDir, 'alerts.yaml'),
      stringify({
        entries: [
          {
            id: 'no-primary-alert',
            alertname: 'NoPrimaryAlert',
            category: 'observability',
            role: 'symptom',
            entity: { kind: 'Pod', name_labels: ['pod'] },
            chains: [],
          },
          {
            id: 'with-primary-alert',
            alertname: 'WithPrimaryAlert',
            category: 'observability',
            role: 'cause',
            entity: { kind: 'Pod', name_labels: ['pod'] },
            chains: ['explicit-primary'],
            primary_card: 'explicit-primary/main',
          },
          {
            id: 'with-static-cond-alert',
            alertname: 'WithStaticCondAlert',
            category: 'observability',
            role: 'cause',
            entity: { kind: 'Pod', name_labels: ['pod'] },
            chains: ['static-cond'],
          },
          ...stormEntries,
        ],
      }),
    );

    const rt = await PackRuntime.load({
      dirs: [join(TMP_ROOT, 'packs')],
      only: ['testpack'],
      lockFile: null,
      catalogPath: CATALOG_PATH,
      capabilities: evidenceCapabilities(false),
    });
    expect(rt.failures).toEqual([]);
    return rt;
  }

  it('只为无 primary_card 且无静态 /condition 的非 detector 目录告警合成通用卡，不跑 novelty，且被 agreeAlerts 排除', async () => {
    const rt = await buildTestRuntime();
    const engine = await loadPromqlEngine();
    const ds = mockDataSource({
      queryRange: async (req) => ({
        series: [
          {
            labels: { alertname: 'NoPrimaryAlert', alertstate: 'firing', namespace: 'cchp-prod', pod: 'gateway-0' },
            times: [FIRST, NOW],
            values: [1, 1],
          },
        ],
        truncated: req.expr === '__never__',
        warnings: [],
      }),
    });
    const fakeSource = {
      engine,
      dataSource: async () => ds,
      resolve: async () => new Map([['testpack/up_sig', { index: 0, rejected: [] }]]),
    } as unknown as EvidenceSource;

    const evidence = new PackEvidence(
      rt,
      fakeSource,
      async () => null,
      {
        locale: 'zh-CN',
        concurrency: 4,
        queryTimeoutMs: 5_000,
        novelty: { ...DEFAULT_NOVELTY, enabled: true },
        genericAlertCondition: true,
      },
      new ServerMetrics('server', false),
    );

    const inc = makeIncident();
    const noPrimary = makeAlert({
      alertname: 'NoPrimaryAlert',
      labels: { alertname: 'NoPrimaryAlert', namespace: 'cchp-prod', pod: 'gateway-0' },
      classification: {
        role: 'symptom',
        source: 'catalog',
        confidence: 1,
        catalog_entry: 'testpack/no-primary-alert',
        chronic: false,
      },
    });
    const withPrimary = makeAlert({
      alertname: 'WithPrimaryAlert',
      labels: { alertname: 'WithPrimaryAlert', namespace: 'cchp-prod', pod: 'gateway-0' },
      classification: {
        role: 'cause',
        source: 'catalog',
        confidence: 1,
        catalog_entry: 'testpack/with-primary-alert',
        chronic: false,
      },
    });
    const withStaticCond = makeAlert({
      alertname: 'WithStaticCondAlert',
      labels: { alertname: 'WithStaticCondAlert', namespace: 'cchp-prod', pod: 'gateway-0' },
      classification: {
        role: 'cause',
        source: 'catalog',
        confidence: 1,
        catalog_entry: 'testpack/with-static-cond-alert',
        chronic: false,
      },
    });
    const detectorAlert = makeAlert({
      alertname: 'NoPrimaryAlert',
      source: 'detector',
      labels: {
        alertname: 'NoPrimaryAlert',
        srenautix_detector: 'pod_crash',
        namespace: 'cchp-prod',
        pod: 'gateway-1',
      },
      entity: makeEntity({ name: 'gateway-1' }),
      classification: {
        role: 'symptom',
        source: 'catalog',
        confidence: 1,
        catalog_entry: 'testpack/no-primary-alert',
        chronic: false,
      },
    });

    const run = await evidence.run(
      inc,
      [noPrimary, withPrimary, withStaticCond, detectorAlert],
      new AbortController().signal,
      NOW,
    );
    const genericCards = run.cards.filter((c) => isGenericAlertConditionCard(c.card_id));

    // 只有 no-primary-alert 合成通用条件卡（即使同实体上 with-static-cond-alert 有静态 /condition，也不误跳过另一个告警）
    expect(genericCards.map((c) => c.card_id)).toEqual(['builtin/alert-condition/no-primary-alert']);
    expect(genericCards[0]!.verdict).toBe('abnormal');
    // 绝不跑 novelty 基线
    expect(genericCards[0]!.novelty).toBeUndefined();
    expect(() => assertValid('schemas/evidence-result.schema.json', genericCards[0]!)).not.toThrow();

    // eval/agreement 排除合成通用条件卡，不将其算作主卡或链级异常印证
    const agreement = agreeAlerts(rt, [noPrimary], genericCards);
    expect(agreement).toEqual([
      expect.objectContaining({
        alertname: 'NoPrimaryAlert',
        primary_card: null,
        primary: 'undeclared',
        chain: 'no_card',
      }),
    ]);

    // 关闭开关时不再合成任何通用条件卡
    const offEvidence = new PackEvidence(
      rt,
      fakeSource,
      async () => null,
      { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 5_000, genericAlertCondition: false },
      new ServerMetrics('server', false),
    );
    const offRun = await offEvidence.run(inc, [noPrimary], new AbortController().signal, NOW);
    expect(offRun.cards.filter((c) => isGenericAlertConditionCard(c.card_id))).toEqual([]);

    // 告警风暴下最多合成 MAX_GENERIC_ALERT_CONDITIONS (15) 个不同 alertname
    const stormAlerts = Array.from({ length: MAX_GENERIC_ALERT_CONDITIONS + 5 }, (_, i) =>
      makeAlert({
        alertname: `StormAlert${i + 1}`,
        labels: { alertname: `StormAlert${i + 1}`, namespace: 'cchp-prod', pod: 'gateway-0' },
        classification: {
          role: 'symptom',
          source: 'catalog',
          confidence: 1,
          catalog_entry: `testpack/storm-alert-${i + 1}`,
          chronic: false,
        },
      }),
    );
    const stormRun = await evidence.run(inc, stormAlerts, new AbortController().signal, NOW);
    const stormGeneric = stormRun.cards.filter((c) => isGenericAlertConditionCard(c.card_id));
    expect(stormGeneric).toHaveLength(MAX_GENERIC_ALERT_CONDITIONS);
  }, 30_000);
});
