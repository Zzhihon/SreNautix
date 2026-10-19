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
      throw new Error(`${opts.name} 启动后退出（code ${exited}）：\n${output}`);
    }
    try {
      const res = await fetch(opts.url + opts.readyPath);
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
