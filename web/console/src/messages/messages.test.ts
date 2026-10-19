import { UI_MESSAGES } from '@srenautix/ui';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { CONSOLE_MESSAGES } from './index';

// 控制台源码里所有 t('...') 与 t(`...${x}`) 的文案键（Vite 在构建时内联源码文本）
const SOURCES = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const KEY = /\bt\((['`])([a-zA-Z0-9_.]+(?:\$\{[^}]+\}[a-zA-Z0-9_.]*)*)\1/g;

function usedKeys(): { exact: Set<string>; prefixes: Set<string> } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const src of Object.values(SOURCES)) {
    for (const m of src.matchAll(KEY)) {
      const k = m[2]!;
      const i = k.indexOf('${');
      if (i < 0) {
        exact.add(k);
      } else {
        prefixes.add(k.slice(0, i));
      }
    }
  }
  return { exact, prefixes };
}

describe('控制台文案', () => {
  const merged = {
    'zh-CN': { ...UI_MESSAGES['zh-CN'], ...CONSOLE_MESSAGES['zh-CN'] },
    en: { ...UI_MESSAGES.en, ...CONSOLE_MESSAGES.en },
  };

  it('两种语言的键集合相同', () => {
    expect(Object.keys(CONSOLE_MESSAGES.en).sort()).toEqual(Object.keys(CONSOLE_MESSAGES['zh-CN']).sort());
  });

  it('源码用到的每个键在两种语言里都存在', () => {
    const { exact, prefixes } = usedKeys();
    expect(exact.size).toBeGreaterThan(100);
    for (const locale of ['zh-CN', 'en'] as const) {
      const keys = Object.keys(merged[locale]);
      expect(
        [...exact].filter((k) => merged[locale][k] === undefined),
        locale,
      ).toEqual([]);
      expect(
        [...prefixes].filter((p) => !keys.some((k) => k.startsWith(p))),
        locale,
      ).toEqual([]);
    }
  });

  it('每条文案都是合法的 ICU MessageFormat', () => {
    for (const [locale, messages] of Object.entries(CONSOLE_MESSAGES)) {
      for (const [id, src] of Object.entries(messages)) {
        expect(() => new IntlMessageFormat(src, locale), `${locale}:${id}`).not.toThrow();
      }
    }
  });
});
