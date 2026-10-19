import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backendsDir, ensureBackend, startOciRegistry, type OciRegistry } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CosignVerifier, loadOciPack, OciPackError, PACK_ARTIFACT_TYPE } from '../src/pack/oci.js';
import { PACKS } from './support.js';

const run = promisify(execFile);

// 真实的 zot 仓库、oras 推送与拉取、cosign 密钥对签名与校验
let registry: OciRegistry;
let work: string;
let cosign: string;
let oras: string;
let repo: string;
let signed: string;
let unsigned: string;
let wrongType: string;
let otherKey: string;

const env: NodeJS.ProcessEnv = { ...process.env, COSIGN_PASSWORD: 'srenautix-test', COSIGN_YES: 'true' };

async function push(dir: string, tag: string, artifactType = PACK_ARTIFACT_TYPE): Promise<string> {
  const { stdout } = await run(
    oras,
    ['push', '--plain-http', '--artifact-type', artifactType, '--format', 'json', `${repo}:${tag}`, '_example'],
    { cwd: dir, env },
  );
  return (JSON.parse(stdout) as { digest: string }).digest;
}

beforeAll(async () => {
  ({ cosign } = (await ensureBackend('cosign')) as { cosign: string });
  ({ oras } = (await ensureBackend('oras')) as { oras: string });
  registry = await startOciRegistry();
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  work = mkdtempSync(join(base, 'oci-pack-'));
  repo = `${registry.host}/packs/example`;
  // 本机仓库不需要凭证；空的 Docker 配置避免 cosign、oras 调用开发机上的凭证助手
  mkdirSync(join(work, 'docker'));
  writeFileSync(join(work, 'docker', 'config.json'), '{}');
  process.env['DOCKER_CONFIG'] = join(work, 'docker');
  env['DOCKER_CONFIG'] = join(work, 'docker');

  mkdirSync(join(work, 'src'));
  cpSync(join(PACKS, '_example'), join(work, 'src', '_example'), { recursive: true });
  mkdirSync(join(work, 'keys'));
  mkdirSync(join(work, 'other'));
  await run(cosign, ['generate-key-pair'], { cwd: join(work, 'keys'), env });
  await run(cosign, ['generate-key-pair'], { cwd: join(work, 'other'), env });
  otherKey = join(work, 'other', 'cosign.pub');

  const sign = (digest: string) =>
    run(
      cosign,
      [
        'sign',
        '--key',
        join(work, 'keys', 'cosign.key'),
        '--allow-http-registry',
        '--tlog-upload=false',
        '--use-signing-config=false',
        `${repo}@${digest}`,
      ],
      { env },
    );
  signed = await push(join(work, 'src'), 'v1');
  await sign(signed);
  wrongType = await push(join(work, 'src'), 'other-type', 'application/vnd.example.other');
  await sign(wrongType);
  // 同一目录换一个注解得到不同的 digest，不签名
  const { stdout } = await run(
    oras,
    [
      'push',
      '--plain-http',
      '--artifact-type',
      PACK_ARTIFACT_TYPE,
      '--annotation',
      'org.opencontainers.image.description=unsigned',
      '--format',
      'json',
      `${repo}:unsigned`,
      '_example',
    ],
    { cwd: join(work, 'src'), env },
  );
  unsigned = (JSON.parse(stdout) as { digest: string }).digest;
}, 600_000);

afterAll(async () => {
  await registry?.stop();
  if (work) {
    rmSync(work, { recursive: true, force: true });
  }
});

function verifier(key: string): CosignVerifier {
  return new CosignVerifier({ cosign, key, allow_http_registry: true, ignore_tlog: true });
}

describe('OCI 来源的领域包', () => {
  it('签名通过后拉取并加载，来源记为 oci://<仓库>@<digest>', async () => {
    const r = await loadOciPack({
      repository: repo,
      digest: signed,
      verifier: verifier(join(work, 'keys', 'cosign.pub')),
      oras,
      dir: join(work, 'pull-ok'),
      plain_http: true,
    });
    expect(r.pack.name).toBe('_example');
    expect(r.pack.source).toBe(`oci://${repo}@${signed}`);
    expect(r.signer).toContain('cosign.pub');
  });

  it('其他密钥签名的制品被拒绝，且不拉取', async () => {
    const dir = join(work, 'pull-other');
    await expect(
      loadOciPack({ repository: repo, digest: signed, verifier: verifier(otherKey), oras, dir, plain_http: true }),
    ).rejects.toThrow(OciPackError);
  });

  it('没有签名的制品被拒绝', async () => {
    await expect(
      loadOciPack({
        repository: repo,
        digest: unsigned,
        verifier: verifier(join(work, 'keys', 'cosign.pub')),
        oras,
        dir: join(work, 'pull-unsigned'),
        plain_http: true,
      }),
    ).rejects.toThrow(/签名校验不通过/);
  });

  it('签名有效但制品类型不是领域包时拒绝', async () => {
    await expect(
      loadOciPack({
        repository: repo,
        digest: wrongType,
        verifier: verifier(join(work, 'keys', 'cosign.pub')),
        oras,
        dir: join(work, 'pull-type'),
        plain_http: true,
      }),
    ).rejects.toThrow(/制品类型/);
  });

  it('只给标签、不给 digest 时拒绝', async () => {
    await expect(
      loadOciPack({
        repository: `${repo}:v1`,
        digest: signed,
        verifier: verifier(join(work, 'keys', 'cosign.pub')),
        oras,
        dir: join(work, 'pull-tag'),
        plain_http: true,
      }),
    ).rejects.toThrow(/不能带标签/);
    await expect(
      loadOciPack({
        repository: repo,
        digest: 'v1',
        verifier: verifier(join(work, 'keys', 'cosign.pub')),
        oras,
        dir: join(work, 'pull-tag'),
        plain_http: true,
      }),
    ).rejects.toThrow(/sha256 digest/);
  });

  it('校验参数不完整时拒绝构造', () => {
    expect(() => new CosignVerifier({ cosign })).toThrow();
    expect(() => new CosignVerifier({ cosign, certificate_identity: 'x' })).toThrow();
    expect(
      () => new CosignVerifier({ cosign, certificate_identity: 'x', certificate_oidc_issuer: 'y', ignore_tlog: true }),
    ).toThrow();
  });
});
