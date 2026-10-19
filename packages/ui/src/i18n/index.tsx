// 文案与格式化。文案使用 ICU MessageFormat，zh-CN 为默认语言，en 为第二语言；同一份 JSON
// 由控制台、Grafana 插件和服务端的消息渲染共用（包导出 @srenautix/ui/messages/<语言>.json）。
// 缺少的文案键直接抛出错误，测试保证两种语言的键集合一致。

import { IntlMessageFormat, type PrimitiveType } from 'intl-messageformat';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import en from './en.json';
import zhCN from './zh-CN.json';

export type Locale = 'zh-CN' | 'en';
export const LOCALES: readonly Locale[] = ['zh-CN', 'en'];
export type Messages = Readonly<Record<string, string>>;
export type MessageValues = Record<string, PrimitiveType>;

export const UI_MESSAGES: Record<Locale, Messages> = { 'zh-CN': zhCN, en };

export interface I18n {
  locale: Locale;
  timeZone: string;
  /** 取一条文案；values 填入 ICU 占位符。 */
  t: (id: string, values?: MessageValues) => string;
  /** 文案键是否存在，用于按枚举值拼接键时的分支。 */
  has: (id: string) => boolean;
  fmt: Formatters;
}

export interface Formatters {
  /** "10-19 14:05"（当天只写 "14:05"）。 */
  clock: (t: string | number, now?: number) => string;
  /** 完整时间 "2026-10-19 14:05:09"。 */
  dateTime: (t: string | number) => string;
  /** 时长 "3 小时 5 分" / "3h 5m"。 */
  duration: (ms: number) => string;
  /** "3 分钟前" / "3 minutes ago"。 */
  relative: (t: string | number, now: number) => string;
  number: (n: number, digits?: number) => string;
  percent: (ratio: number, digits?: number) => string;
  /** 金额，币种由数据给出。 */
  money: (amount: number, currency: string) => string;
}

function toMs(t: string | number): number {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (Number.isNaN(ms)) {
    throw new Error(`无法解析时间：${String(t)}`);
  }
  return ms;
}

function makeFormatters(locale: Locale, timeZone: string, t: I18n['t']): Formatters {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const fields = (ms: number) => {
    const o: Record<string, string> = {};
    for (const p of parts.formatToParts(ms)) {
      o[p.type] = p.value;
    }
    return o as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
  };
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const nf = new Map<number, Intl.NumberFormat>();
  const numberFormat = (digits: number) => {
    let f = nf.get(digits);
    if (!f) {
      f = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
      nf.set(digits, f);
    }
    return f;
  };
  return {
    clock: (v, now) => {
      const f = fields(toMs(v));
      const hm = `${f.hour}:${f.minute}`;
      if (now !== undefined) {
        const n = fields(now);
        if (n.year === f.year && n.month === f.month && n.day === f.day) {
          return hm;
        }
      }
      return `${f.month}-${f.day} ${hm}`;
    },
    dateTime: (v) => {
      const f = fields(toMs(v));
      return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}:${f.second}`;
    },
    duration: (ms) => {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) {
        return t('fmt.duration.s', { s });
      }
      const m = Math.floor(s / 60);
      if (m < 60) {
        return t('fmt.duration.m', { m });
      }
      const h = Math.floor(m / 60);
      if (h < 24) {
        return t('fmt.duration.hm', { h, m: m % 60 });
      }
      const d = Math.floor(h / 24);
      return t('fmt.duration.dh', { d, h: h % 24 });
    },
    relative: (v, now) => {
      const diff = (toMs(v) - now) / 1000;
      const abs = Math.abs(diff);
      if (abs < 60) {
        return rtf.format(Math.round(diff), 'second');
      }
      if (abs < 3600) {
        return rtf.format(Math.round(diff / 60), 'minute');
      }
      if (abs < 86400) {
        return rtf.format(Math.round(diff / 3600), 'hour');
      }
      return rtf.format(Math.round(diff / 86400), 'day');
    },
    number: (n, digits = 2) => numberFormat(digits).format(n),
    percent: (ratio, digits = 1) =>
      new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(ratio),
    money: (amount, currency) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 4 }).format(amount),
  };
}

/** 不依赖 React 的 I18n，供服务端渲染、测试和非组件代码使用。 */
export function createI18n(locale: Locale, timeZone: string, extra: Partial<Record<Locale, Messages>> = {}): I18n {
  const catalog: Messages = { ...UI_MESSAGES[locale], ...(extra[locale] ?? {}) };
  const cache = new Map<string, IntlMessageFormat>();
  const t = (id: string, values?: MessageValues): string => {
    let f = cache.get(id);
    if (!f) {
      const src = catalog[id];
      if (src === undefined) {
        throw new Error(`缺少文案 ${locale}:${id}`);
      }
      f = new IntlMessageFormat(src, locale);
      cache.set(id, f);
    }
    const out = f.format(values);
    if (typeof out !== 'string') {
      throw new Error(`文案 ${id} 含有富文本标签，只能输出纯文本`);
    }
    return out;
  };
  return {
    locale,
    timeZone,
    t,
    has: (id) => catalog[id] !== undefined,
    fmt: makeFormatters(locale, timeZone, t),
  };
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({
  locale,
  timeZone,
  extra,
  children,
}: {
  locale: Locale;
  timeZone: string;
  /** 宿主自己的文案，与组件库的文案合并；同名键以宿主为准。 */
  extra?: Partial<Record<Locale, Messages>>;
  children: ReactNode;
}) {
  const value = useMemo(() => createI18n(locale, timeZone, extra), [locale, timeZone, extra]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(I18nContext);
  if (!v) {
    throw new Error('I18nProvider 缺失');
  }
  return v;
}
