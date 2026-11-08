// OCI 来源的领域包（DESIGN §6.3）：必须固定到 digest，并且先通过 cosign 签名校验，之后才拉取与加载。
// 制品格式：oras 推送的单层制品，artifactType 为 PACK_ARTIFACT_TYPE，层是包目录的 tar.gz（oras 拉取时解开）。
// 校验与拉取调用 cosign 与 oras 可执行文件；来源写成 oci://<仓库>@<digest>，计入 pack.lock。
// buildPackArtifact 由包目录确定性地生成同样格式的制品：同样的文件内容总是得到同样的 digest，
// 部署方可以在推送之前算出 digest 写进配置（srenautix pack digest / push，ADR 0188）。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { loadPackDir, type LoadedPack } from './load.js';

const run = promisify(execFile);

export const PACK_ARTIFACT_TYPE = 'application/vnd.srenautix.pack.v1';

export class OciPackError extends Error {
  constructor(
    readonly reference: string,
    detail: string,
  ) {
    super(`${reference}：${detail}`);
    this.name = 'OciPackError';
  }
}

/** 签名校验：不通过时抛错；通过时返回签名者的描述 */
export interface OciPackVerifier {
  verify(reference: string): Promise<string>;
}

export interface CosignVerifierOptions {
  /** cosign 可执行文件 */
  cosign: string;
  /** 公钥文件；与 certificate_identity 二选一 */
  key?: string;
  /** keyless 签名的证书身份与签发方 */
  certificate_identity?: string;
  certificate_oidc_issuer?: string;
  /** 仓库只提供 HTTP（仅限本机或隔离网络中的仓库） */
  allow_http_registry?: boolean;
  /** 跳过透明日志校验；只用于无法访问 Rekor 的离线环境，且必须配合 key */
  ignore_tlog?: boolean;
}

export class CosignVerifier implements OciPackVerifier {
  constructor(private readonly o: CosignVerifierOptions) {
    const keyless = Boolean(o.certificate_identity || o.certificate_oidc_issuer);
    if (Boolean(o.key) === keyless) {
      throw new Error('cosign 校验需要且只能指定 key 或 certificate_identity + certificate_oidc_issuer 之一');
    }
    if (keyless && !(o.certificate_identity && o.certificate_oidc_issuer)) {
      throw new Error('keyless 校验需要同时指定 certificate_identity 与 certificate_oidc_issuer');
    }
    if (o.ignore_tlog && !o.key) {
      throw new Error('ignore_tlog 只能与 key 一起使用');
    }
  }

  async verify(reference: string): Promise<string> {
    const args = ['verify', '--output', 'json'];
    if (this.o.key) {
      args.push('--key', this.o.key);
    } else {
      args.push(
        '--certificate-identity',
        this.o.certificate_identity!,
        '--certificate-oidc-issuer',
        this.o.certificate_oidc_issuer!,
      );
    }
    if (this.o.allow_http_registry) {
      args.push('--allow-http-registry');
    }
    if (this.o.ignore_tlog) {
      args.push('--insecure-ignore-tlog=true');
    }
    args.push(reference);
    try {
      await run(this.o.cosign, args, { maxBuffer: 16 << 20 });
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new OciPackError(reference, `cosign 签名校验不通过：${(e.stderr ?? e.message).trim()}`);
    }
    return this.o.key ? `key ${this.o.key}` : `${this.o.certificate_identity}（${this.o.certificate_oidc_issuer}）`;
  }
}

export interface OciPullOptions {
  /** 仓库，例如 registry.example.org/packs/redis；不带标签 */
  repository: string;
  /** sha256:<64 位十六进制> */
  digest: string;
  verifier: OciPackVerifier;
  /** oras 可执行文件 */
  oras: string;
  /** 拉取目录；已存在时先清空 */
  dir: string;
  plain_http?: boolean;
}

export interface LoadedOciPack {
  pack: LoadedPack;
  signer: string;
}

