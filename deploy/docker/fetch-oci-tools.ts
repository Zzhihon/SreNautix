// 中心镜像构建阶段：按 packages/integration-sdk/backends.json 固定的版本与 sha256 下载 cosign 与 oras（server 拉取 OCI 领域包时使用），
// 与测试用的是同一份版本清单。
//   node fetch-oci-tools.ts <backends.json> <linux 架构 amd64|arm64> <输出目录>（Node 24 直接运行 TypeScript）
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

interface BackendSpec {
  version: string;
  url: string;
  executable?: boolean;
  binaries: Record<string, string>;
  sha256: Record<string, string>;
}

const [specFile, arch, outDir] = process.argv.slice(2);
if (!specFile || !arch || !['amd64', 'arm64'].includes(arch) || !outDir) {
  throw new Error('用法：node fetch-oci-tools.ts <backends.json> <amd64|arm64> <输出目录>');
}
const specs = JSON.parse(readFileSync(specFile, 'utf8')) as Record<string, BackendSpec | undefined>;
mkdirSync(outDir, { recursive: true });

for (const name of ['cosign', 'oras']) {
  const spec = specs[name];
  if (!spec) {
    throw new Error(`${specFile} 中没有 ${name}`);
  }
  const platform = `linux-${arch}`;
  const want = spec.sha256[platform];
  if (!want) {
    throw new Error(`${specFile} 中没有 ${name} ${platform} 的 sha256`);
  }
  const url = spec.url.replaceAll('{version}', spec.version).replaceAll('{os}', 'linux').replaceAll('{arch}', arch);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载 ${url} 失败：HTTP ${res.status}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== want) {
    throw new Error(`${url} 的 sha256 为 ${got}，应为 ${want}`);
  }
  const target = join(outDir, name);
  if (spec.executable) {
    writeFileSync(target, body);
  } else {
    const archive = `${target}.tar.gz`;
    writeFileSync(archive, body);
    execFileSync('tar', ['-xzf', archive, '-C', outDir, spec.binaries[name]]);
    execFileSync('rm', [archive]);
  }
  chmodSync(target, 0o755);
  console.log(`${name} ${spec.version} ${platform}：${got}`);
}
