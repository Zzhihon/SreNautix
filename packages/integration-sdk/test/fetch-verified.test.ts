import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchVerified } from '../src/testing/backends.js';

// 本地 HTTP 服务按路径返回预设的状态码序列，验证下载的重试规则：5xx 与 429 重试，其余 HTTP 错误直接失败
const body = Buffer.from('backend archive');
const sha = createHash('sha256').update(body).digest('hex');
const plans: Record<string, number[]> = {
  '/flaky': [503, 504, 200],
  '/missing': [404, 200],
  '/down': [502, 502, 502, 502, 502],
};
const hits: Record<string, number> = {};
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '';
    const n = hits[path] ?? 0;
    hits[path] = n + 1;
    const status = plans[path]?.[n] ?? 500;
    res.writeHead(status).end(status === 200 ? body : 'error');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('fetchVerified 的重试', () => {
  it('5xx 之后重试，成功时返回校验过的内容', async () => {
    const got = await fetchVerified(`${base}/flaky`, sha, { backoffMs: 1 });
    expect(got.equals(body)).toBe(true);
    expect(hits['/flaky']).toBe(3);
  });

  it('404 不重试', async () => {
    await expect(fetchVerified(`${base}/missing`, sha, { backoffMs: 1 })).rejects.toThrow('HTTP 404');
    expect(hits['/missing']).toBe(1);
  });

  it('5 次都是 5xx 时报错并给出最后的状态码', async () => {
    await expect(fetchVerified(`${base}/down`, sha, { backoffMs: 1 })).rejects.toThrow('（5 次）：HTTP 502');
    expect(hits['/down']).toBe(5);
  });
});