export async function loadOciPack(o: OciPullOptions): Promise<LoadedOciPack> {
  if (/[@:]/.test(o.repository.replace(/^[^/]+\//, ''))) {
    throw new OciPackError(o.repository, '仓库不能带标签或 digest，digest 单独给出');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(o.digest)) {
    throw new OciPackError(o.repository, `OCI 来源必须固定到 sha256 digest：${o.digest}`);
  }
  const reference = `${o.repository}@${o.digest}`;
  const signer = await o.verifier.verify(reference);
  const http = o.plain_http ? ['--plain-http'] : [];

  const { stdout } = await run(o.oras, ['manifest', 'fetch', ...http, reference], { maxBuffer: 16 << 20 });
  const manifest = JSON.parse(stdout) as { artifactType?: string; layers?: unknown[] };
  if (manifest.artifactType !== PACK_ARTIFACT_TYPE) {
    throw new OciPackError(reference, `制品类型为 ${manifest.artifactType ?? '空'}，期望 ${PACK_ARTIFACT_TYPE}`);
  }
  if (manifest.layers?.length !== 1) {
    throw new OciPackError(reference, `领域包制品必须只有一层，实际 ${manifest.layers?.length ?? 0} 层`);
  }

  rmSync(o.dir, { recursive: true, force: true });
  mkdirSync(o.dir, { recursive: true });
  await run(o.oras, ['pull', ...http, '--output', o.dir, reference], { maxBuffer: 16 << 20 });
  const entries = readdirSync(o.dir).filter((n) => statSync(join(o.dir, n)).isDirectory());
  if (entries.length !== 1 || !existsSync(join(o.dir, entries[0]!, 'pack.yaml'))) {
    throw new OciPackError(reference, '制品解开后必须是一个包含 pack.yaml 的目录');
  }
  return { pack: loadPackDir(join(o.dir, entries[0]!), `oci://${reference}`), signer };
}

// ---- 确定性的制品构建与推送 ----

const EMPTY_CONFIG = Buffer.from('{}');
const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';

export interface PackArtifact {
  /** 包名，也是层解开后的目录名 */
  name: string;
  /** 清单的 digest，即 packs.oci.sources[].digest */
  digest: string;
  manifest: Buffer;
  layer: Buffer;
  /** 包中的文件数 */
  files: number;
}

const sha256 = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** 包目录中的文件，规则与 loadPackDir 相同（跳过 ConfigMap 挂载的 .. 开头的条目），按路径排序 */
function packEntries(dir: string, rel = ''): Array<{ path: string; dir: boolean; abs: string }> {
  return readdirSync(join(dir, rel))
    .filter((n) => !n.startsWith('..'))
    .sort()
    .flatMap((n) => {
      const path = rel ? `${rel}/${n}` : n;
      const abs = join(dir, path);
      return statSync(abs).isDirectory()
        ? [{ path, dir: true, abs }, ...packEntries(dir, path)]
        : [{ path, dir: false, abs }];
    });
}

/** ustar 头：属主、时间、权限都取固定值，只有路径、类型与大小随内容变化 */
function tarHeader(path: string, size: number, dir: boolean): Buffer {
  const h = Buffer.alloc(512);
  const name = Buffer.from(path);
  let prefix = Buffer.alloc(0);
  let base = name;
  if (name.length > 100) {
    const cut = path.lastIndexOf('/', path.length - 1 - (dir ? 1 : 0));
    prefix = Buffer.from(path.slice(0, cut));
    base = Buffer.from(path.slice(cut + 1));
    if (cut < 0 || prefix.length > 155 || base.length > 100) {
      throw new Error(`路径过长，无法写入 ustar：${path}`);
    }
  }
  const octal = (v: number, len: number, at: number) =>
    h.write(v.toString(8).padStart(len - 1, '0') + '\0', at, 'ascii');
  base.copy(h, 0);
  octal(dir ? 0o755 : 0o644, 8, 100);
  octal(0, 8, 108);
  octal(0, 8, 116);
  octal(size, 12, 124);
  octal(0, 12, 136);
  h.fill(' ', 148, 156);
  h.write(dir ? '5' : '0', 156, 'ascii');
  h.write('ustar\0' + '00', 257, 'ascii');
  prefix.copy(h, 345);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/**
 * gzip 封装的 deflate 存储块（不压缩）。压缩输出随 zlib 的实现与版本变化（Node 内置的是 Chromium 的分支），
 * 存储块只取决于输入，在任何机器上都得到同样的字节；头部的时间为 0、操作系统为 255（未知）
 */
function gzipStored(data: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])];
  for (let off = 0; ; off += 0xffff) {
    const chunk = data.subarray(off, off + 0xffff);
    const last = off + 0xffff >= data.length;
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt16LE(chunk.length, 1);
    head.writeUInt16LE(~chunk.length & 0xffff, 3);
    parts.push(head, chunk);
    if (last) {
      break;
    }
  }
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(data) >>> 0, 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  parts.push(tail);
  return Buffer.concat(parts);
}

