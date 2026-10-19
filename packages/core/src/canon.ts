// 规范化与哈希：jcs-sha256-v1（RFC 8785 JCS、UTF-8、SHA-256、小写十六进制并带 sha256: 前缀），与审批断言一致
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Sha256 } from '@srenautix/contract';

export const CANON_VERSION = 'jcs-sha256-v1';

export function jcs(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new Error('无法规范化：值为 undefined');
  }
  return text;
}

export function sha256Hex(text: string): Sha256 {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function jcsSha256(value: unknown): Sha256 {
  return sha256Hex(jcs(value));
}

/** 提议参数的哈希（审批断言的 params_hash） */
export function paramsHash(params: Record<string, unknown>): Sha256 {
  return jcsSha256(params);
}

/**
 * 提议的幂等键（DESIGN §2.4）：hash(incident_id, run_id|rule_id|caller_id, action, canonical_params)。
 * 规范化后的参数以对象嵌入，避免字符串拼接的歧义
 */
export function proposalIdempotencyKey(input: {
  incidentId: string;
  sourceId: string;
  action: string;
  params: Record<string, unknown>;
}): Sha256 {
  return jcsSha256([input.incidentId, input.sourceId, input.action, input.params]);
}
