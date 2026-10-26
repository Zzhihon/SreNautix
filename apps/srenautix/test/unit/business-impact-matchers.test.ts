import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { isBusinessImpact, matchersText, matchesAlert } from '../../src/alerts/business-impact.js';
import { parseServerConfig, upgradeRaw } from '../../src/config/server.js';
import { loadEvalConfig } from '../../src/eval/config.js';

// 业务影响告警的统一匹配器（ADR 0166）：labels 全部满足、exclude_labels 一个都不满足；任一项满足即为业务影响告警。
// notify.digest.external_roots.business_impact.alert_labels 与标签条件本身的旧项转换为匹配器，并给出弃用说明

const CCHP = {
  labels: { layer: ['L0', 'L1', 'L2'], severity: ['critical'] },
  exclude_labels: { component: ['provider'] },
};

const minimal = (notify: Record<string, unknown>) => ({
  cluster_id: 'c1',
  profile: 'observe',
  public_url: 'https://srenautix.example.com',
  ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }] },
  datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
  packs: { dirs: ['/packs'] },
  callers: { tokens_file: '/callers.yaml' },
  identity: { bindings_dir: '/bindings' },
  audit: { checkpoint_key_file: '/checkpoint.pem' },
  notify,
});

describe('匹配器', () => {
  it('L0–L2 的 critical，排除 provider 组件', () => {
    expect(matchesAlert({ layer: 'L1', severity: 'critical', component: 'gateway' }, CCHP)).toBe(true);
    expect(matchesAlert({ layer: 'L1', severity: 'critical', component: 'provider' }, CCHP)).toBe(false);
    expect(matchesAlert({ layer: 'L1', severity: 'critical' }, CCHP)).toBe(true);
    expect(matchesAlert({ layer: 'L3', severity: 'critical' }, CCHP)).toBe(false);
    expect(matchesAlert({ layer: 'L0', severity: 'warning' }, CCHP)).toBe(false);
    expect(matchesAlert({ severity: 'critical' }, CCHP)).toBe(false);
  });

  it('排除的多个标签任一个命中即排除；任一项满足即为业务影响告警；没有匹配器时没有业务影响告警', () => {
    const m = { labels: { severity: ['critical'] }, exclude_labels: { component: ['provider'], theme: ['provider'] } };
    expect(matchesAlert({ severity: 'critical', theme: 'provider' }, m)).toBe(false);
    expect(matchesAlert({ severity: 'critical', theme: 'storage' }, m)).toBe(true);
    const two = [CCHP, { labels: { component: ['release'] }, exclude_labels: {} }];
    expect(isBusinessImpact({ component: 'release', severity: 'warning' }, two)).toBe(true);
    expect(isBusinessImpact({ component: 'provider', layer: 'L0', severity: 'critical' }, two)).toBe(false);
    expect(isBusinessImpact({ severity: 'critical' }, [])).toBe(false);
  });

  it('文字形式与语言无关', () => {
    expect(matchersText([CCHP, { labels: { component: ['release'] }, exclude_labels: {} }])).toBe(
      'layer=L0|L1|L2,severity=critical,component!=provider / component=release',
    );
    expect(matchersText([])).toBe('');
  });
});

