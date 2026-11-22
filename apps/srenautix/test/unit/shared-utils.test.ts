import { describe, expect, it } from 'vitest';
import { durationMs, HOUR_MS } from '../../src/shared/duration.js';
import { pgReadConnection } from '../../src/shared/pg-connection.js';
import { BLOB_CACHE_BYTES, RepoCodeCache, TREE_COMMITS, type GitHubReader } from '../../src/shared/repo-code-cache.js';

describe('shared/duration', () => {
  it('解析 ms/s/m/h/d/w 及组合时长为毫秒，非法字符串抛出错误', () => {
    expect(HOUR_MS).toBe(3_600_000);
    expect(durationMs('500ms')).toBe(500);
    expect(durationMs('30s')).toBe(30_000);
    expect(durationMs('15m')).toBe(900_000);
    expect(durationMs('24h')).toBe(24 * HOUR_MS);
    expect(durationMs('1d12h')).toBe(36 * HOUR_MS);
    expect(durationMs('7d')).toBe(7 * 24 * HOUR_MS);
    expect(durationMs('1w')).toBe(7 * 24 * HOUR_MS);
    expect(() => durationMs('1y')).toThrow(/时长不合法/);
    expect(() => durationMs('')).toThrow(/时长不合法/);
  });
});

describe('shared/pg-connection', () => {
  it('应用只读连接默认值并拒绝未知字段', () => {
    const parsed = pgReadConnection.parse({
      host: 'pg.local',
      database: 'app',
      password_file: '/etc/srenautix/secrets/pg/password',
    });
    expect(parsed).toEqual({
      host: 'pg.local',
      port: 5432,
      database: 'app',
      user: 'srenautix_stats',
      password_file: '/etc/srenautix/secrets/pg/password',
      ssl: false,
    });
    expect(() =>
      pgReadConnection.parse({
        host: 'pg.local',
        database: 'app',
        password_file: '/p',
        write: true,
      }),
    ).toThrow();
  });
});

describe('shared/repo-code-cache', () => {
  const sha = (ch: string) => ch.repeat(40);

  it('按提交缓存目录树与 blob 内容，校验 blob sha 并限制树缓存数', async () => {
    const calls: string[] = [];
    const blobs = new Map<string, { sha: string; content: string }>([
      ['src/a.ts', { sha: '1'.repeat(40), content: Buffer.from('export const a = 1;').toString('base64') }],
      ['src/bad.ts', { sha: '9'.repeat(40), content: Buffer.from('mismatch').toString('base64') }],
    ]);
    const gh: GitHubReader = {
      async api<T>(_method: string, path: string): Promise<T> {
        calls.push(path);
        if (path.includes('/git/trees/')) {
          return {
            sha: sha('a'),
            truncated: false,
            tree: [
              { path: 'src', type: 'tree', sha: '0'.repeat(40) },
              { path: 'src/a.ts', type: 'blob', sha: '1'.repeat(40), size: 19 },
              { path: 'src/bad.ts', type: 'blob', sha: '2'.repeat(40), size: 8 },
            ],
          } as T;
        }
        const match = /\/contents\/(.+)\?ref=/.exec(path);
        const filePath = decodeURIComponent(match![1]!);
        const b = blobs.get(filePath)!;
        return { type: 'file', encoding: 'base64', sha: b.sha, size: b.content.length, content: b.content } as T;
      },
    };

    const cache = new RepoCodeCache(gh);
    expect(TREE_COMMITS).toBe(3);
    expect(BLOB_CACHE_BYTES).toBeGreaterThan(0);

    await expect(cache.tree('org/repo', 'short-sha')).rejects.toThrow(/完整的提交 sha/);

    const t1 = await cache.tree('Org/Repo', sha('a'));
    const t2 = await cache.tree('org/repo', sha('a'));
    expect(t1).toBe(t2);
    expect(t1.entries.map((e) => e.path)).toEqual(['src/a.ts', 'src/bad.ts']);
    expect(cache.requests).toBe(1);

    const content1 = await cache.content('org/repo', sha('a'), t1.entries[0]!);
    const content2 = await cache.content('org/repo', sha('a'), t1.entries[0]!);
    expect(content1).toBe('export const a = 1;');
    expect(content2).toBe(content1);
    expect(cache.requests).toBe(2);

    await expect(cache.content('org/repo', sha('a'), t1.entries[1]!)).rejects.toThrow(/不一致/);

    // 填满超过 TREE_COMMITS 个提交时淘汰最早的提交树
    await cache.tree('org/repo', sha('b'));
    await cache.tree('org/repo', sha('c'));
    await cache.tree('org/repo', sha('d'));
    const beforeEvictedReload = cache.requests;
    await cache.tree('org/repo', sha('a'));
    expect(cache.requests).toBe(beforeEvictedReload + 1);
    expect(calls.length).toBe(cache.requests);
  });
});
