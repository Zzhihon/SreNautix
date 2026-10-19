import { generateKeyPairSync } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectLockConfigurationCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAudit,
  GENESIS_HASH,
  readAudit,
  recordHash,
  verifyCheckpoint,
  verifyRecords,
  type AuditCheckpoint,
  type AuditRecord,
} from '../../src/store/audit.js';
import { AuditExporter, readSink, s3Client } from '../../src/store/audit-export.js';
import { verifyChain } from '../../src/store/audit-verify.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { tx } from '../../src/store/pool.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { startMinio, type TestMinio } from '../support/minio.js';

const BUCKET = 'srenautix-audit';
const PREFIX = 'governance/';

let db: TestDb;
let minio: TestMinio;
let s3: S3Client;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack]);
  minio = await startMinio();
  s3 = s3Client({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    bucket: BUCKET,
    prefix: PREFIX,
    accessKey: minio.accessKey,
    secretKey: minio.secretKey,
    forcePathStyle: true,
  });
  // 与部署一致：开启对象锁定，默认保留期保护已写入的对象版本
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
  await s3.send(
    new PutObjectLockConfigurationCommand({
      Bucket: BUCKET,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
      },
    }),
  );
});

afterAll(async () => {
  s3.destroy();
  await minio.stop();
  await db.close();
});

const append = (kind: string, data: unknown) => tx(db.server, (c) => appendAudit(c, kind, 'tester', data));

describe('哈希链', () => {
  it('每条记录接上一条的哈希，篡改任何字段都能被发现', async () => {
    for (let i = 0; i < 5; i++) {
      await append('test.event', { i });
    }
    const recs = await readAudit(db.server, 0, 100);
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(recs[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(verifyRecords(recs, { seq: 0, hash: GENESIS_HASH })).toBeNull();

    const changed = recs.map((r) => (r.seq === 3 ? { ...r, data: { i: 99 } } : r));
    expect(verifyRecords(changed, { seq: 0, hash: GENESIS_HASH })).toBe('seq 3 的哈希不正确');

    const rehashed = recs.map((r) => {
      if (r.seq !== 3) {
        return r;
      }
      const rest: Omit<AuditRecord, 'hash'> = {
        chain: r.chain,
        seq: r.seq,
        prev_hash: r.prev_hash,
        at: r.at,
        kind: r.kind,
        actor: r.actor,
        data: { i: 99 },
        canon_version: r.canon_version,
      };
      return { ...rest, hash: recordHash(rest) };
    });
    expect(verifyRecords(rehashed, { seq: 0, hash: GENESIS_HASH })).toBe('seq 4 的 prev_hash 与上一条不一致');
    expect(verifyRecords([recs[0], recs[2]] as AuditRecord[], { seq: 0, hash: GENESIS_HASH })).toBe(
      'seq 3 不连续（上一条 1）',
    );
  });

  it('并发追加时 seq 连续、链不分叉', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => append('test.concurrent', { i })));
    const recs = await readAudit(db.server, 0, 1000);
    expect(verifyRecords(recs, { seq: 0, hash: GENESIS_HASH })).toBeNull();
    expect(recs).toHaveLength(25);
  });
});

describe('导出到对象存储（MinIO）与校验', () => {
  let exporter: AuditExporter;

  it('检查点签名可以用公钥校验，篡改后失败', async () => {
    exporter = new AuditExporter(db.server, { client: s3, bucket: BUCKET, prefix: PREFIX }, privateKey, 'k1');
    const cp = (await exporter.checkpoint()) as AuditCheckpoint;
    expect(cp.seq).toBe(25);
    expect(verifyCheckpoint(cp, publicKey)).toBe(true);
    expect(verifyCheckpoint({ ...cp, seq: 24 }, publicKey)).toBe(false);
    expect(await exporter.checkpoint()).toBeNull();
  });

  it('导出全部记录与检查点，导出延迟归零，对象存储中的副本校验通过', async () => {
    expect((await exporter.status()).lagSeconds).toBeGreaterThan(0);
    expect(await exporter.exportOnce()).toBe(25);
    expect(await exporter.status()).toEqual({ lagSeconds: 0, sink: 's3' });
    expect(await exporter.exportOnce()).toBe(0);
    const sink = await readSink(s3, BUCKET, PREFIX);
    expect(sink.records).toHaveLength(25);
    expect(sink.checkpoints).toHaveLength(1);
    expect(verifyChain(sink.records, sink.checkpoints, sink.segments, publicKey).errors).toEqual([]);
  });

  it('恢复模式新开一段链，锚定到审计汇的最后一个哈希', async () => {
    const before = await readSink(s3, BUCKET, PREFIX);
    const head = before.records[before.records.length - 1] as AuditRecord;
    // 模拟从备份恢复：库中的链头之后新开一段，起点是审计汇中最后一条之后
    await db.server.query(
      "INSERT INTO server.governance_segments (start_seq, anchor_seq, anchor_hash, reason) VALUES ($1, $2, $3, 'restored')",
      [head.seq + 1, head.seq, head.hash],
    );
    await append('restore.started', { anchor_seq: head.seq });
    await append('test.after_restore', {});
    await exporter.checkpoint();
    expect(await exporter.exportOnce()).toBe(2);
    const sink = await readSink(s3, BUCKET, PREFIX);
    expect(sink.segments).toEqual([
      expect.objectContaining({ start_seq: head.seq + 1, anchor_seq: head.seq, anchor_hash: head.hash }),
    ]);
    const report = verifyChain(sink.records, sink.checkpoints, sink.segments, publicKey);
    expect(report.errors).toEqual([]);
    expect(report.head?.seq).toBe(27);
  });

  it('改写对象存储中的记录后校验失败', async () => {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}records/` }));
    const key = list.Contents?.[0]?.Key as string;
    const body = await (
      await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    ).Body?.transformToString('utf8');
    const lines = (body as string).trim().split('\n');
    const first = JSON.parse(lines[1] as string) as AuditRecord;
    lines[1] = JSON.stringify({ ...first, actor: 'someone-else' });
    // 对象锁定保护的是旧版本：新写入的是同名对象的新版本，读取时取到的是被改写的内容
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: `${lines.join('\n')}\n` }));
    const sink = await readSink(s3, BUCKET, PREFIX);
    const report = verifyChain(sink.records, sink.checkpoints, sink.segments, publicKey);
    expect(report.errors).toContain(`seq ${first.seq} 的哈希不正确`);
  });

  it('没有对象存储时记录留在 PG，状态为 pg', async () => {
    const pgOnly = new AuditExporter(db.server, null, privateKey, 'k1');
    expect(await pgOnly.exportOnce()).toBe(0);
    expect(await pgOnly.status()).toEqual({ lagSeconds: 0, sink: 'pg' });
  });
});
