// 每个浏览器自己的偏好：语言、主题、时区。只存在 localStorage，组织级的默认值在设置页（服务端）。

import type { ColorScheme, Locale } from '@srenautix/ui';
import { useSyncExternalStore } from 'react';

export type ThemePref = ColorScheme | 'system';

export interface Prefs {
  locale: Locale;
  theme: ThemePref;
  timeZone: string;
}

const KEY = 'srenautix.prefs';

function initial(): Prefs {
  const raw = window.localStorage.getItem(KEY);
  const fallback: Prefs = {
    locale: navigator.language.toLowerCase().startsWith('zh')
      ? 'zh-CN'
      : navigator.language.toLowerCase().startsWith('en')
        ? 'en'
        : 'zh-CN',
    theme: 'system',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Prefs>) } : fallback;
}

let current = initial();
const listeners = new Set<() => void>();

export function setPrefs(p: Partial<Prefs>): void {
  current = { ...current, ...p };
  window.localStorage.setItem(KEY, JSON.stringify(current));
  for (const l of listeners) {
    l();
  }
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function useScheme(pref: ThemePref): ColorScheme {
  const dark = useSyncExternalStore(
    (cb) => {
      media.addEventListener('change', cb);
      return () => media.removeEventListener('change', cb);
    },
    () => media.matches,
  );
  return pref === 'system' ? (dark ? 'dark' : 'light') : pref;
}
