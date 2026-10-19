// 控制台自己的文案，与 @srenautix/ui 的文案合并；同名键以控制台为准。
// 外壳与值班、处置页面在 <语言>.json，度量、系统与治理页面在 pages.<语言>.json。

import type { Locale, Messages } from '@srenautix/ui';
import en from './en.json';
import pagesEn from './pages.en.json';
import pagesZhCN from './pages.zh-CN.json';
import zhCN from './zh-CN.json';

export const CONSOLE_MESSAGES: Record<Locale, Messages> = {
  'zh-CN': { ...zhCN, ...pagesZhCN },
  en: { ...en, ...pagesEn },
};
