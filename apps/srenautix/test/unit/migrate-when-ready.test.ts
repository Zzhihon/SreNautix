import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { databaseNotReady, migrateWhenReady } from '../../src/store/migrate-when-ready.js';

// 启动时数据库还没准备好（ADR 0102）：重试并保持 not ready，进程不退出；其他错误照常抛出

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => res(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

describe('启动时等待数据库', () => {
  it('schema 不存在、角色未建、连接被拒绝算"没准备好"；SQL 错误不算', () => {
    expect(databaseNotReady(pgError('3F000', 'schema "server" does not exist'))).toMatch(/^3F000/);
    expect(databaseNotReady(pgError('28P01', 'password authentication failed'))).toMatch(/^28P01/);
    expect(databaseNotReady(pgError('ECONNREFUSED', 'connect ECONNREFUSED'))).toMatch(/^ECONNREFUSED/);
    expect(databaseNotReady(pgError('42601', 'syntax error'))).toBeNull();
    expect(databaseNotReady(new Error('收缩迁移不兼容'))).toBeNull();
  });

  it('等待期间 /healthz 为 200、/readyz 为 503 并写明原因；就绪后迁移结果原样返回，临时探针端口关闭', async () => {
    const port = await freePort();
    let calls = 0;
    const seen: Array<[number, number, string]> = [];
    const result = await migrateWhenReady(
      'server',
      async () => {
        calls++;
        if (calls <= 2) {
          throw pgError('3F000', 'schema "server" does not exist');
        }
        return ['incident/3'];
      },
      {
        probes: { host: '127.0.0.1', port },
        initialDelayMs: 1,
        sleep: async () => {
          const h = await fetch(`http://127.0.0.1:${port}/healthz`);
          const r = await fetch(`http://127.0.0.1:${port}/readyz`);
          seen.push([h.status, r.status, await r.text()]);
        },
      },
    );
    expect(result).toEqual(['incident/3']);
    expect(calls).toBe(3);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.slice(0, 2)).toEqual([200, 503]);
    expect(seen[0]?.[2]).toMatch(/waiting for the database \(3F000: schema "server" does not exist\)/);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it('其他错误不重试，直接抛出（进程退出）', async () => {
    let calls = 0;
    await expect(
      migrateWhenReady(
        'worker',
        async () => {
          calls++;
          throw pgError('42601', 'syntax error at or near "CREATE"');
        },
        { probes: null, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/syntax error/);
    expect(calls).toBe(1);
  });

  it('退避从初始间隔倍增，封顶', async () => {
    const delays: number[] = [];
    let calls = 0;
    await migrateWhenReady(
      'server',
      async () => {
        if (++calls <= 6) {
          throw pgError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:5432');
        }
        return [];
      },
      { probes: null, initialDelayMs: 2000, maxDelayMs: 30_000, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });
});
