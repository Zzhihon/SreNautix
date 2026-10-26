import { REASON_CODES, type ReasonCodesByGroup, type ReasonCodesByStage } from './generated/reason-codes.js';
import type { ReasonCodeEntry, ReasonStage } from './generated/types.js';

/** 某个阶段登记的原因码 */
export type ReasonCodeOf<S extends ReasonStage> = ReasonCodesByStage[S];

/** 某个分组登记的原因码 */
export type ReasonGroupCode<G extends keyof ReasonCodesByGroup> = ReasonCodesByGroup[G];

const BY_KEY = new Map(REASON_CODES.map((e) => [`${e.stage}\0${e.code}`, e]));

/**
 * 登记表中的一条原因码。code 来自库或外部输入（字符串）时同样经过这里：没有登记时抛出，未登记的原因码说明写入方
 * 绕过了生成的类型
 */
export function reasonEntry(stage: ReasonStage, code: string): ReasonCodeEntry {
  const e = BY_KEY.get(`${stage}\0${code}`);
  if (e === undefined) {
    throw new Error(`原因码 ${stage}/${code} 不在登记表 contract/reason-codes.json 中`);
  }
  return e;
}

/** 原因码的说明（zh 与 zh-CN 都取中文） */
export function reasonText(stage: ReasonStage, code: string, language: 'zh' | 'zh-CN' | 'en'): string {
  const t = reasonEntry(stage, code).text;
  return language === 'en' ? t.en : t['zh-CN'];
}
