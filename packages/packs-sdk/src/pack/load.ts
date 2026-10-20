// 从目录读取一个领域包（DESIGN §6.3）。每个文件按契约 schema 校验；领域包只包含数据，
// 目录中出现约定之外的文件即拒绝加载。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  assertValid,
  type ActionRequestsFile,
  type AlertsFile,
  type ChainsFile,
  type ChaosFile,
  type ChecksFile,
  type ComponentsFile,
  type KnowledgeFile,
  type PackManifest,
  type PackTestFile,
  type RcaParams,
  type RemediationsFile,
  type RulesFile,
  type SignalsFile,
} from '@srenautix/contract';
import { parse } from 'yaml';
import { PackLintError } from '../cel/errors.js';

const PACK_SCHEMA = 'schemas/pack.schema.json';

export interface PackContent {
  manifest: PackManifest;
  signals: SignalsFile;
  components: ComponentsFile;
  alerts: AlertsFile;
  chains: ChainsFile;
  checks: ChecksFile;
  rules: RulesFile;
  remediations: RemediationsFile;
  rca_params: RcaParams | null;
  /** 文件名 → 知识条目 */
  knowledge: Record<string, KnowledgeFile>;
  /** 文件名 → Markdown 原文 */
  runbooks: Record<string, string>;
  /** 文件名 → 提示词片段（低信任，启用前需要管理员批准差异） */
  prompts: Record<string, string>;
  action_requests: ActionRequestsFile;
  chaos: Record<string, ChaosFile>;
  tests: Record<string, PackTestFile>;
}

export interface LoadedPack {
  name: string;
  /** builtin、git+<url>@<sha>、oci://<ref>@<digest>，或本地目录 dir:<路径> */
  source: string;
  dir: string;
  content: PackContent;
  /** 相对路径 → sha256，按路径排序；pack.lock 的摘要由它计算 */
  files: Array<{ path: string; sha256: string }>;
}

const TOP_FILES = new Set([
  'pack.yaml',
  'signals.yaml',
  'components.yaml',
  'alerts.yaml',
  'chains.yaml',
  'checks.yaml',
  'rules.yaml',
  'remediations.yaml',
  'rca-params.yaml',
  'action-requests.yaml',
  'README.md',
]);
const SUBDIRS: Record<string, RegExp> = {
  runbooks: /^[a-z0-9][a-z0-9_-]*\.md$/,
  knowledge: /^[a-z0-9][a-z0-9_-]*\.yaml$/,
  prompts: /^[a-z0-9][a-z0-9_-]*\.md$/,
  chaos: /^[a-z0-9][a-z0-9_-]*\.yaml$/,
  tests: /^[a-z0-9][a-z0-9_-]*\.yaml$/,
};

// 以 ConfigMap 挂载的包：键不能含 '/'，子目录中的文件写成 <子目录>__<文件名>（tests/replay 下的写成 tests__replay__<文件名>），
// 加载时还原为子目录路径；挂载点里 kubelet 生成的 ..data、..<时间戳> 不属于包内容
const FLAT_KEY = /^(runbooks|knowledge|prompts|chaos|tests)__(?:(replay)__)?([^/]+)$/;

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => !n.startsWith('..'))
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

/** 包内相对路径；ConfigMap 键形式的子目录文件还原为子目录路径 */
function packPath(rel: string): string {
  const m = FLAT_KEY.exec(rel);
  if (!m) {
    return rel;
  }
  return m[2] ? `${m[1]}/${m[2]}/${m[3]}` : `${m[1]}/${m[3]}`;
}

function readYaml<T>(file: string, schemaRef: string): T {
  const doc = parse(readFileSync(file, 'utf8'), { uniqueKeys: true, merge: false }) as unknown;
  try {
    return assertValid<T>(schemaRef, doc);
  } catch (err) {
    throw new PackLintError(file, err instanceof Error ? err.message : String(err));
  }
}

