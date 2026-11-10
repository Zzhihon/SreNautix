import type { Incident } from '@srenautix/contract';
import { AlertCatalog, classifyAlert } from '@srenautix/core';
import { describe, expect, it } from 'vitest';
import { categoryOptions } from '../../src/alerts/category.js';
import { HttpError } from '../../src/kernel/errors.js';
import { parseServerConfig } from '../../src/config/server.js';
import {
  classificationConditions,
  parseClassificationFilters,
  rowCategories,
} from '../../src/console-bff/incident-filters.js';
import type { IncidentRow } from '../../src/incident/read.js';
import { classificationInputsFingerprint } from '../../src/incident/recategorize.js';
import { ServerMetrics } from '../../src/kernel/metrics.js';
import { PackRuntime } from '../../src/stage-a/packs.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PACKS } from '../support/packs.js';

const minimal = (ingest: Record<string, unknown>) => ({
  cluster_id: 'c1',
  profile: 'observe',
  public_url: 'https://srenautix.example.com',
  ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }], ...ingest },
  datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
  packs: { dirs: ['/packs'] },
  callers: { tokens_file: '/callers.yaml' },
  identity: { bindings_dir: '/bindings' },
  audit: { checkpoint_key_file: '/checkpoint.pem' },
});

const rejects = (fn: () => unknown, text: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    expect((e as Error).message).toContain(text);
    return;
  }
  throw new Error('应当返回 400');
};

describe('ingest.category_rules（ADR 0183）', () => {
  it('默认为空；每项是匹配器加 category，exclude_labels 默认为空', () => {
    expect(parseServerConfig(minimal({})).ingest.category_rules).toEqual([]);
    const c = parseServerConfig(
      minimal({
        category_rules: [
          { labels: { component: ['provider'] }, category: 'provider' },
          { labels: { layer: ['L0'] }, exclude_labels: { team: ['infra'] }, category: 'availability' },
        ],
      }),
    );
    expect(c.ingest.category_rules).toEqual([
      { labels: { component: ['provider'] }, exclude_labels: {}, category: 'provider' },
      { labels: { layer: ['L0'] }, exclude_labels: { team: ['infra'] }, category: 'availability' },
    ]);
  });

  it('类别不在枚举里、unclassified、labels 为空或有未知键时配置不合法', () => {
    for (const rule of [
      { labels: { layer: ['L0'] }, category: 'latency' },
      { labels: { layer: ['L0'] }, category: 'unclassified' },
      { labels: {}, category: 'platform' },
      { labels: { layer: ['L0'] }, category: 'platform', id: 'x' },
      { labels: { layer: ['L0'] } },
    ]) {
      expect(() => parseServerConfig(minimal({ category_rules: [rule] }))).toThrow();
    }
  });

  it('内置包的目录先于规则，规则只给没有声明类别的告警；非法标签计入指标并忽略', async () => {
    const rt = await PackRuntime.load({
      dirs: [PACKS],
      only: null,
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
    });
    const metrics = new ServerMetrics('server', false);
    const rules = parseServerConfig(
      minimal({ category_rules: [{ labels: { team: ['shop'] }, category: 'availability' }] }),
    ).ingest.category_rules;
    const catalog = rt.alertCatalog(categoryOptions(rules, metrics));
    const of = (labels: Record<string, string>) => {
      const c = classifyAlert({ labels, chronic: false }, catalog);
      return [c.category, c.category_source];
    };
    expect(of({ alertname: 'KubeHpaMaxedOut', team: 'shop' })).toEqual(['performance', 'catalog']);
    expect(of({ alertname: 'KubeNodeNotReady' })).toEqual(['platform', 'catalog']);
    expect(of({ alertname: 'TargetDown' })).toEqual(['observability', 'catalog']);
    expect(of({ alertname: 'ShopCheckoutErrors', team: 'shop' })).toEqual(['availability', 'rule']);
    expect(of({ alertname: 'ShopCheckoutErrors' })).toEqual(['unclassified', 'default']);
    expect(of({ alertname: 'KubePodCrashLooping', srenautix_category: 'oops' })).toEqual(['availability', 'catalog']);
    expect(of({ alertname: 'KubePodCrashLooping', srenautix_category: 'oops' })).toEqual(['availability', 'catalog']);
    const counted = await metrics.alertCategoryLabelInvalid.get();
    expect(counted.values).toEqual([{ labels: { alertname: 'KubePodCrashLooping' }, value: 2 }]);
  });

  it('类别解析输入的指纹：同样的包与规则相同，规则或条目的类别变化时不同', async () => {
    const load = () =>
      PackRuntime.load({
        dirs: [PACKS],
        only: null,
        lockFile: null,
        catalogPath: DEFAULT_CATALOG_PATH,
        capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
      });
    const metrics = new ServerMetrics('server', false);
    const rules = parseServerConfig(
      minimal({ category_rules: [{ labels: { team: ['shop'] }, category: 'availability' }] }),
    ).ingest.category_rules;
    const a = (await load()).alertCatalog(categoryOptions(rules, metrics));
    const b = (await load()).alertCatalog(categoryOptions(rules, metrics));
    const base = classificationInputsFingerprint(a);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(classificationInputsFingerprint(b)).toBe(base);
    expect(classificationInputsFingerprint((await load()).alertCatalog(categoryOptions([], metrics)))).not.toBe(base);
    // 只保留决定类别的字段、放进一个包重建目录：指纹不变；改掉一个条目的类别：指纹变化
    const entries = a.categoryInputs().entries;
    const declared = entries.find((e) => e.category !== null)!;
    const rebuild = (override: (typeof entries)[number] | null) =>
      new AlertCatalog(
        [
          {
            pack: 'p',
            entries: entries.map((e, i) => ({
              id: `e${i}`,
              alertname: e.alertname,
              role: 'symptom' as const,
              match_labels: e.match_labels,
              ...(e.category === null ? {} : { category: e === override ? ('provider' as const) : e.category }),
              entity: { kind: 'Pod', name_labels: ['pod'] },
            })),
          },
        ],
        categoryOptions(rules, metrics),
      );
    expect(classificationInputsFingerprint(rebuild(null))).toBe(base);
    expect(classificationInputsFingerprint(rebuild(declared))).not.toBe(base);
  });
});

