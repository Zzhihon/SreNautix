// 启动测试用后端进程：分配空闲端口、等待就绪、退出时清理。

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || addr === null) {
        reject(new Error('无法分配端口'));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

/** 进程因端口已被占用而退出（freePort 释放端口到进程绑定之间被并发的测试抢走） */
export class PortTaken extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortTaken';
  }
}

const PORT_TAKEN = /address already in use|bind: address|EADDRINUSE/i;

/**
 * 分配 count 个空闲端口并启动后端；后端因端口被抢走而退出时换一组端口重试（最多 attempts 次）。
 * 并发的测试文件各自分配端口，释放与绑定之间的竞争只能靠重试消除。其他启动错误直接抛出。
 */
export async function withFreePorts<T>(
  count: number,
  start: (ports: number[]) => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let i = 1; ; i++) {
    const ports: number[] = [];
    for (let j = 0; j < count; j++) {
      ports.push(await freePort());
    }
    try {
      return await start(ports);
    } catch (err) {
      if (!(err instanceof PortTaken) || i >= attempts) {
        throw err;
      }
    }
  }
}

export interface RunningProcess {
  readonly name: string;
  readonly url: string;
  stop(): Promise<void>;
  /** 进程输出的最后部分，失败时用于排查 */
  tail(): string;
}

const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of live) {
    c.kill('SIGKILL');
  }
});

export async function startProcess(opts: {
  name: string;
  bin: string;
  args: string[];
  url: string;
  readyPath: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<RunningProcess> {
  const child = spawn(opts.bin, opts.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  let output = '';
  const keep = (b: Buffer) => {
    output = (output + b.toString()).slice(-8000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let exited: number | null | undefined;
  child.on('exit', (code) => {
    exited = code;
    live.delete(child);
  });

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    if (exited !== undefined) {
      const message = `${opts.name} 启动后退出（code ${exited}）：\n${output}`;
      throw PORT_TAKEN.test(output) ? new PortTaken(message) : new Error(message);
    }
    try {
      // 每次探测都有超时：端口上的进程接受连接却不回 HTTP 时，不会卡住直到整体期限之后
      const res = await fetch(opts.url + opts.readyPath, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        break;
      }
    } catch {
      // 端口尚未监听，继续等待
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${opts.name} 在期限内没有就绪：\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    name: opts.name,
    url: opts.url,
    tail: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited !== undefined) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }),
  };
}
