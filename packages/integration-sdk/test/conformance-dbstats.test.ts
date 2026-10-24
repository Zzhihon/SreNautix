// dbstats/v1 的一致性测试：在每个可用的 PostgreSQL 版本上（SRENAUTIX_PG_BINS，逗号分隔；默认 Homebrew 的 16、17、18）
// 启动预加载 pg_stat_statements 的实例，执行 runDbstatsConformance 的全部检查。没有可用的二进制时测试失败。
import { describe, expect, it } from 'vitest';
import { runDbstatsConformance } from '../src/conformance/dbstats.js';
import {
  normalizeStatement,
  statementFingerprint,
  statementFingerprintSync,
  loadSqlParser,
} from '../src/dbstats/normalize.js';
import { postgresBins, startPostgres } from '../src/testing/postgres.js';

describe('SQL 规范化与指纹', () => {
  it('常量换成 $n、去掉注释、合并空白；指纹与常量、注释和空白无关', async () => {
    const n = await normalizeStatement("SELECT a /* x */ FROM t -- y\n  WHERE id = 42 AND s IN ('a', 'b')");
    expect(n).toEqual({
      text: 'SELECT a FROM t WHERE id = $1 AND s IN ($2, $3)',
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      truncated: false,
      error: null,
    });
    expect(await statementFingerprint('select a from t where id = $1 and s in ($2, $3)')).toBe(n.fingerprint);
    expect(await statementFingerprint('SELECT a FROM t WHERE id = 7')).not.toBe(n.fingerprint);
    await loadSqlParser();
    expect(statementFingerprintSync("SELECT a FROM t WHERE id = 1 AND s IN ('z')")).toBe(n.fingerprint);
  });

  it('无法解析时给出原因；超过 4 KiB 按字节截断，不切断多字节字符', async () => {
    expect(await normalizeStatement('SELEC oops')).toMatchObject({ text: null, fingerprint: null });
    expect(await statementFingerprint('SELEC oops')).toBeNull();
    const long = `SELECT '${'中'.repeat(10)}' AS x, ${Array.from({ length: 900 }, (_, i) => `c${i}`).join(', ')} FROM t`;
    const n = await normalizeStatement(long);
    expect(n.truncated).toBe(true);
    expect(Buffer.byteLength(n.text!, 'utf8')).toBeLessThanOrEqual(4096);
    expect(n.text!.startsWith('SELECT $1 AS x, c0, c1')).toBe(true);
  });
});

const bins = postgresBins();

describe('dbstats/v1 一致性', () => {
  it('至少有一个可用的 PostgreSQL 版本', () => {
    expect(bins.length, '设置 SRENAUTIX_PG_BINS 或 SRENAUTIX_PG_BIN').toBeGreaterThan(0);
  });

  for (const bin of bins) {
    it(`PostgreSQL（${bin}）`, async () => {
      const pg = await startPostgres(bin);
      try {
        const report = await runDbstatsConformance(pg);
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        expect(report.checks.length).toBeGreaterThanOrEqual(13);
      } finally {
        await pg.stop();
      }
    });
  }
});
