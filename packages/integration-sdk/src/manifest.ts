// 集成清单 integration.yaml（DESIGN §10.1、§10.2）：按契约校验，再检查契约之外的规则：
// - 按方向分级：approve、authenticate 只能是 core 或 official（含尚无部署报告的 official_candidate）；execute 只能是 core；
// - official 必须有至少一份真实部署报告，没有报告的写成 official_candidate；
// - 能力名的前缀必须是清单实现的契约类别；
// - 配置里的密钥字段只能是挂载文件的引用：名字以 _file 结尾、string 类型、标注 x-srenautix-secret-ref；
// - 版本矩阵至少一项；core 的自托管后端以 kind_e2e 或 testcontainers 验证，SaaS 后端同时有 recorded_fixtures 与 live_smoke。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertValid, type IntegrationManifest } from '@srenautix/contract';
import { parse } from 'yaml';

export class ManifestError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}：${detail}`);
    this.name = 'ManifestError';
  }
}

/** 契约类别 → 能力名前缀 */
const CONTRACT_PREFIX: Record<string, string[]> = {
  'alerts/v1': ['alerts'],
  'metrics/v1': ['metrics'],
  'logs/v1': ['logs'],
  'traces/v1': ['traces'],
  'changes/v1': ['changes'],
  'notify/v1': ['notify'],
  'approve/v1': ['approve', 'notify'],
  'identity/v1': ['identity'],
  'model/v1': ['model'],
  'gateway/v1': ['execute'],
};

const SECRET_NAME = /(token|password|secret|private_key|api_key|apikey|credential|encrypt_key)/i;

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  'x-srenautix-secret-ref'?: boolean;
  [k: string]: unknown;
}

function checkSecrets(file: string, node: JsonSchemaNode, path: string): void {
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const here = `${path}.${name}`;
    if (child['x-srenautix-secret-ref'] === true) {
      if (!name.endsWith('_file') || child.type !== 'string') {
        throw new ManifestError(file, `${here} 标注为密钥引用，必须是以 _file 结尾的 string 字段`);
      }
    } else if (SECRET_NAME.test(name) && child.type === 'string') {
      throw new ManifestError(
        file,
        `${here} 看起来是密钥，配置里只能写挂载文件的引用（<名字>_file，并标注 x-srenautix-secret-ref: true）`,
      );
    }
    checkSecrets(file, child, here);
    if (child.items) {
      checkSecrets(file, child.items, `${here}[]`);
    }
  }
}

export interface LoadedManifest {
  dir: string;
  manifest: IntegrationManifest;
  /** fixtures/ 下的文件（相对路径） */
  fixtures: string[];
}

export function loadIntegrationManifest(dir: string): LoadedManifest {
  const file = join(dir, 'integration.yaml');
  if (!existsSync(file)) {
    throw new ManifestError(dir, '没有 integration.yaml');
  }
  let m: IntegrationManifest;
  try {
    m = assertValid<IntegrationManifest>('schemas/integration-manifest.schema.json', parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new ManifestError(file, err instanceof Error ? err.message : String(err));
  }
  if (dir.split('/').pop() !== m.id) {
    throw new ManifestError(file, `目录名必须等于集成 id ${m.id}`);
  }
  // official_candidate 是还没有部署报告的官方级，同样受官方级的约束；运行时不把它算作"支持"
  if (
    (m.direction === 'approve' || m.direction === 'authenticate') &&
    (m.tier === 'community' || m.tier === 'mcp_bridge')
  ) {
    throw new ManifestError(file, `${m.direction} 方向只能是 core 或 official，实际为 ${m.tier}`);
  }
  if (m.direction === 'execute' && m.tier !== 'core') {
    throw new ManifestError(file, `execute 方向只能是 core，实际为 ${m.tier}`);
  }
  if (m.tier === 'official' && !(m.deployment_reports ?? []).length) {
    throw new ManifestError(file, 'official 需要至少一份真实部署报告；没有报告时写成 official_candidate');
  }
  const prefixes = CONTRACT_PREFIX[m.contract];
  if (!prefixes) {
    throw new ManifestError(file, `未知的契约 ${m.contract}`);
  }
  for (const c of m.capabilities) {
    if (!prefixes.includes(c.name.split('.')[0]!)) {
      throw new ManifestError(file, `能力 ${c.name} 不属于契约 ${m.contract}`);
    }
  }
  if (m.contract === 'logs/v1' && !m.capabilities.some((c) => c.name === 'logs.match')) {
    throw new ManifestError(file, '每个日志集成都必须实现 logs.match（DESIGN §6.2）');
  }
  if (!m.tested_versions.length) {
    throw new ManifestError(file, '版本矩阵至少需要一项');
  }
  // CI 分级（DESIGN §10.5）：自托管后端用 Kind 或真实后端进程；SaaS 后端用录制夹具加每周真实账号冒烟
  const ways = new Set(m.tested_versions.map((t) => t.verification));
  const selfHosted = ways.has('kind_e2e') || ways.has('testcontainers');
  const saas = ways.has('recorded_fixtures') && ways.has('live_smoke');
  if (m.tier === 'core' && !selfHosted && !saas) {
    throw new ManifestError(
      file,
      'core 需要以 kind_e2e 或 testcontainers 验证的版本；SaaS 后端需要 recorded_fixtures 与 live_smoke 两项',
    );
  }
  checkSecrets(file, m.config_schema as JsonSchemaNode, 'config');
  const fixturesDir = join(dir, 'fixtures');
  const fixtures = existsSync(fixturesDir) ? walk(fixturesDir, fixturesDir) : [];
  return { dir, manifest: m, fixtures };
}

function walk(root: string, dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(root, p) : [p.slice(root.length + 1)];
    });
}

export function loadIntegrationManifests(root: string): LoadedManifest[] {
  const all = readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory())
    .sort()
    .map((n) => loadIntegrationManifest(join(root, n)));
  const ids = new Set<string>();
  for (const l of all) {
    if (ids.has(l.manifest.id)) {
      throw new ManifestError(l.dir, `集成 id ${l.manifest.id} 重复`);
    }
    ids.add(l.manifest.id);
  }
  return all;
}

/**
 * 一项能力只有在清单里声明过、并且 verify() 通过，才算可用（DESIGN §10.1）。
 * verified 为 verify() 的结果；返回可用能力与原因。
 */
export function availableCapabilities(
  m: IntegrationManifest,
  verified: Record<string, { ok: boolean; detail: string }>,
): { available: string[]; unavailable: Array<{ capability: string; reason: string }> } {
  const available: string[] = [];
  const unavailable: Array<{ capability: string; reason: string }> = [];
  for (const c of m.capabilities) {
    const v = verified[c.name];
    if (!v) {
      unavailable.push({ capability: c.name, reason: '没有执行 verify()' });
    } else if (!v.ok) {
      unavailable.push({ capability: c.name, reason: v.detail });
    } else {
      available.push(c.name);
    }
  }
  for (const name of Object.keys(verified)) {
    if (!m.capabilities.some((c) => c.name === name)) {
      unavailable.push({ capability: name, reason: '清单没有声明这项能力' });
    }
  }
  return { available, unavailable };
}
