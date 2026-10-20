import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backendsDir, ensureBackend, startOciRegistry, type OciRegistry } from '@srenautix/integration-sdk';
import { PACK_ARTIFACT_TYPE } from '@srenautix/packs-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/config/server.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackRuntime, type OciPackSource } from '../../src/stage-a/packs.js';
import { responseErrors } from '../support/contract.js';
import { PACKS } from '../support/packs.js';

const run = promisify(execFile);

/**
 * OCI 来源的领域包接入 server（DESIGN §6.3、ADR 0091）：真实的 zot 仓库、oras 推送、cosign 密钥对签名。
 * 签名通过的包与目录中的包一起加载，来源记为 oci://<仓库>@<digest>；签名不对的来源只禁用自己，并在"领域包"页列出原因。
 */
let registry: OciRegistry;
let work: string;
let cosign: string;
let oras: string;
let repo: string;
let signed: string;
let unsigned: string;

const env: NodeJS.ProcessEnv = { ...process.env, COSIGN_PASSWORD: 'srenautix-test', COSIGN_YES: 'true' };

async function push(dir: string, tag: string, annotation: string): Promise<string> {
  const { stdout } = await run(
    oras,
    [
      'push',
      '--plain-http',
      '--artifact-type',
      PACK_ARTIFACT_TYPE,
      '--annotation',
      `org.opencontainers.image.description=${annotation}`,
      '--format',
      'json',
      `${repo}:${tag}`,
      'redis-lite',
    ],
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
  work = mkdtempSync(join(base, 'server-oci-pack-'));
  repo = `${registry.host}/packs/redis-lite`;
  // 本机仓库不需要凭证；空的 Docker 配置避免 cosign、oras 调用开发机上的凭证助手
  mkdirSync(join(work, 'docker'));
  writeFileSync(join(work, 'docker', 'config.json'), '{}');
  process.env['DOCKER_CONFIG'] = join(work, 'docker');
  env['DOCKER_CONFIG'] = join(work, 'docker');

  // OCI 包与目录中的示例包同名会冲突：复制示例包并改名
  mkdirSync(join(work, 'src'));
  cpSync(join(PACKS, '_example'), join(work, 'src', 'redis-lite'), { recursive: true });
  const manifest = join(work, 'src', 'redis-lite', 'pack.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^name: _example$/m, 'name: redis-lite'));
  mkdirSync(join(work, 'keys'));
  await run(cosign, ['generate-key-pair'], { cwd: join(work, 'keys'), env });
  signed = await push(join(work, 'src'), 'v1', 'signed');
  await run(
    cosign,
    [
      'sign',
      '--key',
      join(work, 'keys', 'cosign.key'),
      '--allow-http-registry',
      '--tlog-upload=false',
      '--use-signing-config=false',
      `${repo}@${signed}`,
    ],
    { env },
  );
  unsigned = await push(join(work, 'src'), 'unsigned', 'unsigned');
}, 600_000);

afterAll(async () => {
  await registry?.stop();
  if (work) {
    rmSync(work, { recursive: true, force: true });
  }
});

const source = (digest: string): OciPackSource => ({
  repository: repo,
  digest,
  key_file: join(work, 'keys', 'cosign.pub'),
  ignore_tlog: true,
  plain_http: true,
});

describe('OCI 来源的领域包', () => {
  it('配置：必须固定到 digest，签名校验方式二选一', () => {
    const base = {
      cluster_id: 'c1',
      public_url: 'https://srenautix.example.test',
      policies_dir: '/x',
      ingest: { sources: [] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      approvals: { signing_key_file: '/x', key_id: 'k' },
      identity: { bindings_dir: '/x' },
      audit: { checkpoint_key_file: '/x' },
      callers: { tokens_file: '/x' },
    };
    const ok = (oci: unknown) => () => parseServerConfig({ ...base, packs: { oci } });
    const src = { repository: 'registry.example.org/packs/redis', digest: `sha256:${'a'.repeat(64)}` };
    const c = ok({ sources: [{ ...src, key_file: '/keys/cosign.pub' }] })();
    expect(c.packs.dirs).toEqual([]);
    expect(c.packs.oci).toMatchObject({ cosign: 'cosign', oras: 'oras', cache_dir: '/var/cache/srenautix/packs' });
    expect(
      ok({ sources: [{ ...src, certificate_identity: 'ci@example.org', certificate_oidc_issuer: 'https://idp' }] }),
    ).not.toThrow();
    expect(ok({ sources: [{ ...src, digest: 'v1.2.0', key_file: '/k' }] })).toThrow(/sha256 digest/);
    expect(ok({ sources: [src] })).toThrow(/key_file 或 certificate_identity/);
    expect(
      ok({ sources: [{ ...src, key_file: '/k', certificate_identity: 'a', certificate_oidc_issuer: 'b' }] }),
    ).toThrow(/key_file 或 certificate_identity/);
    expect(ok({ sources: [{ ...src, certificate_identity: 'a' }] })).toThrow(/同时给出/);
    expect(
      ok({ sources: [{ ...src, certificate_identity: 'a', certificate_oidc_issuer: 'b', ignore_tlog: true }] }),
    ).toThrow(/ignore_tlog/);
    expect(() => parseServerConfig({ ...base, packs: {} })).toThrow(/packs.dirs 或 packs.oci/);
  });

  it('签名通过的包与目录中的包一起加载；没有签名的来源只禁用自己，不拉取内容', async () => {
    const cacheDir = join(work, 'cache');
    const rt = await PackRuntime.load({
      dirs: [PACKS],
      only: ['_example'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
      oci: { sources: [source(signed), source(unsigned)], cosign, oras, cacheDir },
    });
    expect(rt.set.packs.map((p) => [p.name, p.source])).toEqual([
      ['_example', 'builtin'],
      ['redis-lite', `oci://${repo}@${signed}`],
    ]);
    expect(rt.set.lock.packs.find((p) => p.name === 'redis-lite')?.source).toBe(`oci://${repo}@${signed}`);
    expect(rt.failures).toHaveLength(1);
    expect(rt.failures[0]).toMatchObject({
      name: 'redis-lite',
      source: `oci://${repo}@${unsigned}`,
      digest: unsigned,
      version: null,
      error: expect.stringMatching(/cosign 签名校验不通过/),
    });
    // 签名不通过的来源没有拉取任何内容
    const unsignedDir = join(cacheDir, unsigned.replace(':', '-'));
    expect(existsSync(unsignedDir) ? readdirSync(unsignedDir) : []).toEqual([]);
    const statuses = rt.statuses();
    expect(statuses.filter((s) => s.source === 'oci').map((s) => [s.ref, s.loaded])).toEqual([
      [`oci://${repo}@${signed}`, true],
      [`oci://${repo}@${unsigned}`, false],
    ]);
    expect(responseErrors('/v1/packs', 'get', 200, { pack_lock: rt.set.lock, packs: statuses })).toBeNull();
  }, 120_000);

  it('签名用的不是配置的公钥：不加载', async () => {
    mkdirSync(join(work, 'other'), { recursive: true });
    await run(cosign, ['generate-key-pair'], { cwd: join(work, 'other'), env });
    const rt = await PackRuntime.load({
      dirs: [],
      only: null,
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
      oci: {
        sources: [{ ...source(signed), key_file: join(work, 'other', 'cosign.pub') }],
        cosign,
        oras,
        cacheDir: join(work, 'cache-other'),
      },
    });
    expect(rt.set.packs).toHaveLength(0);
    expect(rt.failures.map((f) => [f.source, f.error.includes('签名校验不通过')])).toEqual([
      [`oci://${repo}@${signed}`, true],
    ]);
  }, 120_000);
});