describe('GET /v1/incidents 的类别与组件参数', () => {
  it('三个参数都可以不给、给一次或重复', () => {
    expect(parseClassificationFilters({})).toEqual({
      category: [],
      excludeCategory: [],
      excludeComponent: [],
      businessDomain: [],
      excludeBusinessDomain: [],
      service: [],
    });
    expect(
      parseClassificationFilters({
        category: ['availability', 'unclassified'],
        exclude_category: 'provider',
        exclude_component: ['component:provider', 'Deployment:shop/api'],
      }),
    ).toEqual({
      category: ['availability', 'unclassified'],
      excludeCategory: ['provider'],
      excludeComponent: ['component:provider', 'Deployment:shop/api'],
      businessDomain: [],
      excludeBusinessDomain: [],
      service: [],
    });
  });

  it('unclassified 不能被排除；不合法的类别、空值与组件键返回 400', () => {
    rejects(
      () => parseClassificationFilters({ exclude_category: ['provider', 'unclassified'] }),
      'unclassified 不能被排除',
    );
    rejects(() => parseClassificationFilters({ category: 'latency' }), 'category 只能是');
    rejects(() => parseClassificationFilters({ exclude_category: 'latency' }), 'exclude_category 只能是');
    rejects(() => parseClassificationFilters({ category: '' }), 'category 不能为空');
    rejects(() => parseClassificationFilters({ exclude_component: 'not a key' }), 'exclude_component 的组件键不合法');
  });

  it('筛选条件：包含按交集，排除只去掉类别或组件全部被排除的事件，没有给参数时没有条件', () => {
    expect(
      classificationConditions({
        category: [],
        excludeCategory: [],
        excludeComponent: [],
        businessDomain: [],
        excludeBusinessDomain: [],
        service: [],
      }),
    ).toEqual([]);
    expect(
      classificationConditions({
        category: ['availability'],
        excludeCategory: ['provider'],
        excludeComponent: ['component:provider'],
        businessDomain: [],
        excludeBusinessDomain: [],
        service: [],
      }),
    ).toEqual([
      { sql: 'categories && :p::text[]', value: ['availability'] },
      { sql: 'NOT coalesce(categories <@ :p::text[], false)', value: ['provider'] },
      {
        sql: "NOT (jsonb_array_length(body->'components') > 0 AND body->'components' <@ to_jsonb(:p::text[]))",
        value: ['component:provider'],
      },
    ]);
  });

  it('业务领域与服务（ADR 0193）：可以重复，id 不合法返回 400；没有业务领域的事件不被排除', () => {
    const f = parseClassificationFilters({
      business_domain: 'forwarding',
      exclude_business_domain: ['self', 'platform'],
      service: ['gateway'],
    });
    expect([f.businessDomain, f.excludeBusinessDomain, f.service]).toEqual([
      ['forwarding'],
      ['self', 'platform'],
      ['gateway'],
    ]);
    expect(classificationConditions(f)).toEqual([
      { sql: 'business_domain = ANY(:p::text[])', value: ['forwarding'] },
      { sql: 'NOT coalesce(business_domain = ANY(:p::text[]), false)', value: ['self', 'platform'] },
      { sql: 'services && :p::text[]', value: ['gateway'] },
    ]);
    rejects(() => parseClassificationFilters({ business_domain: 'Forwarding' }), 'business_domain 不是合法的 id');
    rejects(() => parseClassificationFilters({ service: 'a b' }), 'service 不是合法的 id');
  });

  it('摘要的类别取列；之前版本写下、还没有补上的行按 body 的成员算', () => {
    const body = {
      root: { component: 'Deployment:shop/api' },
      members: [
        {
          alert_id: 'a@1',
          component: 'Deployment:shop/api',
          severity: 'warning',
          starts_at: '2026-10-15T10:00:00Z',
          left_version: null,
        },
        {
          alert_id: 'b@1',
          component: 'Deployment:shop/web',
          severity: 'critical',
          starts_at: '2026-10-15T10:00:00Z',
          category: 'availability',
          left_version: null,
        },
      ],
    } as unknown as Incident;
    const row = { body, categories: null, primary_category: null } as unknown as IncidentRow;
    expect(rowCategories(row)).toEqual({
      categories: ['availability', 'unclassified'],
      primary_category: 'unclassified',
    });
    expect(rowCategories({ ...row, categories: ['performance'], primary_category: 'performance' })).toEqual({
      categories: ['performance'],
      primary_category: 'performance',
    });
  });
});
