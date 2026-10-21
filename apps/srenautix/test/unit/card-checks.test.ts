import type { CardEntry } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import { validatorOf } from '../../src/llm/schema.js';
import {
  cardApplies,
  cardCheckArgs,
  cardCheckId,
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

  it('applies_to 按 sameKind 比较：Application 的卡适用于 Application.argoproj.io', () => {
    expect(cardApplies(entry, 'Application.argoproj.io')).toBe(true);
    expect(cardApplies(entry, 'namespace')).toBe(true);
    expect(cardApplies(entry, 'Deployment')).toBe(false);
  });
});
