// 证据指纹（DESIGN §2.4、§7.4）：证据卡判定向量的哈希，带迟滞。
// 新的判定向量连续两次对账都一致，才视为指纹发生了变化；中间出现一次抖动不触发重研。
import type { EntityRef, Sha256, Verdict } from '@srenautix/contract';
import { jcsSha256 } from './canon.js';
import { entityKey } from './keys.js';

export interface VerdictEntry {
  card_id: string;
  entity: Pick<EntityRef, 'kind' | 'namespace' | 'name'> | null;
  verdict: Verdict;
}

/** 判定向量的指纹：按 卡片@实体 排序后规范化哈希，与卡片的执行顺序无关 */
export function evidenceFingerprint(entries: readonly VerdictEntry[]): Sha256 {
  const rows = entries
    .map((e) => [`${e.card_id}@${e.entity ? entityKey(e.entity) : ''}`, e.verdict] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]![0] === rows[i - 1]![0]) {
      throw new Error(`判定向量中 ${rows[i]![0]} 重复`);
    }
  }
  return jcsSha256(rows);
}

export interface FingerprintState {
  /** 当前生效的指纹 */
  current: Sha256;
  /** 与当前不同、正在观察的指纹 */
  pending: Sha256 | null;
  /** pending 连续出现的次数 */
  pendingCount: number;
}

export interface FingerprintUpdate {
  state: FingerprintState;
  /** 本次对账后生效的指纹发生了变化 */
  changed: boolean;
}

export const FINGERPRINT_CONFIRMATIONS = 2;

/** 一次对账的判定向量指纹进入迟滞状态机；state 为 null 表示第一次观察，直接生效 */
export function observeFingerprint(state: FingerprintState | null, observed: Sha256): FingerprintUpdate {
  if (state === null) {
    return { state: { current: observed, pending: null, pendingCount: 0 }, changed: false };
  }
  if (observed === state.current) {
    return { state: { current: state.current, pending: null, pendingCount: 0 }, changed: false };
  }
  const count = observed === state.pending ? state.pendingCount + 1 : 1;
  if (count >= FINGERPRINT_CONFIRMATIONS) {
    return { state: { current: observed, pending: null, pendingCount: 0 }, changed: true };
  }
  return { state: { current: state.current, pending: observed, pendingCount: count }, changed: false };
}