/**
 * 由包目录生成制品，格式与 `oras push <目录>` 相同（层的 title 为包名、带 unpack 注解，oras pull 时解开成 <包名>/），
 * 但内容只取决于文件路径与内容：不写时间、属主与权限位，清单不带创建时间注解。先按 loadPackDir 加载以校验包。
 */
export function buildPackArtifact(dir: string): PackArtifact {
  const name = loadPackDir(dir, `dir:${dir}`).name;
  const blocks: Buffer[] = [tarHeader(`${name}/`, 0, true)];
  const entries = packEntries(dir);
  for (const e of entries) {
    if (e.dir) {
      blocks.push(tarHeader(`${name}/${e.path}/`, 0, true));
      continue;
    }
    const body = readFileSync(e.abs);
    blocks.push(
      tarHeader(`${name}/${e.path}`, body.length, false),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  const layer = gzipStored(tar);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST_TYPE,
      artifactType: PACK_ARTIFACT_TYPE,
      config: {
        mediaType: 'application/vnd.oci.empty.v1+json',
        digest: sha256(EMPTY_CONFIG),
        size: EMPTY_CONFIG.length,
        data: EMPTY_CONFIG.toString('base64'),
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          digest: sha256(layer),
          size: layer.length,
          annotations: {
            'io.deis.oras.content.digest': sha256(tar),
            'io.deis.oras.content.unpack': 'true',
            'org.opencontainers.image.title': name,
          },
        },
      ],
    }),
  );
  return { name, digest: sha256(manifest), manifest, layer, files: entries.filter((e) => !e.dir).length };
}

/** 把制品写成 OCI 镜像布局目录（oras 的 --oci-layout 可以直接读取），标签为 tag */
export function writeOciLayout(a: PackArtifact, dir: string, tag: string): void {
  const blobs = join(dir, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  for (const b of [EMPTY_CONFIG, a.layer, a.manifest]) {
    writeFileSync(join(blobs, sha256(b).slice('sha256:'.length)), b);
  }
  writeFileSync(join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: MANIFEST_TYPE,
          artifactType: PACK_ARTIFACT_TYPE,
          digest: a.digest,
          size: a.manifest.length,
          annotations: { 'org.opencontainers.image.ref.name': tag },
        },
      ],
    }),
  );
}

export interface OciPushOptions {
  /** 仓库，例如 ghcr.io/example/packs/redis；不带标签 */
  repository: string;
  tag: string;
  oras: string;
  plain_http?: boolean;
}

/** 用 oras cp 从临时的 OCI 布局推送（清单按原样复制，digest 不变），推送后核对仓库中的 digest */
export async function pushPackArtifact(a: PackArtifact, o: OciPushOptions): Promise<void> {
  if (/[@:]/.test(o.repository.replace(/^[^/]+\//, ''))) {
    throw new OciPackError(o.repository, '仓库不能带标签或 digest，标签单独给出');
  }
  const layout = mkdtempSync(join(tmpdir(), 'srenautix-pack-'));
  try {
    writeOciLayout(a, layout, o.tag);
    const http = o.plain_http ? ['--plain-http'] : [];
    await run(
      o.oras,
      [
        'cp',
        '--from-oci-layout',
        ...(o.plain_http ? ['--to-plain-http'] : []),
        `${layout}:${o.tag}`,
        `${o.repository}:${o.tag}`,
      ],
      {
        maxBuffer: 16 << 20,
      },
    );
    const { stdout } = await run(o.oras, ['manifest', 'fetch', ...http, '--descriptor', `${o.repository}:${o.tag}`], {
      maxBuffer: 16 << 20,
    });
    const got = (JSON.parse(stdout) as { digest?: string }).digest;
    if (got !== a.digest) {
      throw new OciPackError(`${o.repository}:${o.tag}`, `推送后仓库中的 digest 为 ${got ?? '空'}，期望 ${a.digest}`);
    }
  } finally {
    rmSync(layout, { recursive: true, force: true });
  }
}