describe('server 配置', () => {
  it('默认没有业务影响告警', () => {
    expect(parseServerConfig(minimal({})).notify.business_impact_alerts).toEqual([]);
  });

  it('新写法原样生效，exclude_labels 默认为空', () => {
    const c = parseServerConfig(minimal({ business_impact_alerts: [CCHP, { labels: { component: ['release'] } }] }));
    expect(c.notify.business_impact_alerts).toEqual([CCHP, { labels: { component: ['release'] }, exclude_labels: {} }]);
    expect(upgradeRaw(minimal({ business_impact_alerts: [CCHP] })).deprecated).toEqual([]);
  });

  it('只给出 external_roots.business_impact.alert_labels 时转换为匹配器并给出弃用说明，不再隐含 critical', () => {
    const raw = minimal({
      digest: { external_roots: { business_impact: { alert_labels: { layer: ['L0'] }, within: '15m' } } },
    });
    const up = upgradeRaw(raw);
    expect(up.deprecated).toHaveLength(1);
    expect(up.deprecated[0]).toMatch(/notify\.digest\.external_roots\.business_impact\.alert_labels 已弃用/);
    const c = parseServerConfig(raw);
    expect(c.notify.business_impact_alerts).toEqual([{ labels: { layer: ['L0'] }, exclude_labels: {} }]);
    expect(c.notify.digest.external_roots.business_impact).toEqual({
      impact_cards: true,
      within: '15m',
      topology_hops: 6,
    });
  });

  it('两处都给出时以 notify.business_impact_alerts 为准，旧键不生效并给出说明；空的旧键没有说明', () => {
    const raw = minimal({
      business_impact_alerts: [CCHP],
      digest: { external_roots: { business_impact: { alert_labels: { layer: ['L0'] } } } },
    });
    expect(upgradeRaw(raw).deprecated).toEqual([
      'notify.digest.external_roots.business_impact.alert_labels 已弃用，同时给出了 notify.business_impact_alerts，notify.digest.external_roots.business_impact.alert_labels 不生效',
    ]);
    expect(parseServerConfig(raw).notify.business_impact_alerts).toEqual([CCHP]);
    const empty = minimal({ digest: { external_roots: { business_impact: { alert_labels: {} } } } });
    expect(upgradeRaw(empty).deprecated).toEqual([]);
    expect(parseServerConfig(empty).notify.business_impact_alerts).toEqual([]);
  });

  it('标签条件本身的项（ADR 0159 的写法）转换为 {labels}，并给出弃用说明', () => {
    const raw = minimal({ business_impact_alerts: [{ severity: ['critical'] }, CCHP] });
    const up = upgradeRaw(raw);
    expect(up.deprecated).toHaveLength(1);
    expect(up.deprecated[0]).toMatch(/notify\.business_impact_alerts 的项 \{"severity":\["critical"\]\} 是旧写法/);
    expect(parseServerConfig(raw).notify.business_impact_alerts).toEqual([
      { labels: { severity: ['critical'] }, exclude_labels: {} },
      CCHP,
    ]);
  });

  it('labels 为空或多出未知键时配置不合法', () => {
    expect(() => parseServerConfig(minimal({ business_impact_alerts: [{ labels: {} }] }))).toThrow(
      /labels 至少要有一个标签/,
    );
    expect(() =>
      parseServerConfig(minimal({ business_impact_alerts: [{ labels: { a: ['b'] }, exclude: { c: ['d'] } }] })),
    ).toThrow(/server 配置不合法/);
  });
});

describe('评测配置', () => {
  const dir = resolve(import.meta.dirname, '../../../../.scratch/unit-business-impact');
  const write = (name: string, reconstruct: Record<string, unknown>): string => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(
      p,
      stringify({
        routes: [
          {
            id: 'primary',
            base_url: 'https://llm.example.com/v1',
            api: 'responses',
            model: 'm',
            dialect_profile: 'openai-responses',
            price: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
            failure_domain: [],
            in_domain: false,
            tier: 'large',
            retention_terms: 't',
            api_key_env: 'K',
          },
        ],
        reconstruct: {
          cluster_id: 'c',
          metrics: { url: 'http://127.0.0.1:9' },
          packs: { dirs: ['/p'] },
          ...reconstruct,
        },
      }),
    );
    return p;
  };

  it('弃用的 business_impact_labels 转换为 business_impact_alerts；新写法原样生效', () => {
    const legacy = loadEvalConfig(write('legacy.yaml', { business_impact_labels: { layer: ['L0'] } }), { K: 'k' });
    expect(legacy.reconstruct?.business_impact_alerts).toEqual([{ labels: { layer: ['L0'] }, exclude_labels: {} }]);
    const fresh = loadEvalConfig(write('fresh.yaml', { business_impact_alerts: [CCHP] }), { K: 'k' });
    expect(fresh.reconstruct?.business_impact_alerts).toEqual([CCHP]);
  });
});
