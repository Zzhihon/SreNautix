import { createHash } from 'node:crypto';
import { en } from './en.js';
import { zh } from './zh.js';

/** 一种语言的提示词模板：固定指令与三个步骤的任务说明 */
export interface PromptSet {
  system: string;
  hypothesize: string;
  conclude: string;
  judge: string;
}

export type Language = 'zh' | 'en';

export const PROMPTS: Readonly<Record<Language, PromptSet>> = { zh, en };

/** 提示词模板的哈希，按阶段写入研判清单的 prompt_hashes */
export function promptHash(language: Language, step: keyof PromptSet): string {
  const p = PROMPTS[language];
  return `sha256:${createHash('sha256').update(`${p.system}\0${p[step]}`).digest('hex')}`;
}
