import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import { logger } from '../log.js';
import { AUDIT_CANON_VERSION, readAudit, signCheckpoint, type AuditCheckpoint, type AuditRecord } from './audit.js';
import { tx } from './pool.js';

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export function s3Client(s: S3Settings): S3Client {
  return new S3Client({
    endpoint: s.endpoint,
    region: s.region,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  });
}

const pad = (n: number) => String(n).padStart(12, '0');

export const recordsKey = (prefix: string, from: number, to: number) =>
  `${prefix}records/${pad(from)}-${pad(to)}.jsonl`;
export const checkpointKey = (prefix: string, seq: number) => `${prefix}checkpoints/${pad(seq)}.json`;
export const segmentKey = (prefix: string, start: number) => `${prefix}segments/${pad(start)}.json`;

export interface ExportStatus {
  /** 最早一条未导出记录的等待秒数；全部导出时为 0。 */
  lagSeconds: number;
  sink: 's3' | 'pg';
}

/**
 * 治理审计链导出（DESIGN §16.3）：把未导出的记录按批写成 JSONL 对象（对象不可覆盖，开启对象锁定时由桶的默认保留期保护），
 * 定期为链头签一个 Ed25519 检查点并导出。没有对象存储时记录只在 PG 中，状态为 sink=pg。
 */