export function loadPackDir(dir: string, source: string): LoadedPack {
  if (!existsSync(join(dir, 'pack.yaml'))) {
    throw new PackLintError(dir, '目录中没有 pack.yaml');
  }
  const seen = new Set<string>();
  const files = walk(dir).map((abs) => {
    const rel = packPath(relative(dir, abs).split(sep).join('/'));
    if (seen.has(rel)) {
      throw new PackLintError(join(dir, rel), '同一文件同时以子目录与 ConfigMap 键两种形式出现');
    }
    seen.add(rel);
    const parts = rel.split('/');
    const ok =
      (parts.length === 1 && TOP_FILES.has(rel)) ||
      (parts.length === 2 && SUBDIRS[parts[0]!]?.test(parts[1]!) === true) ||
      // tests/ 下可以带夹具录制（replay 快照）
      (parts.length === 3 &&
        parts[0] === 'tests' &&
        parts[1] === 'replay' &&
        /^[a-z0-9][a-z0-9_-]*\.json$/.test(parts[2]!));
    if (!ok) {
      throw new PackLintError(join(dir, rel), '领域包只能包含约定的数据文件');
    }
    return { path: rel, abs, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') };
  });

  const opt = <T>(name: string, ref: string, empty: T): T => {
    const p = join(dir, name);
    return existsSync(p) ? readYaml<T>(p, ref) : empty;
  };
  const sub = <T>(d: string, read: (abs: string) => T): Record<string, T> =>
    Object.fromEntries(
      files
        .filter((f) => f.path.startsWith(`${d}/`) && f.path.split('/').length === 2)
        .map((f) => [f.path.slice(d.length + 1), read(f.abs)]),
    );

  const manifest = readYaml<PackManifest>(join(dir, 'pack.yaml'), PACK_SCHEMA);
  const content: PackContent = {
    manifest,
    signals: opt<SignalsFile>('signals.yaml', `${PACK_SCHEMA}#/$defs/SignalsFile`, { signals: [] }),
    components: opt<ComponentsFile>('components.yaml', `${PACK_SCHEMA}#/$defs/ComponentsFile`, { component_types: [] }),
    alerts: opt<AlertsFile>('alerts.yaml', `${PACK_SCHEMA}#/$defs/AlertsFile`, { entries: [] }),
    chains: opt<ChainsFile>('chains.yaml', `${PACK_SCHEMA}#/$defs/ChainsFile`, { chains: [] }),
    checks: opt<ChecksFile>('checks.yaml', `${PACK_SCHEMA}#/$defs/ChecksFile`, { checks: [] }),
    rules: opt<RulesFile>('rules.yaml', `${PACK_SCHEMA}#/$defs/RulesFile`, { rules: [] }),
    remediations: opt<RemediationsFile>('remediations.yaml', `${PACK_SCHEMA}#/$defs/RemediationsFile`, {
      remediations: [],
    }),
    rca_params: opt<RcaParams | null>('rca-params.yaml', `${PACK_SCHEMA}#/$defs/RcaParams`, null),
    knowledge: sub('knowledge', (p) => readYaml<KnowledgeFile>(p, `${PACK_SCHEMA}#/$defs/KnowledgeFile`)),
    runbooks: sub('runbooks', (p) => readFileSync(p, 'utf8')),
    prompts: sub('prompts', (p) => readFileSync(p, 'utf8')),
    action_requests: opt<ActionRequestsFile>('action-requests.yaml', `${PACK_SCHEMA}#/$defs/ActionRequestsFile`, {
      requests: [],
    }),
    chaos: sub('chaos', (p) => readYaml<ChaosFile>(p, `${PACK_SCHEMA}#/$defs/ChaosFile`)),
    tests: sub('tests', (p) => readYaml<PackTestFile>(p, `${PACK_SCHEMA}#/$defs/PackTestFile`)),
  };
  if (dir.split(sep).pop() !== manifest.name) {
    throw new PackLintError(dir, `目录名必须等于包名 ${manifest.name}`);
  }
  return { name: manifest.name, source, dir, content, files: files.map(({ path, sha256 }) => ({ path, sha256 })) };
}

/** 包的内容摘要：按路径排序的 "<路径>\0<sha256>\n" 的 sha256 */
export function packDigest(files: Array<{ path: string; sha256: string }>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.sha256}\n`);
  }
  return `sha256:${h.digest('hex')}`;
}
