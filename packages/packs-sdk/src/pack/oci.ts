// OCI 来源的领域包（DESIGN §6.3）：必须固定到 digest，并且先通过 cosign 签名校验，之后才拉取与加载。
// 制品格式：oras 推送的单层制品，artifactType 为 PACK_ARTIFACT_TYPE，层是包目录的 tar.gz（oras 拉取时解开）。
// 校验与拉取调用 cosign 与 oras 可执行文件；来源写成 oci://<仓库>@<digest>，计入 pack.lock。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
