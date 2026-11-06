import type { AlertCatalogEntry, AlertCategory } from '@srenautix/contract';
import { AlertCatalog, classifyAlert } from '@srenautix/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { categoryOptions } from '../../src/alerts/category.js';
import type { HealthState, ObjectHealth } from '../../src/detectors/health.js';
import {
  DEFAULT_EQUIVALENTS,
  DETECTOR_ALERTS,
  DETECTOR_CATEGORIES,
  findingAlert,
  type DetectorSettings,
} from '../../src/detectors/service.js';
import { categoryInputsFingerprint } from '../../src/incident/recategorize.js';
import { ServerMetrics } from '../../src/metrics.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackRuntime } from '../../src/stage-a/packs.js';
import { PACKS } from '../support/packs.js';

// 检测器合成告警的内置类别表（ADR 0183 §2.1）：6 个告警的类别、与 alerts-kps 里等价告警的类别一致（pdb_blocking 例外）、
// 领域包的目录条目优先、进入类别解析输入的指纹。

const STATES = Object.keys(DETECTOR_ALERTS) as HealthState[];
const NOW = Date.parse('2026-10-20T17:00:00Z');
const settings: DetectorSettings = {
  namespaces: ['*'],
  excludeNamespaces: [],
  thresholdsMs: Object.fromEntries(STATES.map((st) => [st, 0])),
  severity: 'warning',
  equivalentAlerts: DEFAULT_EQUIVALENTS,
};

let rt: PackRuntime;

beforeAll(async () => {
  rt = await PackRuntime.load({
    dirs: [PACKS],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
  });
});

const KIND: Readonly<Record<HealthState, string>> = {
  pod_pending: 'Pod',
  pod_init: 'Pod',
  crash_loop: 'Pod',
  rollout_stalled: 'Deployment',
  pdb_blocking: 'PodDisruptionBudget',
  job_failed: 'Job',
};

/** 检测器按状态合成的告警的标签（真实的 findingAlert） */
function synthesized(state: HealthState): Record<string, string> {
  const h: ObjectHealth = {
    key: `${KIND[state]}:shop/api`,
    kind: KIND[state],
    namespace: 'shop',
    name: 'api',
    uid: null,
    state,
    since: new Date(NOW - 60_000).toISOString(),
    reason: 'Test',
    message: '',
    owner: null,
  };
  return findingAlert('c1', h, settings, NOW)!.labels;
}

describe('检测器合成告警的类别（ADR 0183 §2.1）', () => {
  it('仓库自带的包加上 server 的类别选项：6 个合成告警都有类别，来源为 builtin，没有目录条目', () => {
    const catalog = rt.alertCatalog(categoryOptions([], new ServerMetrics('server', false)));
    const got = Object.fromEntries(
      STATES.map((st) => {
        const c = classifyAlert({ labels: synthesized(st), chronic: false }, catalog);
        return [DETECTOR_ALERTS[st], [c.category, c.category_source, c.catalog_entry]];
      }),
    );
    expect(got).toEqual({
      SreNautixPodPending: ['availability', 'builtin', null],
      SreNautixPodInitStuck: ['availability', 'builtin', null],
      SreNautixCrashLoop: ['availability', 'builtin', null],
      SreNautixRolloutStalled: ['availability', 'builtin', null],
      SreNautixPdbBlockingEviction: ['platform', 'builtin', null],
      SreNautixJobFailed: ['availability', 'builtin', null],
    });
    // 告警清理掉之后只按告警名求类别，结果相同
    for (const st of STATES) {
      expect(catalog.category({ alertname: DETECTOR_ALERTS[st] })).toEqual({
        category: DETECTOR_CATEGORIES[st],
        source: 'builtin',
      });
    }
  });

  it('每个状态的类别与它在 alerts-kps 里的等价告警相同，pdb_blocking 例外', () => {
    const catalog = rt.alertCatalog();
    const kps = Object.fromEntries(
      STATES.map((st) => {
        const cats = DEFAULT_EQUIVALENTS[st].flatMap((name) => {
          const hit = catalog.lookup({ alertname: name });
          return hit?.pack === 'alerts-kps' ? [hit.entry.category!] : [];
        });
        return [st, [...new Set(cats)]];
      }),
    ) as Record<HealthState, AlertCategory[]>;
    // 每个状态至少有一个等价告警登记在 alerts-kps 里，并且同一状态的等价告警类别相同
    for (const st of STATES) {
      expect(kps[st], st).toHaveLength(1);
    }
    const exceptions: Partial<Record<HealthState, AlertCategory>> = { pdb_blocking: 'platform' };
    expect(Object.fromEntries(STATES.map((st) => [st, DETECTOR_CATEGORIES[st]]))).toEqual(
      Object.fromEntries(STATES.map((st) => [st, exceptions[st] ?? kps[st][0]])),
    );
    expect(kps.pdb_blocking).toEqual(['availability']);
  });

  it('领域包给检测器告警名登记条目并声明类别时以目录为准；标签仍然优先；规则不覆盖内置类别表', () => {
    const override: AlertCatalogEntry = {
      id: 'pdb-blocking-eviction',
      alertname: 'SreNautixPdbBlockingEviction',
      role: 'cause',
      category: 'availability',
      entity: { kind: 'PodDisruptionBudget', name_labels: ['poddisruptionbudget'] },
    };
    const options = categoryOptions(
      [{ labels: { namespace: ['shop'] }, exclude_labels: {}, category: 'performance' }],
      new ServerMetrics('server', false),
    );
    const catalog = new AlertCatalog([{ pack: 'site', entries: [override] }], options);
    const of = (labels: Record<string, string>) => {
      const c = classifyAlert({ labels, chronic: false }, catalog);
      return [c.category, c.category_source];
    };
    expect(of(synthesized('pdb_blocking'))).toEqual(['availability', 'catalog']);
    expect(of(synthesized('crash_loop'))).toEqual(['availability', 'builtin']);
    expect(of(synthesized('rollout_stalled'))).toEqual(['availability', 'builtin']);
    expect(of({ ...synthesized('job_failed'), srenautix_category: 'observability' })).toEqual([
      'observability',
      'label',
    ]);
    // 合成告警本身不带 srenautix_category 标签
    expect(STATES.filter((st) => 'srenautix_category' in synthesized(st))).toEqual([]);
  });

  it('内置类别表进入类别解析输入：带与不带这张表的目录指纹不同', () => {
    const metrics = new ServerMetrics('server', false);
    const withTable = rt.alertCatalog(categoryOptions([], metrics));
    const without = rt.alertCatalog({ categoryRules: [] });
    expect(withTable.categoryInputs().builtin).toEqual(
      STATES.map((st) => ({ alertname: DETECTOR_ALERTS[st], category: DETECTOR_CATEGORIES[st] })).sort((a, b) =>
        a.alertname < b.alertname ? -1 : 1,
      ),
    );
    expect(categoryInputsFingerprint(withTable)).not.toBe(categoryInputsFingerprint(without));
    expect(categoryInputsFingerprint(rt.alertCatalog(categoryOptions([], metrics)))).toBe(
      categoryInputsFingerprint(withTable),
    );
  });
});
