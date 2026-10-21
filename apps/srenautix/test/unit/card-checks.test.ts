import type { Incident } from '@srenautix/contract';
import type { CardEntry, PackSet } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import { validatorOf } from '../../src/llm/schema.js';
import {
  cardApplies,
  cardCheckArgs,
  cardCheckId,
  cardChecks,
  parseCardCheckId,
  splitCardCheckArgs,
} from '../../src/stage-a/card-checks.js';

// 卡片即检查的 id、参数 schema 与窗口覆盖（ADR 0116）

const entry = {
  key: 'argocd/application/status',
  pack: 'argocd',
  chain: 'application',
  def: {
    id: 'status',
    title: { 'zh-CN': '同步与健康', en: 'Sync and health' },
    applies_to: { kinds: ['Application', 'Namespace'] },
    window: { before: '30m', after: '10m' },
    params: { degraded_minutes: 5, mode: 'strict', strict: true },
  },
} as unknown as CardEntry;

describe('卡片检查', () => {
  it('id 带着组件；组件键里的冒号与斜杠不影响解析；不是卡片检查时为 null', () => {
    const id = cardCheckId(entry.key, 'Application.argoproj.io:argocd/shop');
    expect(id).toBe('cardcheck:argocd/application/status@Application.argoproj.io:argocd/shop');
    expect(parseCardCheckId(id)).toEqual({ card: entry.key, component: 'Application.argoproj.io:argocd/shop' });
    expect(parseCardCheckId('_example/memory-ratio')).toBeNull();
    expect(parseCardCheckId('cardcheck:@x')).toBeNull();
    expect(parseCardCheckId('cardcheck:a/b/c@')).toBeNull();
  });

  it('参数全部可选、不允许其他字段；可覆盖参数的类型取默认值的类型', () => {
    const v = validatorOf(cardCheckArgs(entry));
    expect(v({})).toBe(true);
    expect(v({ window_before: '2h', degraded_minutes: 10, mode: 'loose', strict: false })).toBe(true);
    expect(v({ window_before: 'two hours' })).toBe(false);
    expect(v({ degraded_minutes: '10' })).toBe(false);
    expect(v({ other: 1 })).toBe(false);
  });

  it('窗口只给一端时另一端取卡片定义；没有给出时不覆盖', () => {
    expect(splitCardCheckArgs(entry, { window_before: '2h', degraded_minutes: 10 })).toEqual({
      params: { degraded_minutes: 10 },
      window: { before: '2h', after: '10m' },
    });
    expect(splitCardCheckArgs(entry, {})).toEqual({ params: {}, window: undefined });
  });

  it('卡片有 check 块时参数按 check.args 约束（契约 2.17.0），窗口键仍由运行时提供', () => {
    const bounded = {
      ...entry,
      def: {
        ...entry.def,
        check: {
          description: { 'zh-CN': '应用降级超过阈值', en: 'Application degraded beyond the threshold' },
          args: {
            type: 'object',
            additionalProperties: false,
            properties: { degraded_minutes: { type: 'number', minimum: 1, maximum: 60, description: '降级分钟数' } },
          },
        },
      },
    } as unknown as CardEntry;
    const v = validatorOf(cardCheckArgs(bounded));
    expect(v({ degraded_minutes: 30, window_after: '1h' })).toBe(true);
    expect(v({ degraded_minutes: 600 })).toBe(false);
    // check.args 没有声明的 params 键仍按默认值的类型提供
    expect(v({ mode: 'loose' })).toBe(true);

    // 检查说明优先取 check.description，没有时用标题与卡片说明
    const rt = {
      set: { cards: new Map([[bounded.key, bounded]]) } as unknown as PackSet,
      typeChains: () => [],
      componentTypes: () => [],
    };
    const app = 'Application.argoproj.io:argocd/shop';
    const incident = { root: { component: app }, candidates: [], components: [app] } as unknown as Incident;
    const node = { key: app, kind: 'Application.argoproj.io', namespace: 'argocd', name: 'shop', component_type: null };
    expect(cardChecks(rt, incident, [node], [], 'en')[0]!.description).toBe(
      `Sync and health on ${app}: Application degraded beyond the threshold`,
    );
    rt.set.cards.set(entry.key, entry);
    expect(cardChecks(rt, incident, [node], [], 'en')[0]!.description).toBe(
      `Sync and health on ${app}; abnormal means the card rules judged it abnormal`,
    );
  });

  it('applies_to 按 sameKind 比较：Application 的卡适用于 Application.argoproj.io', () => {
    expect(cardApplies(entry, 'Application.argoproj.io')).toBe(true);
    expect(cardApplies(entry, 'namespace')).toBe(true);
    expect(cardApplies(entry, 'Deployment')).toBe(false);
  });
});
