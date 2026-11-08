import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backendsDir, ensureBackend, startOciRegistry, type OciRegistry } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPackArtifact,
  CosignVerifier,
  loadOciPack,
  OciPackError,
  PACK_ARTIFACT_TYPE,
  pushPackArtifact,
  writeOciLayout,
} from '../src/pack/oci.js';
import { loadPackDir } from '../src/pack/load.js';
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
let built: string;

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
  // srenautix pack push 的路径：确定性构建，oras cp 推送，cosign 签名
  const a = buildPackArtifact(join(work, 'src', '_example'));
  await pushPackArtifact(a, { repository: repo, tag: 'built', oras, plain_http: true });
  built = a.digest;
  await sign(built);
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

describe('确定性的领域包制品', () => {
  it('同样的文件内容得到同样的 digest：与修改时间、权限位无关，内容变了 digest 跟着变', () => {
    const dir = join(work, 'det', '_example');
    cpSync(join(PACKS, '_example'), dir, { recursive: true });
    const a = buildPackArtifact(dir);
    expect(a.name).toBe('_example');
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(buildPackArtifact(dir).digest).toBe(a.digest);
    utimesSync(join(dir, 'pack.yaml'), new Date(0), new Date(86_400_000));
    expect(buildPackArtifact(dir).digest).toBe(a.digest);
    writeFileSync(join(dir, 'pack.yaml'), readFileSync(join(dir, 'pack.yaml'), 'utf8') + '\n');
    expect(buildPackArtifact(dir).digest).not.toBe(a.digest);
  });

  it('oras 从 OCI 布局拉取时解开成 <包名>/，文件与源目录逐字节相同', async () => {
    const a = buildPackArtifact(join(PACKS, '_example'));
    const layout = join(work, 'layout');
    writeOciLayout(a, layout, 'v1');
    const out = join(work, 'layout-pull');
    await run(oras, ['pull', '--oci-layout', '--output', out, `${layout}:v1`], { env });
    const src = loadPackDir(join(PACKS, '_example'), 'dir:src');
    const got = loadPackDir(join(out, '_example'), 'dir:got');
    expect(got.files).toEqual(src.files);
    expect(got.files.length).toBe(a.files);
  });

  it('推送到仓库后 digest 不变，签名通过后按 digest 加载', async () => {
    const r = await loadOciPack({
      repository: repo,
      digest: built,
      verifier: verifier(join(work, 'keys', 'cosign.pub')),
      oras,
      dir: join(work, 'pull-built'),
      plain_http: true,
    });
    expect(r.pack.name).toBe('_example');
    expect(r.pack.files).toEqual(loadPackDir(join(PACKS, '_example'), 'dir:src').files);
  });
});