export class AuditExporter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly s3: { client: S3Client; bucket: string; prefix: string } | null,
    private readonly checkpointKeyObj: KeyObject,
    private readonly keyId: string,
  ) {}

  async exportOnce(): Promise<number> {
    if (!this.s3) {
      return 0;
    }
    let total = 0;
    for (;;) {
      const r = await this.pool.query<{ seq: number }>(
        'SELECT seq FROM server.governance_audit WHERE exported_at IS NULL ORDER BY seq LIMIT 1',
      );
      const first = r.rows[0];
      if (!first) {
        break;
      }
      const batch = await readAudit(this.pool, first.seq - 1, 500);
      // 只导出连续的一段，遇到已导出的记录（并发导出或恢复后重放）即停
      const exportedSeqs = await this.pool.query<{ seq: number }>(
        'SELECT seq FROM server.governance_audit WHERE seq = ANY($1::bigint[]) AND exported_at IS NOT NULL',
        [batch.map((x) => x.seq)],
      );
      const done = new Set(exportedSeqs.rows.map((x) => x.seq));
      const run: AuditRecord[] = [];
      for (const rec of batch) {
        if (done.has(rec.seq)) {
          break;
        }
        run.push(rec);
      }
      if (!run.length) {
        break;
      }
      const from = (run[0] as AuditRecord).seq;
      const to = (run[run.length - 1] as AuditRecord).seq;
      const key = recordsKey(this.s3.prefix, from, to);
      await this.s3.client.send(
        new PutObjectCommand({
          Bucket: this.s3.bucket,
          Key: key,
          Body: run.map((x) => JSON.stringify(x)).join('\n') + '\n',
          ContentType: 'application/x-ndjson',
        }),
      );
      await this.pool.query(
        'UPDATE server.governance_audit SET exported_at = now(), export_object = $3 WHERE seq BETWEEN $1 AND $2',
        [from, to, key],
      );
      total += run.length;
    }
    await this.exportSegments();
    await this.exportCheckpoints();
    return total;
  }

  private async exportSegments(): Promise<void> {
    if (!this.s3) {
      return;
    }
    const segs = await this.pool.query<{
      start_seq: number;
      anchor_seq: number;
      anchor_hash: string;
      reason: string;
      created_at: Date;
    }>(
      'SELECT start_seq, anchor_seq, anchor_hash, reason, created_at FROM server.governance_segments ORDER BY start_seq',
    );
    for (const s of segs.rows) {
      await this.s3.client.send(
        new PutObjectCommand({
          Bucket: this.s3.bucket,
          Key: segmentKey(this.s3.prefix, s.start_seq),
          Body: JSON.stringify({
            start_seq: s.start_seq,
            anchor_seq: s.anchor_seq,
            anchor_hash: s.anchor_hash,
            reason: s.reason,
            created_at: s.created_at.toISOString(),
          }),
          ContentType: 'application/json',
        }),
      );
    }
  }

  private async exportCheckpoints(): Promise<void> {
    if (!this.s3) {
      return;
    }
    const r = await this.pool.query<{ seq: number; body: AuditCheckpoint }>(
      'SELECT seq, body FROM server.governance_checkpoints WHERE exported_at IS NULL ORDER BY seq',
    );
    for (const c of r.rows) {
      await this.s3.client.send(
        new PutObjectCommand({
          Bucket: this.s3.bucket,
          Key: checkpointKey(this.s3.prefix, c.seq),
          Body: JSON.stringify(c.body),
          ContentType: 'application/json',
        }),
      );
      await this.pool.query('UPDATE server.governance_checkpoints SET exported_at = now() WHERE seq = $1', [c.seq]);
    }
  }

  /** 为当前链头签一个检查点（链头已有检查点时不重复签）。 */
  async checkpoint(): Promise<AuditCheckpoint | null> {
    return tx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['srenautix.audit.governance']);
      const head = await c.query<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM server.governance_audit ORDER BY seq DESC LIMIT 1',
      );
      const h = head.rows[0];
      if (!h) {
        return null;
      }
      const exists = await c.query('SELECT 1 FROM server.governance_checkpoints WHERE seq = $1', [h.seq]);
      if (exists.rowCount) {
        return null;
      }
      const now = await c.query<{ now: Date }>('SELECT now() AS now');
      const cp = signCheckpoint(
        {
          chain: 'governance',
          seq: h.seq,
          hash: h.hash,
          at: (now.rows[0] as { now: Date }).now.toISOString(),
          key_id: this.keyId,
          algorithm: 'ed25519',
          canon_version: AUDIT_CANON_VERSION,
        },
        this.checkpointKeyObj,
      );
      await c.query('INSERT INTO server.governance_checkpoints (seq, body) VALUES ($1, $2)', [
        cp.seq,
        JSON.stringify(cp),
      ]);
      return cp;
    });
  }

  async status(): Promise<ExportStatus> {
    const r = await this.pool.query<{ lag: number | null }>(
      'SELECT EXTRACT(EPOCH FROM now() - min(at))::float8 AS lag FROM server.governance_audit WHERE exported_at IS NULL',
    );
    return { lagSeconds: this.s3 ? Math.max(0, r.rows[0]?.lag ?? 0) : 0, sink: this.s3 ? 's3' : 'pg' };
  }

  runLoop(intervalMs: number, checkpointMs: number, signal: AbortSignal, onStatus: (s: ExportStatus) => void): void {
    let lastCheckpoint = 0;
    const tick = async () => {
      try {
        if (Date.now() - lastCheckpoint >= checkpointMs) {
          await this.checkpoint();
          lastCheckpoint = Date.now();
        }
        await this.exportOnce();
      } catch (e) {
        logger.warn('审计导出失败，下一轮重试', { error: e });
      }
      try {
        onStatus(await this.status());
      } catch (e) {
        logger.warn('审计导出状态读取失败', { error: e });
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    void tick();
  }
}

/** 从对象存储读取全部记录、链段与检查点（校验命令用）。 */
export async function readSink(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<{
  records: AuditRecord[];
  checkpoints: AuditCheckpoint[];
  segments: Array<{ start_seq: number; anchor_seq: number; anchor_hash: string }>;
}> {
  const list = async (p: string): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: p, ContinuationToken: token }));
      keys.push(...(r.Contents ?? []).map((o) => o.Key as string));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  };
  const get = async (k: string): Promise<string> => {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k }));
    return (await r.Body?.transformToString('utf8')) ?? '';
  };
  const records: AuditRecord[] = [];
  for (const k of await list(`${prefix}records/`)) {
    for (const line of (await get(k)).split('\n')) {
      if (line.trim()) {
        records.push(JSON.parse(line) as AuditRecord);
      }
    }
  }
  records.sort((a, b) => a.seq - b.seq);
  const checkpoints: AuditCheckpoint[] = [];
  for (const k of await list(`${prefix}checkpoints/`)) {
    checkpoints.push(JSON.parse(await get(k)) as AuditCheckpoint);
  }
  const segments: Array<{ start_seq: number; anchor_seq: number; anchor_hash: string }> = [];
  for (const k of await list(`${prefix}segments/`)) {
    segments.push(JSON.parse(await get(k)) as { start_seq: number; anchor_seq: number; anchor_hash: string });
  }
  return { records, checkpoints, segments };
}
