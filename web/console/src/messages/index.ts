// 控制台自己的文案，与 @srenautix/ui 的文案合并；同名键以控制台为准。

import type { Locale, Messages } from '@srenautix/ui';
import en from './en.json';
import zhCN from './zh-CN.json';

export const CONSOLE_MESSAGES: Record<Locale, Messages> = { 'zh-CN': zhCN, en };
