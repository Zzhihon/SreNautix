import { createHash } from 'node:crypto';
import { en } from './en.js';
import { zh } from './zh.js';

/**
 * 一种语言的提示词模板：固定指令与三个步骤的任务说明；rules 是规则判定片段（ADR 0178）的说明，放在可裁剪的片段里，
 * 只在事件有规则判定时出现，不计入提示词哈希；causality 是拓扑关系只构成假设的说明（ADR 0179），放在可裁剪的拓扑片段里，
 * 同样不计入提示词哈希
 */
export interface PromptSet {
  system: string;
  hypothesize: string;
  conclude: string;
  judge: string;
  rules: string;
  causality: string;
}

export type Language = 'zh' | 'en';

export const PROMPTS: Readonly<Record<Language, PromptSet>> = { zh, en };

/** 提示词模板的哈希，按阶段写入研判清单的 prompt_hashes */
export function promptHash(language: Language, step: keyof PromptSet): string {
  const p = PROMPTS[language];
  return `sha256:${createHash('sha256').update(`${p.system}\0${p[step]}`).digest('hex')}`;
}
