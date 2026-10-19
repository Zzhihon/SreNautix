// 测试用的真实后端二进制：按 backends.json 固定版本下载、校验 sha256、解压到 .scratch/backends。
// pack test、一致性测试和本包自己的测试都用这些二进制，不使用任何替身。

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** 确保二进制已下载并校验，返回 二进制名 → 绝对路径 */
export async function ensureBackend(name: BackendName): Promise<Record<string, string>> {
  const spec = SPECS[name];
  const { os, arch } = platform();
  const key = spec.file ? 'any' : `${os}-${arch}`;
  const vars = { version: spec.version, os, arch, platform: spec.platforms?.[key] ?? key };
  const target = join(backendsDir(), `${name}-${spec.version}-${key}`);
  const paths = Object.fromEntries(
    Object.entries(spec.binaries).map(([bin, rel]) => [bin, join(target, fill(rel, vars))]),
  );
  if (Object.values(paths).every((p) => existsSync(p))) {
    return paths;
  }
  const expected = spec.sha256[key];
  if (!expected) {
    throw new Error(`backends.json 没有 ${name} ${key} 的 sha256`);
  }
  const url = fill(spec.url, vars);
  const body = await fetchVerified(url, expected);
  const staging = `${target}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  if (spec.file || spec.executable) {
    // 单个文件（模型权重或可执行文件），不解压
    const single = join(staging, fill(Object.values(spec.binaries)[0]!, vars));
    writeFileSync(single, body);
    if (spec.executable) {
      chmodSync(single, 0o755);
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return paths;
  }
  if (url.endsWith('.zip')) {
    new AdmZip(body).extractAllTo(staging, true);
  } else {
    const archive = join(staging, '.archive.tar.gz');
    writeFileSync(archive, body);
    await untar({ file: archive, cwd: staging });
    rmSync(archive);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  for (const p of Object.values(paths)) {
    if (!existsSync(p)) {
      throw new Error(`${url} 解压后缺少 ${p}`);
    }
    chmodSync(p, 0o755);
  }
  return paths;
}
