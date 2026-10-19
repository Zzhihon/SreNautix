import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * 测试用的真实 MinIO：二进制放在仓库的 .scratch/bin/minio（取自 Homebrew 的 minio bottle，
 * 官方下载站已不再提供社区版二进制），数据目录在 .scratch 下，测试结束后删除。
 */
export interface TestMinio {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop(): Promise<void>;
}

const SCRATCH = resolve(import.meta.dirname, '../../../../.scratch');
const BIN = process.env.SRENAUTIX_MINIO_BIN ?? join(SCRATCH, 'bin', 'minio');

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

export async function startMinio(): Promise<TestMinio> {
  if (!existsSync(BIN)) {
    throw new Error(`找不到 MinIO 二进制：${BIN}（用 SRENAUTIX_MINIO_BIN 指定）`);
  }
  const port = await freePort();
  const consolePort = await freePort();
  const dir = join(SCRATCH, `minio-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const accessKey = 'srenautix-test';
  const secretKey = 'srenautix-test-secret-not-secret';
  const proc: ChildProcess = spawn(
    BIN,
    ['server', dir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${consolePort}`, '--quiet'],
    {
      env: { ...process.env, MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey, MINIO_BROWSER: 'off' },
      stdio: 'ignore',
    },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`MinIO 退出，状态码 ${proc.exitCode}`);
    }
    const ok = await fetch(`${endpoint}/minio/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      break;
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('MinIO 30 秒内没有就绪');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    endpoint,
    accessKey,
    secretKey,
    stop: () =>
      new Promise<void>((r) => {
        proc.once('exit', () => {
          rmSync(dir, { recursive: true, force: true });
          r();
        });
        proc.kill('SIGTERM');
      }),
  };
}
