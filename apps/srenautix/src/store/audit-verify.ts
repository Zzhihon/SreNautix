import type { KeyObject } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pgConfigFromEnv } from '../config/database.js';
import { readSecretFile } from '../config/files.js';
import { loadServerConfig } from '../config/server.js';
import {
  GENESIS_HASH,
  loadEd25519Private,
  publicKeyOf,
  readAudit,
  verifyCheckpoint,
  verifyRecords,
  type AuditCheckpoint,
  type AuditRecord,
} from './audit.js';
import { readSink, s3Client } from './audit-export.js';
import { createPool } from './pool.js';

export interface VerifyReport {
  records: number;
  checkpoints: number;
  segments: number;
  head: { seq: number; hash: string } | null;
  errors: string[];
}

/**
 * 校验一条治理链：记录按 seq 连续、每条哈希正确、prev_hash 接上一条（链段起点接锚定哈希），
 * 每个检查点的签名有效且与对应记录的哈希一致。
 */
export function verifyChain(
  records: readonly AuditRecord[],
  checkpoints: readonly AuditCheckpoint[],
  segments: ReadonlyArray<{ start_seq: number; anchor_seq: number; anchor_hash: string }>,
  publicKey: KeyObject,
): VerifyReport {
  const errors: string[] = [];
  const starts = [...segments].sort((a, b) => a.start_seq - b.start_seq);
  const parts: AuditRecord[][] = [];
  let cur: AuditRecord[] = [];
  for (const r of records) {
    if (starts.some((s) => s.start_seq === r.seq) && cur.length) {
      parts.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) {
    parts.push(cur);
  }
  for (const part of parts) {
    const first = part[0] as AuditRecord;
    const seg = starts.find((s) => s.start_seq === first.seq);
    const anchor = seg
      ? { seq: first.seq - 1, hash: seg.anchor_hash }
      : first.seq === 1
        ? { seq: 0, hash: GENESIS_HASH }
        : null;
    if (!anchor) {
      errors.push(`seq ${first.seq} 之前的记录缺失`);
      continue;
    }
    const e = verifyRecords(part, anchor);
    if (e) {
      errors.push(e);
    }
  }
  const bySeq = new Map(records.map((r) => [r.seq, r]));
  for (const c of checkpoints) {
    if (!verifyCheckpoint(c, publicKey)) {
      errors.push(`检查点 ${c.seq} 签名无效`);
      continue;
    }
    const r = bySeq.get(c.seq);
    if (!r) {
      errors.push(`检查点 ${c.seq} 对应的记录缺失`);
    } else if (r.hash !== c.hash) {
      errors.push(`检查点 ${c.seq} 的哈希与记录不一致`);
    }
  }
  const last = records[records.length - 1];
  return {
    records: records.length,
    checkpoints: checkpoints.length,
    segments: segments.length,
    head: last ? { seq: last.seq, hash: last.hash } : null,
    errors,
  };
}

/** `audit verify [--source=s3|pg]`：默认校验对象存储中的副本，没有对象存储时校验 PG。 */
export async function verifyCommand(configPath: string, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { source: { type: 'string' } } });
  const cfg = loadServerConfig(configPath);
  const key = publicKeyOf(
    loadEd25519Private(readSecretFile('audit.checkpoint_key_file', cfg.audit.checkpoint_key_file)),
  );
  const source = values.source ?? (cfg.audit.s3 ? 's3' : 'pg');
  let report: VerifyReport;
  if (source === 's3') {
    const s = cfg.audit.s3;
    if (!s) {
      throw new Error('没有配置 audit.s3');
    }
    const client = s3Client({
      endpoint: s.endpoint,
      region: s.region,
      bucket: s.bucket,
      prefix: s.prefix,
      accessKey: readSecretFile('audit.s3.access_key_file', s.access_key_file),
      secretKey: readSecretFile('audit.s3.secret_key_file', s.secret_key_file),
      forcePathStyle: s.force_path_style,
    });
    const sink = await readSink(client, s.bucket, s.prefix);
    report = verifyChain(sink.records, sink.checkpoints, sink.segments, key);
  } else {
    const pool = createPool(pgConfigFromEnv(process.env, cfg.database.password_file), 'srenautix-audit-verify', 1);
    const records: AuditRecord[] = [];
    for (let after = 0; ;) {
      const b = await readAudit(pool, after, 5000);
      if (!b.length) {
        break;
      }
      records.push(...b);
      after = (b[b.length - 1] as AuditRecord).seq;
    }
    const cps = await pool.query<{ body: AuditCheckpoint }>(
      'SELECT body FROM server.governance_checkpoints ORDER BY seq',
    );
    const segs = await pool.query<{ start_seq: number; anchor_seq: number; anchor_hash: string }>(
      'SELECT start_seq, anchor_seq, anchor_hash FROM server.governance_segments',
    );
    await pool.end();
    report = verifyChain(
      records,
      cps.rows.map((r) => r.body),
      segs.rows,
      key,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) {
    process.exitCode = 2;
  }
}
