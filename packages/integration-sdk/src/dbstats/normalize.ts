// SQL 语句的规范化与指纹（ADR 0146 §1.1、§3.3、§3.5），用 libpg-query（PostgreSQL 的解析器编译为 wasm）：
// - normalizeStatement：常量换成 $n，去掉注释，空白合并，不超过 4 KiB；pg_stat_statements 的语句文本与代码中的 SQL 都经它处理；
// - statementFingerprint：libpg-query 的指纹（16 位十六进制），常量与 $n 占位符的指纹相同，PG 升级后 queryid 变化时不变。
// 解析器的语法是 PostgreSQL 18，向下兼容 16 与 17 的语句。

import * as pgQuery from 'libpg-query';

/** 规范化语句的最大字节数（UTF-8） */
export const MAX_STATEMENT_BYTES = 4096;

let loading: Promise<void> | null = null;
let loaded = false;

/** 加载解析器（wasm）；重复调用只加载一次 */
export function loadSqlParser(): Promise<void> {
  loading ??= pgQuery.loadModule().then(() => {
    loaded = true;
  });
  return loading;
}

export interface NormalizedStatement {
  /** 规范化后的语句；无法解析时为 null */
  text: string | null;
  /** 规范化语句的指纹；无法解析时为 null */
  fingerprint: string | null;
  /** 超过 4 KiB 被截断 */
  truncated: boolean;
  /** 无法解析的原因 */
  error: string | null;
}

/** 按 UTF-8 字节截断，不切断多字节字符 */
function truncateBytes(s: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) {
    return { text: s, truncated: false };
  }
  let end = max;
  // 退到一个字符的起始字节（UTF-8 的后续字节为 10xxxxxx）
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

/** 去掉注释（按扫描器给出的 C_COMMENT 与 SQL_COMMENT 词法单元，偏移是字节）并合并空白 */
function stripComments(sql: string): string {
  const buf = Buffer.from(sql, 'utf8');
  const comments = pgQuery
    .scanSync(sql)
    .tokens.filter((t) => t.tokenName === 'C_COMMENT' || t.tokenName === 'SQL_COMMENT')
    .sort((a, b) => a.start - b.start);
  const parts: Buffer[] = [];
  let at = 0;
  for (const c of comments) {
    parts.push(buf.subarray(at, c.start), Buffer.from(' '));
    at = c.end;
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts).toString('utf8').replace(/\s+/g, ' ').trim();
}

/** 语句规范化：常量换成 $n，去掉注释，空白合并，不超过 4 KiB；指纹按规范化之后、截断之前的语句计算 */
export async function normalizeStatement(sql: string): Promise<NormalizedStatement> {
  await loadSqlParser();
  try {
    const stripped = stripComments(pgQuery.normalizeSync(sql));
    const fingerprint = pgQuery.fingerprintSync(stripped);
    const t = truncateBytes(stripped, MAX_STATEMENT_BYTES);
    return { text: t.text, fingerprint, truncated: t.truncated, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: null, fingerprint: null, truncated: false, error: message.slice(0, 300) };
  }
}

/** 语句的指纹（16 位十六进制）；无法解析时为 null。常量与 $n 占位符、注释与空白不影响指纹 */
export async function statementFingerprint(sql: string): Promise<string | null> {
  await loadSqlParser();
  try {
    return pgQuery.fingerprintSync(sql);
  } catch {
    return null;
  }
}

/** 已经加载解析器之后的同步版本（代码定位在大量字面量上调用）；没有加载时抛错 */
export function statementFingerprintSync(sql: string): string | null {
  if (!loaded) {
    throw new Error('SQL 解析器还没有加载，先 await loadSqlParser()');
  }
  try {
    return pgQuery.fingerprintSync(sql);
  } catch {
    return null;
  }
}
