import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendsDir, backendVersion, ensureBackend, withFileLock } from '../src/testing/backends.js';

// 在一个空的下载目录里真实下载 oras（约 11 MB），验证并发下载与残缺目录都安全
let dir: string;
const saved = process.env['SRENAUTIX_BACKENDS_DIR'];

beforeAll(() => {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'download-'));
  process.env['SRENAUTIX_BACKENDS_DIR'] = dir;
});

afterAll(() => {
  if (saved === undefined) {
    delete process.env['SRENAUTIX_BACKENDS_DIR'];
  } else {
    process.env['SRENAUTIX_BACKENDS_DIR'] = saved;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function platformKey(): string {
  return `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
}

describe('测试后端下载', () => {
  it('残缺的目录（没有完整标记）被替换', async () => {
    const target = join(dir, `oras-${backendVersion('oras')}-${platformKey()}`);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'oras'), 'truncated');
    const { oras } = await ensureBackend('oras');
    expect(execFileSync(oras!, ['version'], { encoding: 'utf8' })).toContain(backendVersion('oras'));
    expect(existsSync(join(target, '.complete'))).toBe(true);
  });

  it('并发调用只落位一次，全部得到可执行的同一路径，不留临时目录与锁', async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const all = await Promise.all(Array.from({ length: 6 }, () => ensureBackend('oras')));
    expect(new Set(all.map((p) => p['oras'])).size).toBe(1);
    expect(execFileSync(all[0]!['oras']!, ['version'], { encoding: 'utf8' })).toContain(backendVersion('oras'));
    expect(readdirSync(dir).sort()).toEqual([`oras-${backendVersion('oras')}-${platformKey()}`]);
  });

  it('文件锁串行化临界区，持有者已退出的残留锁被清除', async () => {
    const lock = join(dir, 'x.lock');
    let inside = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileLock(lock, async () => {
          inside++;
          max = Math.max(max, inside);
          await new Promise((r) => setTimeout(r, 30));
          inside--;
        }),
      ),
    );
    expect(max).toBe(1);
    expect(existsSync(lock)).toBe(false);

    // 不存在的进程号留下的锁
    writeFileSync(lock, '2147483646\nelsewhere\n');
    await withFileLock(lock, async () => {});
    expect(existsSync(lock)).toBe(false);
  });
});
