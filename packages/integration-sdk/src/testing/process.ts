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

/**
 * 看门进程：测试进程被信号结束（vitest 回收超时的工作进程）或 SIGKILL 时 exit 事件不触发，后端会成为父进程为 1 的
 * 孤儿进程，继续占用端口、内存与数据目录。每个测试进程第一次启动后端时起一个看门进程，经标准输入登记与注销后端的 pid；
 * 测试进程不论怎样结束，管道都会关闭，看门进程随即 SIGKILL 仍登记着的后端。看门进程忽略 SIGINT、SIGTERM 与 SIGHUP，
 * 保证在测试进程之后退出；它与它的管道都 unref，不让测试进程多等。
 */
const WATCHDOG = `
const pids = new Set();
let buf = '';
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => {});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) {
    const line = buf.slice(0, i);
    (line[0] === '+' ? pids.add : pids.delete).call(pids, Number(line.slice(1)));
  }
});
process.stdin.on('end', () => {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  process.exit(0);
});
`;
let watchdog: ChildProcess | undefined;

function guard(op: '+' | '-', pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (!watchdog) {
    watchdog = spawn(process.execPath, ['-e', WATCHDOG], { stdio: ['pipe', 'ignore', 'ignore'] });
    watchdog.unref();
    (watchdog.stdin as unknown as { unref(): void }).unref();
    // 看门进程意外退出时不影响测试；下次登记时重新启动
    watchdog.on('exit', () => {
      watchdog = undefined;
    });
    watchdog.stdin!.on('error', () => {});
  }
  watchdog.stdin!.write(`${op}${pid}\n`);
}

export async function startProcess(opts: {
  name: string;
  bin: string;
  args: string[];
  url: string;
  readyPath: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * 就绪的端口确实由这个进程监听：端口被并发的测试抢走时，就绪探测会被另一个已经就绪的后端应答，
   * 而本进程随后才因绑定失败退出。给出时，就绪之后核对身份（例如数据目录），不是本进程就按 PortTaken 处理。
   */
  owns?: (url: string) => Promise<boolean>;
}): Promise<RunningProcess> {
  const child = spawn(opts.bin, opts.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  guard('+', child.pid);
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
    guard('-', child.pid);
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
  if (opts.owns && !(await opts.owns(opts.url))) {
    child.kill('SIGKILL');
    throw new PortTaken(`${opts.name}：${opts.url} 上应答的是另一个进程（端口被并发的测试占用）：\n${output}`);
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
