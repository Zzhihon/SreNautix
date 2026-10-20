import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { loadPackDir, packDigest } from '../src/pack/load.js';
import { PACKS } from './support.js';

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p).map((f) => `${n}/${f}`) : [n];
  });
}

/**
 * 按 kubelet 投影 ConfigMap 的方式构造挂载目录：键都在 ..<时间戳>/ 中，..data 指向它，
 * 每个键在挂载点有一个指向 ..data/<键> 的符号链接。子目录文件的键为 <子目录>__<文件名>
 */
function projectAsConfigMap(src: string, mount: string): void {
  const stamp = '..2026_10_20_12_00_00.123456789';
  mkdirSync(join(mount, stamp), { recursive: true });
  for (const f of files(src)) {
    const key = f.split('/').join('__');
    cpSync(join(src, f), join(mount, stamp, key));
    symlinkSync(join('..data', key), join(mount, key));
  }
  symlinkSync(stamp, join(mount, '..data'));
}

function tempDir(): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, 'configmap-pack-'));
  scratch.push(d);
  return d;
}

describe('以 ConfigMap 挂载的包', () => {
  it('跳过 ..data 等挂载条目，<子目录>__<文件名> 还原为子目录，内容摘要与源目录相同', () => {
    const src = join(PACKS, '_example');
    const mount = join(tempDir(), '_example');
    projectAsConfigMap(src, mount);
    const direct = loadPackDir(src, 'builtin');
    const mounted = loadPackDir(mount, 'builtin');
    expect(mounted.files.map((f) => f.path).sort()).toEqual(direct.files.map((f) => f.path).sort());
    expect(packDigest(mounted.files)).toBe(packDigest(direct.files));
    expect(Object.keys(mounted.content.runbooks)).toEqual(Object.keys(direct.content.runbooks));
    expect(Object.keys(mounted.content.tests)).toEqual(Object.keys(direct.content.tests));
    // _example 带 tests/replay 下的快照，覆盖两级子目录的键形式
    expect(files(src).some((f) => f.startsWith('tests/replay/'))).toBe(true);
  });

  it('同一文件以两种形式出现时拒绝加载', () => {
    const dir = join(tempDir(), '_example');
    cpSync(join(PACKS, '_example'), dir, { recursive: true });
    const [runbook] = readdirSync(join(dir, 'runbooks'));
    cpSync(join(dir, 'runbooks', runbook!), join(dir, `runbooks__${runbook}`));
    expect(() => loadPackDir(dir, 'builtin')).toThrow(PackLintError);
  });
});
