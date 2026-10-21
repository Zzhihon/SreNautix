// 测试后端的端口竞争：freePort 释放端口到后端绑定之间，并发的测试文件可能先占用它（CI 上 Prometheus 因此
// "bind: address already in use" 退出）。startProcess 把这种退出报告为 PortTaken，withFreePorts 换端口重试。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backendsDir, ensureBackend } from '../src/testing/backends.js';
import { PortTaken, startProcess, withFreePorts } from '../src/testing/process.js';
import { prometheusOwns, startPrometheus } from '../src/testing/tsdb.js';

const held: Server[] = [];
const scratch: string[] = [];
afterAll(() => {
  held.forEach((s) => s.close());
  scratch.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('测试后端的端口', () => {
  it('后端因端口被占用而退出时报告 PortTaken，其他启动错误照常抛出', async () => {
    // 与 CI 上 Prometheus 的输出相同的退出方式
    await expect(
      startProcess({
        name: 'node',
        bin: process.execPath,
        args: [
          '-e',
          'console.error(\'msg="Unable to start web listener" err="listen tcp 127.0.0.1:1: bind: address already in use"\'); process.exit(1)',
        ],
        url: 'http://127.0.0.1:1',
        readyPath: '/',
        timeoutMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(PortTaken);
    await expect(
      startProcess({
        name: 'node',
        bin: process.execPath,
        args: ['-e', 'process.exit(3)'],
        url: 'http://127.0.0.1:1',
        readyPath: '/',
        timeoutMs: 10_000,
      }),
    ).rejects.not.toBeInstanceOf(PortTaken);
  });

  it('端口上的进程接受连接却不回 HTTP 时，就绪探测按期限失败而不是一直等待', async () => {
    const silent = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
      held.push(s);
    });
    const started = Date.now();
    await expect(
      startProcess({
        name: 'node',
        bin: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        url: `http://127.0.0.1:${silent}`,
        readyPath: '/',
        timeoutMs: 3000,
      }),
    ).rejects.toThrow('在期限内没有就绪');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('withFreePorts 在 PortTaken 时换一组端口重试，其他错误不重试', async () => {
    const seen: number[][] = [];
    const value = await withFreePorts(2, async (ports) => {
      seen.push(ports);
      if (seen.length < 3) {
        throw new PortTaken('address already in use');
      }
      return 'started';
    });
    expect(value).toBe('started');
    expect(seen).toHaveLength(3);
    seen.flat().forEach((p) => expect(p).toBeGreaterThan(0));
    let calls = 0;
    await expect(
      withFreePorts(1, async () => {
        calls++;
        throw new Error('配置错误');
      }),
    ).rejects.toThrow('配置错误');
    expect(calls).toBe(1);
  });

  it('端口被另一个已就绪的后端占用时，就绪探测会被它应答；按数据目录核对身份后报告 PortTaken', async () => {
    // 根因复现：B 绑定失败之前，B 的就绪探测打到占着端口的 A 上，A 已经就绪
    const a = await startPrometheus([]);
    const { prometheus: bin } = await ensureBackend('prometheus');
    const port = new URL(a.url).port;
    const dir = mkdtempSync(join(backendsDir(), 'runs', 'prometheus-b-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'prometheus.yml'), 'global:\n  evaluation_interval: 1m\n');
    const opts = {
      name: 'prometheus',
      bin: bin!,
      args: [
        `--config.file=${join(dir, 'prometheus.yml')}`,
        `--storage.tsdb.path=${join(dir, 'data')}`,
        `--web.listen-address=127.0.0.1:${port}`,
      ],
      url: a.url,
      readyPath: '/-/ready',
      timeoutMs: 20_000,
    };
    try {
      // 不核对身份时 B 被当作已就绪，URL 指向 A 的数据
      const fooled = await startProcess(opts);
      expect(fooled.url).toBe(a.url);
      await fooled.stop();
      // 核对数据目录后识别出端口被占用
      await expect(startProcess({ ...opts, owns: prometheusOwns(join(dir, 'data')) })).rejects.toBeInstanceOf(
        PortTaken,
      );
      expect(await prometheusOwns(join(dir, 'data'))(a.url)).toBe(false);
    } finally {
      await a.stop();
    }
  });

  it('并发启动多个 Prometheus 都能就绪', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, () => startPrometheus([])));
    try {
      expect(new Set(all.map((p) => p.url)).size).toBe(6);
    } finally {
      await Promise.all(all.map((p) => p.stop()));
    }
  });
});
