import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { compilePackSet } from '../src/pack/compile.js';
import { applyLayers } from '../src/pack/layers.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { evaluateConclusions, type ConclusionInput } from '../src/runtime/conclusions.js';
import { CATALOG, PACKS } from './support.js';

// 确定性结论规则（conclusions.yaml，ADR 0178）：编译时的检查、求值的条件语义（证据卡、告警、变更，self 与 incident）

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** 全部内置包：postgres 的告警条目引用 upstream-conditions 与 kps-conditions 的证据链，单独加载它不能编译 */
const allPacks = () => loadBuiltinPacks(PACKS);

const manifest = (name: string, depends: string[]) => `api_version: srenautix.io/pack/v1
name: ${name}
version: 0.1.0
description: 结论规则测试包
maturity: beta
min_srenautix_version: 0.1.0
depends_on: [${depends.join(', ')}]
requires: [metrics.query, metrics.query_range]
`;

function userPack(name: string, conclusions: string, depends = ['postgres'], files: Record<string, string> = {}) {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const dir = join(mkdtempSync(join(base, 'conclusions-')), name);
  scratch.push(join(dir, '..'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), manifest(name, depends));
  writeFileSync(join(dir, 'conclusions.yaml'), conclusions);
  for (const [f, body] of Object.entries(files)) {
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

const compileWith = (dir: string) => compilePackSet([...allPacks(), loadPackDir(dir, 'test')], { catalog: CATALOG });

const rule = (when: string, extra = '') => `conclusions:
  - id: r1
    title: { zh-CN: 测试规则 }
${extra}    when:
${when}
    mechanism: { zh-CN: 测试机制 }
`;

const PG = 'postgres.cnpg-cluster:shop/pg';
const API = 'Deployment:shop/api';

function input(over: Partial<ConclusionInput> = {}): ConclusionInput {
  return {
    components: [
      { key: PG, type: 'postgres.cnpg-cluster' },
      { key: API, type: 'kubernetes.deployment' },
    ],
    cards: [],
    alerts: [],
    changes: [],
    ...over,
  };
}

const card = (
  ref: string,
  card_id: string,
  component: string | null,
  verdict: 'normal' | 'abnormal' | 'undeterminable',
  observations: Record<string, number | string | boolean | null> = {},
  routine = false,
) => ({ ref, card_id, component, verdict, routine, observations });

describe('内置包的结论规则', () => {
  it('postgres 与 _example 的规则编译后卡片条件解析为全局卡键', async () => {
    const set = await compilePackSet(allPacks(), { catalog: CATALOG });
    const byKey = new Map(set.conclusions.map((r) => [r.key, r]));
    expect([...byKey.keys()].sort()).toEqual([
      '_example/oom-killed',
      'postgres/oom-failover',
      'postgres/slow-statements-saturate-connections',
    ]);
    expect(byKey.get('postgres/oom-failover')!.cards).toEqual([
      { card: 'postgres/availability/oom-kills', verdict: 'abnormal', observations: [], on: 'self' },
      {
        card: 'postgres/availability/primary-changes',
        verdict: 'abnormal',
        observations: [{ name: 'changes', op: 'gt', value: 0 }],
        on: 'self',
      },
    ]);
    expect([...byKey.get('postgres/oom-failover')!.componentTypes!].sort()).toEqual([
      'postgres.cnpg-cluster',
      'postgres.instance',
    ]);
  });

  it('OOM 加主库切换：两张卡都落在数据库组件上时命中，依据按条件顺序；切换只发生在别的组件上时不命中', async () => {
    const set = await compilePackSet(allPacks(), { catalog: CATALOG });
    const oom = set.conclusions.filter((r) => r.key === 'postgres/oom-failover');
    const hit = evaluateConclusions(
      oom,
      input({
        cards: [
          card('card:1', 'postgres/availability/primary-changes', PG, 'abnormal', { changes: 2, primaries: 1 }),
          card('card:2', 'postgres/availability/oom-kills', PG, 'abnormal', { ooms: 1 }),
          card('card:3', 'workload/http/error_ratio', API, 'abnormal'),
        ],
      }),
    );
    expect(hit.map((h) => [h.rule.key, h.root, h.basis])).toEqual([
      ['postgres/oom-failover', PG, ['card:2', 'card:1']],
    ]);
    // 同时有两个主库但角色没有变化：observations 不满足
    expect(
      evaluateConclusions(
        oom,
        input({
          cards: [
            card('card:1', 'postgres/availability/primary-changes', PG, 'abnormal', { changes: 0, primaries: 2 }),
            card('card:2', 'postgres/availability/oom-kills', PG, 'abnormal', { ooms: 1 }),
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      evaluateConclusions(
        oom,
        input({
          cards: [
            card('card:1', 'postgres/availability/primary-changes', API, 'abnormal', { changes: 1 }),
            card('card:2', 'postgres/availability/oom-kills', PG, 'abnormal', { ooms: 1 }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('常态的异常卡按正常对待，无法判定的卡不满足条件，组件类型不在范围内时不求值', async () => {
    const set = await compilePackSet(allPacks(), { catalog: CATALOG });
    const pool = set.conclusions.filter((r) => r.key === 'postgres/slow-statements-saturate-connections');
    const cards = (routine: boolean, latency: 'abnormal' | 'undeterminable') => [
      card('card:1', 'postgres/saturation/connections', PG, 'abnormal', {}, routine),
      card('card:2', 'postgres/saturation/statement-latency', PG, latency),
    ];
    expect(evaluateConclusions(pool, input({ cards: cards(false, 'abnormal') })).map((h) => h.basis)).toEqual([
      ['card:1', 'card:2'],
    ]);
    expect(evaluateConclusions(pool, input({ cards: cards(true, 'abnormal') }))).toEqual([]);
    expect(evaluateConclusions(pool, input({ cards: cards(false, 'undeterminable') }))).toEqual([]);
    expect(
      evaluateConclusions(
        pool,
        input({ cards: cards(false, 'abnormal'), components: [{ key: PG, type: 'kubernetes.statefulset' }] }),
      ),
    ).toEqual([]);
  });
});

describe('告警与变更条件', () => {
  const RULES = rule(
    `      cards:
        - { card: postgres/saturation/connections }
      alerts:
        - { alertnames: [ApiHighErrorRate], roles: [symptom], labels: { team: shop }, on: incident }
      changes:
        - { kinds: [rollout], min_grade: high }`,
  );

  it('告警按名字、角色与标签匹配，incident 范围看全部组件；变更要落在求值对象上且分级不低于 min_grade', async () => {
    const set = await compileWith(userPack('rulex', RULES));
    const rules = set.conclusions.filter((r) => r.pack === 'rulex');
    const base = {
      cards: [card('card:1', 'postgres/saturation/connections', PG, 'abnormal')],
      alerts: [
        {
          ref: 'alert:1',
          alertname: 'ApiHighErrorRate',
          labels: { team: 'shop' },
          role: 'symptom' as const,
          component: API,
        },
        {
          ref: 'alert:2',
          alertname: 'ApiHighErrorRate',
          labels: { team: 'ops' },
          role: 'symptom' as const,
          component: API,
        },
      ],
      changes: [{ ref: 'change:1', kind: 'rollout', targets: [PG], grade: 'high' as const }],
    };
    expect(evaluateConclusions(rules, input(base)).map((h) => [h.root, h.basis])).toEqual([
      [PG, ['card:1', 'alert:1', 'change:1']],
    ]);
    const graded = (grade: 'high' | 'medium' | null, targets = [PG]) =>
      evaluateConclusions(rules, input({ ...base, changes: [{ ref: 'change:1', kind: 'rollout', targets, grade }] }));
    expect(graded('medium')).toEqual([]);
    // 事件没有关联分级（之前版本算出）时 min_grade 不成立
    expect(graded(null)).toEqual([]);
    expect(graded('high', [API])).toEqual([]);
    expect(
      evaluateConclusions(rules, input({ ...base, alerts: [{ ...base.alerts[0]!, role: 'cause' as const }] })),
    ).toEqual([]);
  });

  it('用户层可以禁用与追加结论规则', async () => {
    const dir = userPack('ruley', RULES);
    const packs = [...allPacks(), loadPackDir(dir, 'test')];
    applyLayers(packs, [
      {
        path: 'layer.yaml',
        sha256: 'x',
        layer: {
          api_version: 'srenautix.io/pack-layer/v1',
          target: 'ruley',
          disable: ['conclusions/r1'],
          extend: {
            conclusions: [
              {
                id: 'r2',
                title: { 'zh-CN': '追加的规则' },
                when: { cards: [{ card: 'postgres/availability/oom-kills' }] },
                mechanism: { 'zh-CN': '追加的机制' },
              },
            ],
          },
        },
      },
    ]);
    const set = await compilePackSet(packs, { catalog: CATALOG });
    expect(set.conclusions.filter((r) => r.pack === 'ruley').map((r) => r.key)).toEqual(['ruley/r2']);
  });
});

describe('编译时的检查', () => {
  const cases: Array<[string, string, string[] | undefined, RegExp]> = [
    ['卡片不存在', rule('      cards: [{ card: postgres/availability/nope }]'), undefined, /不是证据链中的卡/],
    [
      '引用的包不在 depends_on 中',
      rule('      cards: [{ card: workload/pod-restarts/memory }]'),
      ['postgres'],
      /引用的包 workload 不在 depends_on 中/,
    ],
    [
      'observations 不是 let 绑定',
      rule(
        '      cards: [{ card: postgres/availability/oom-kills, observations: [{ name: nope, op: gt, value: 0 }] }]',
      ),
      undefined,
      /observations 引用 nope/,
    ],
    [
      '大小比较的值不是数值',
      rule(
        '      cards: [{ card: postgres/availability/oom-kills, observations: [{ name: ooms, op: gt, value: a }] }]',
      ),
      undefined,
      /gt 只能和数值比较/,
    ],
    ['没有条件', rule('      cards: []'), undefined, /条件三类合计要有 1–8 个，实际 0 个/],
    [
      '组件类型不存在',
      rule('      cards: [{ card: postgres/availability/oom-kills }]', '    component_types: [nope.type]\n'),
      undefined,
      /组件类型 nope.type 不存在/,
    ],
    [
      '机制超过 300 字',
      rule('      cards: [{ card: postgres/availability/oom-kills }]').replace('测试机制', '长'.repeat(301)),
      undefined,
      /机制（zh-CN）超过 300 字/,
    ],
  ];

  it.each(cases)('%s', async (_name, conclusions, depends, msg) => {
    const dir = userPack('rulez', conclusions, depends);
    await expect(compileWith(dir)).rejects.toThrow(msg);
    await expect(compileWith(dir)).rejects.toBeInstanceOf(PackLintError);
  });

  it('规则 id 重复', async () => {
    const one = rule('      cards: [{ card: postgres/availability/oom-kills }]');
    const dir = userPack('rulew', `${one}${one.replace('conclusions:\n', '')}`);
    await expect(compileWith(dir)).rejects.toThrow(/结论规则 r1 重复/);
  });

  it('测试文件至少要有 tests 或 conclusions 之一', () => {
    const dir = userPack('rulev', rule('      cards: [{ card: postgres/availability/oom-kills }]'), ['postgres'], {
      'tests/empty.yaml': 'api_version: srenautix.io/pack-test/v1\ninterval: 1m\n',
    });
    expect(() => loadPackDir(dir, 'test')).toThrow(/测试文件至少要有 tests 或 conclusions 之一/);
  });
});
