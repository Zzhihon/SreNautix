import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.js';

// 自定义 CA 走真实的 TLS 握手：CA 与服务端证书在测试开始时用 openssl 生成
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'http-tls-'));
  const f = (n: string) => join(dir, n);
  const ssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  ssl(
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=test-ca',
    '-keyout',
    f('ca.key'),
    '-out',
    f('ca.crt'),
  );
  ssl(
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    f('tls.key'),
    '-out',
    f('tls.csr'),
  );
  writeFileSync(f('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  ssl(
    'x509',
    '-req',
    '-in',
    f('tls.csr'),
    '-CA',
    f('ca.crt'),
    '-CAkey',
    f('ca.key'),
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    f('ext.cnf'),
    '-out',
    f('tls.crt'),
  );
  server = createServer({ key: readFileSync(f('tls.key')), cert: readFileSync(f('tls.crt')) }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"success"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('HttpClient 自定义 CA', () => {
  it('ca_file 签发的服务端证书通过校验', async () => {
    const http = new HttpClient('loki', base, { ca_file: join(dir, 'ca.crt') });
    await expect(http.json('GET', '/ready', { timeoutMs: 5_000 })).resolves.toEqual({ status: 'success' });
  });

  it('tls_server_name 按给定主机名校验证书', async () => {
    const http = new HttpClient('loki', base, { ca_file: join(dir, 'ca.crt'), tls_server_name: 'localhost' });
    await expect(http.request('GET', '/ready', { timeoutMs: 5_000 })).resolves.toMatchObject({ status: 200 });
  });

  it('不信任的 CA 失败时报出底层原因', async () => {
    const http = new HttpClient('loki', base, {});
    await expect(http.request('GET', '/ready', { timeoutMs: 5_000 })).rejects.toThrow(
      /fetch failed（\S*.*certificate/i,
    );
  });
});
