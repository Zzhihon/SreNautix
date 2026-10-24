import { resolve } from 'node:path';
import type { GoalCreate } from '@srenautix/contract';
import { compilePackSet, loadActionCatalog, loadPackDir, type PackSet } from '@srenautix/packs-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { goalNamespaces } from '../../src/api/routes-goals.js';
import { optimizationCatalog } from '../../src/optimize/catalog.js';
import { DEFAULT_BUDGET, GoalRejected, goalSpec } from '../../src/optimize/goals.js';
import { PACKS } from '../support/packs.js';

// 下达目标（ADR 0146 §1.2、§5.1）：只能引用领域包的指标与领域，参数按指标的 schema 校验，预算与期限取默认值

const OPTDB = resolve(import.meta.dirname, '../fixtures/packs/optdb');

let set: PackSet;
beforeAll(async () => {
  const catalog = loadActionCatalog(resolve(PACKS, '../contract/gateway/v1/action-catalog.yaml'));
  set = await compilePackSet([loadPackDir(OPTDB, 'test')], { catalog });
});

const origin = { kind: 'manual' as const, channel: 'console' as const, principal: 'alice' };
const indicatorGoal = (over: Partial<GoalCreate> = {}): GoalCreate => ({
  cluster_id: 'c1',
  subject: {
    type: 'indicator',
    indicator: 'optdb/db-time',
    params: { database: 'cchp' },
    scope: { components: ['Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres'], namespaces: [] },
  },
  objective: { comparator: 'lt', target: 0.3, unit: 'per_second', statistic: 'p95', window: '7d' },
  outputs: ['ops_pr', 'business_issue'],
  ...over,
});

describe('目标规格', () => {
  it('目录只含领域包声明的指标与领域', () => {
    const c = optimizationCatalog(set);
    expect([...c.indicators.keys()].sort()).toEqual(['optdb/db-time', 'optdb/xact']);
    expect(c.raw.domains).toEqual([
      {
        id: 'database',
        title: { 'zh-CN': '数据库性能', en: 'Database performance' },
        packs: ['optdb'],
        indicators: ['optdb/db-time'],
      },
    ]);
  });

  it('指标目标：参数按指标的 schema 校验，单位与指标一致，预算取默认值', () => {
    const c = optimizationCatalog(set);
    const { spec, expiresInMs } = goalSpec(indicatorGoal({ budget: { tokens: 100_000 } }), origin, c);
    expect(spec.budget).toEqual({ ...DEFAULT_BUDGET, tokens: 100_000 });
    expect(expiresInMs).toBe(14 * 24 * 3600_000);
    expect(spec.origin).toEqual(origin);
    const reject = (g: GoalCreate, m: RegExp) => expect(() => goalSpec(g, origin, c)).toThrow(m);
    const subject = indicatorGoal().subject as Extract<GoalCreate['subject'], { type: 'indicator' }>;
    reject(indicatorGoal({ subject: { ...subject, indicator: 'optdb/nope' } }), /没有指标 optdb\/nope/);
    reject(indicatorGoal({ subject: { ...subject, params: { database: 'DROP TABLE x' } } }), /参数不合法/);
    reject(indicatorGoal({ subject: { ...subject, params: { query: 'up' } } }), /参数不合法/);
    reject(
      indicatorGoal({ objective: { comparator: 'lt', target: 1, unit: 'seconds', statistic: 'p95', window: '7d' } }),
      /单位/,
    );
    reject(
      indicatorGoal({
        objective: { comparator: 'lt', target: 1, unit: 'per_second', statistic: 'p95', window: '30d' },
      }),
      /1d 到 14d/,
    );
    reject(indicatorGoal({ expires_in: '60d' }), /1h 到 30d/);
    expect(() => goalSpec(indicatorGoal(), origin, c)).not.toThrow(GoalRejected);
  });

  it('领域体检：领域必须存在，不能带目标值', () => {
    const c = optimizationCatalog(set);
    const domain = (d: string): GoalCreate => ({
      cluster_id: 'c1',
      subject: { type: 'domain', domain: d, scope: { components: [], namespaces: ['cchp-data'] } },
      objective: null,
      outputs: ['business_issue'],
    });
    expect(goalSpec(domain('database'), origin, c).spec.subject).toMatchObject({ domain: 'database' });
    expect(() => goalSpec(domain('storage'), origin, c)).toThrow(/没有领域 storage/);
    expect(() =>
      goalSpec({ ...domain('database'), objective: indicatorGoal().objective } as GoalCreate, origin, c),
    ).toThrow(/没有目标值/);
  });

  it('授权对象：作用域的命名空间与组件所在的命名空间', () => {
    expect(goalNamespaces({ subject: indicatorGoal().subject })).toEqual(['cchp-data']);
    expect(
      goalNamespaces({
        subject: { type: 'domain', domain: 'database', scope: { components: ['Node:n1'], namespaces: ['a'] } },
      }),
    ).toEqual(['a']);
    expect(
      goalNamespaces({ subject: { type: 'domain', domain: 'database', scope: { components: [], namespaces: [] } } }),
    ).toEqual([]);
  });
});
