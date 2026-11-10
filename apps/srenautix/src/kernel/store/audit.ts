import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import canonicalize from 'canonicalize';
import type pg from 'pg';
import type { Queryable } from './pool.js';

/** 规范化版本：记录与检查点的哈希都按 JCS（RFC 8785）序列化后取 sha256。 */
export const AUDIT_CANON_VERSION = 'jcs-sha256-v1';

export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;

/** 治理链的一条记录（DESIGN §16.3）。hash = sha256(JCS(除 hash 以外的全部字段))。 */
export interface AuditRecord {
  chain: 'governance';
  seq: number;
  prev_hash: string;
  at: string;
  kind: string;
  actor: string;
  data: unknown;
  canon_version: string;
  hash: string;
}

/** 定期签名的检查点：覆盖到 seq 为止的链头。 */
export interface AuditCheckpoint {
  chain: 'governance';
  seq: number;
  hash: string;
  at: string;
  key_id: string;
  algorithm: 'ed25519';
  canon_version: string;
  signature: string;
}

export function jcs(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) {
    throw new Error('无法规范化的值');
  }
  return s;
}

export function sha256Hex(s: string): string {
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

export function recordHash(r: Omit<AuditRecord, 'hash'>): string {
  return sha256Hex(jcs(r));
}

function checkpointPayload(c: Omit<AuditCheckpoint, 'signature'>): Buffer {
  return Buffer.from(jcs(c), 'utf8');
}

export function signCheckpoint(c: Omit<AuditCheckpoint, 'signature'>, key: KeyObject): AuditCheckpoint {
  return { ...c, signature: sign(null, checkpointPayload(c), key).toString('base64') };
}

export function verifyCheckpoint(c: AuditCheckpoint, publicKey: KeyObject): boolean {
  const { signature, ...rest } = c;
  return verify(null, checkpointPayload(rest), publicKey, Buffer.from(signature, 'base64'));
}

export function loadEd25519Private(pem: string): KeyObject {
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') {
    throw new Error(`签名密钥必须是 Ed25519，实际为 ${k.asymmetricKeyType}`);
  }
  return k;
}

export function publicKeyOf(k: KeyObject): KeyObject {
  return createPublicKey(k);
}

/** 校验一段连续的记录：哈希、前后链接、seq 连续。返回第一处错误，没有错误时为 null。 */
export function verifyRecords(records: readonly AuditRecord[], anchor: { seq: number; hash: string }): string | null {
  let prev = anchor;
  for (const r of records) {
    if (r.seq !== prev.seq + 1) {
      return `seq ${r.seq} 不连续（上一条 ${prev.seq}）`;
    }
    if (r.prev_hash !== prev.hash) {
      return `seq ${r.seq} 的 prev_hash 与上一条不一致`;
    }
    const { hash, ...rest } = r;
    if (recordHash(rest) !== hash) {
      return `seq ${r.seq} 的哈希不正确`;
    }
    prev = { seq: r.seq, hash };
  }
  return null;
}

export const auditDdl = `
-- 治理审计链（DESIGN §16.3）。先写这里，再由导出循环写入对象存储；exported_at 为空表示尚未导出。
-- 没有对象存储时（标准配置）这里就是审计的落点，控制台持续提示风险。
CREATE TABLE server.governance_audit (
  seq bigint PRIMARY KEY,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE,
  at timestamptz NOT NULL,
  kind text NOT NULL,
  actor text NOT NULL,
  data jsonb NOT NULL,
  canon_version text NOT NULL,
  exported_at timestamptz,
  export_object text
);
CREATE INDEX governance_audit_unexported_idx ON server.governance_audit (seq) WHERE exported_at IS NULL;

CREATE TABLE server.governance_checkpoints (
  seq bigint PRIMARY KEY REFERENCES server.governance_audit (seq),
  body jsonb NOT NULL,
  exported_at timestamptz
);

-- 链段：恢复模式（DESIGN §15.3）新开一段，锚定到审计汇的最后一个哈希
CREATE TABLE server.governance_segments (
  start_seq bigint PRIMARY KEY,
  anchor_seq bigint NOT NULL,
  anchor_hash text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

/** 在调用方的事务里追加一条治理审计记录；用事务级 advisory lock 串行化链头。 */
export async function appendAudit(c: Queryable, kind: string, actor: string, data: unknown): Promise<AuditRecord> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['srenautix.audit.governance']);
  const head = await c.query<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM server.governance_audit ORDER BY seq DESC LIMIT 1',
  );
  const seg = await c.query<{ start_seq: number; anchor_seq: number; anchor_hash: string }>(
    'SELECT start_seq, anchor_seq, anchor_hash FROM server.governance_segments ORDER BY start_seq DESC LIMIT 1',
  );
  const last = head.rows[0];
  const segment = seg.rows[0];
  let prev: { seq: number; hash: string };
  if (segment && (!last || last.seq < segment.start_seq)) {
    prev = { seq: segment.start_seq - 1, hash: segment.anchor_hash };
  } else {
    prev = last ?? { seq: 0, hash: GENESIS_HASH };
  }
  const now = await c.query<{ now: Date }>('SELECT now() AS now');
  const base: Omit<AuditRecord, 'hash'> = {
    chain: 'governance',
    seq: prev.seq + 1,
    prev_hash: prev.hash,
    at: (now.rows[0] as { now: Date }).now.toISOString(),
    kind,
    actor,
    data: data ?? null,
    canon_version: AUDIT_CANON_VERSION,
  };
  const rec: AuditRecord = { ...base, hash: recordHash(base) };
  await c.query(
    'INSERT INTO server.governance_audit (seq, prev_hash, hash, at, kind, actor, data, canon_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [rec.seq, rec.prev_hash, rec.hash, rec.at, rec.kind, rec.actor, JSON.stringify(rec.data), rec.canon_version],
  );
  return rec;
}

interface Row {
  seq: number;
  prev_hash: string;
  hash: string;
  at: Date;
  kind: string;
  actor: string;
  data: unknown;
  canon_version: string;
}

export function rowToRecord(r: Row): AuditRecord {
  return {
    chain: 'governance',
    seq: r.seq,
    prev_hash: r.prev_hash,
    at: r.at.toISOString(),
    kind: r.kind,
    actor: r.actor,
    data: r.data,
    canon_version: r.canon_version,
    hash: r.hash,
  };
}

export async function readAudit(pool: pg.Pool | Queryable, afterSeq: number, limit: number): Promise<AuditRecord[]> {
  const r = await pool.query<Row>(
    'SELECT seq, prev_hash, hash, at, kind, actor, data, canon_version FROM server.governance_audit WHERE seq > $1 ORDER BY seq LIMIT $2',
    [afterSeq, limit],
  );
  return r.rows.map(rowToRecord);
}
