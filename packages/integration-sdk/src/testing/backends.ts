// 测试用的真实后端二进制：按 backends.json 固定版本下载、校验 sha256、解压到 .scratch/backends。
// pack test、一致性测试和本包自己的测试都用这些二进制，不使用任何替身。

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import { x as untar } from 'tar';

interface BackendSpec {
  version: string;
  url: string;
  /** os-arch → 发行包里的平台名；不填时就用 os-arch */
  platforms?: Record<string, string>;
  /** 平台无关的单个文件，sha256 的键为 any */
  file?: boolean;
  /** 按平台发布的单个可执行文件（不是压缩包），sha256 的键为 os-arch */
  executable?: boolean;
  binaries: Record<string, string>;
  sha256: Record<string, string>;
}

export type BackendName =
  | 'prometheus'
  | 'victoria-metrics'
  | 'loki'
  | 'tempo'
  | 'helm'
  | 'llama-server'
  | 'qwen2.5-0.5b-instruct-gguf'
  | 'cosign'
  | 'oras'
  | 'zot';

const SPECS = JSON.parse(readFileSync(new URL('../../backends.json', import.meta.url), 'utf8')) as Record<
  BackendName,
  BackendSpec
>;

export function backendVersion(name: BackendName): string {
  return SPECS[name].version;
}

function platform(): { os: string; arch: string } {
  const os = process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  if ((os !== 'darwin' && os !== 'linux') || (arch !== 'amd64' && arch !== 'arm64')) {
    throw new Error(`没有 ${os}/${arch} 的后端二进制`);
  }
  return { os, arch };
}

/** 下载目录：SRENAUTIX_BACKENDS_DIR，或工作区根目录（含 pnpm-workspace.yaml）下的 .scratch/backends */
export function backendsDir(): string {
  const env = process.env['SRENAUTIX_BACKENDS_DIR'];
  if (env) {
    return resolve(env);
  }
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, '.scratch', 'backends');
    }
    const up = dirname(dir);
    if (up === dir) {
      throw new Error('找不到工作区根目录；在仓库外运行时请设置 SRENAUTIX_BACKENDS_DIR');
    }
    dir = up;
  }
}

/** 下载并校验 sha256；不符时报错 */
export async function fetchVerified(url: string, sha256: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载 ${url} 失败：HTTP ${res.status}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== sha256) {
    throw new Error(`${url} 的 sha256 不符：期望 ${sha256}，实际 ${actual}`);
  }
  return body;
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k]!);

/** 目录内容完整的标记：只在解压、校验全部完成之后写入，随目录一起原子落位 */
const COMPLETE = '.complete';
/** 锁的持有者已经退出，或锁超过这个时长没有更新，视为残留 */
const LOCK_STALE_MS = 30 * 60_000;

function lockIsStale(lock: string): boolean {
  let pid: number;
  let mtime: number;
  try {
    pid = Number(readFileSync(lock, 'utf8').split('\n')[0]);
    mtime = statSync(lock).mtimeMs;
  } catch {
    // 读取时锁已被释放
    return false;
  }
  if (Date.now() - mtime > LOCK_STALE_MS) {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * 跨进程的文件锁（O_EXCL 创建锁文件）。vitest 的文件级并行与 pnpm -r 的包级并行会同时下载同一个后端，
 * 由它串行化；持有者退出或超时后的残留锁被清除。
 */
export async function withFileLock<T>(lock: string, f: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, `${process.pid}\n${hostname()}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      if (lockIsStale(lock)) {
        rmSync(lock, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await f();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * 把 build 在临时目录里生成的内容原子落位到 target：临时目录与 target 同在一个父目录下，
 * build 完成后写入完整标记，再 rename。target 已存在但没有完整标记时（中断留下的残缺目录、旧缓存）先删除。
 */
export async function placeAtomically(target: string, build: (staging: string) => Promise<void>): Promise<void> {
  if (existsSync(join(target, COMPLETE))) {
    return;
  }
  await withFileLock(`${target}.lock`, async () => {
    if (existsSync(join(target, COMPLETE))) {
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const staging = mkdtempSync(`${target}.partial-`);
    try {
      await build(staging);
      writeFileSync(join(staging, COMPLETE), `${new Date().toISOString()}\n`);
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

/** 确保二进制已下载并校验，返回 二进制名 → 绝对路径 */
export async function ensureBackend(name: BackendName): Promise<Record<string, string>> {
  const spec = SPECS[name];
  const { os, arch } = platform();
  const key = spec.file ? 'any' : `${os}-${arch}`;
  const vars = { version: spec.version, os, arch, platform: spec.platforms?.[key] ?? key };
  const target = join(backendsDir(), `${name}-${spec.version}-${key}`);
  const rel = Object.fromEntries(Object.entries(spec.binaries).map(([bin, r]) => [bin, fill(r, vars)]));
  const expected = spec.sha256[key];
  if (!expected) {
    throw new Error(`backends.json 没有 ${name} ${key} 的 sha256`);
  }
  const url = fill(spec.url, vars);

  await placeAtomically(target, async (staging) => {
    const body = await fetchVerified(url, expected);
    if (spec.file || spec.executable) {
      // 单个文件（模型权重或可执行文件），不解压
      writeFileSync(join(staging, Object.values(rel)[0]!), body);
    } else if (url.endsWith('.zip')) {
      new AdmZip(body).extractAllTo(staging, true);
    } else {
      const archive = join(staging, '.archive.tar.gz');
      writeFileSync(archive, body);
      await untar({ file: archive, cwd: staging });
      rmSync(archive);
    }
    for (const r of Object.values(rel)) {
      const p = join(staging, r);
      if (!existsSync(p)) {
        throw new Error(`${url} 解压后缺少 ${r}`);
      }
      if (!spec.file) {
        chmodSync(p, 0o755);
      }
    }
  });

  const paths = Object.fromEntries(Object.entries(rel).map(([bin, r]) => [bin, join(target, r)]));
  for (const p of Object.values(paths)) {
    if (!existsSync(p)) {
      throw new Error(`${target} 带有完整标记但缺少 ${p}；删除该目录后重试`);
    }
  }
  return paths;
}
