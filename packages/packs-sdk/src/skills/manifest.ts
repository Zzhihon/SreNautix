// 读取并校验一个技能目录（ADR 0181 §2、§6.2）。技能只包含数据：清单 skill.yaml、可选的 SKILL.md、binding.schema.json、
// templates/*.md 与 tests/*.yaml；目录中出现约定之外的文件即拒绝加载。以 ConfigMap 挂载时子目录文件写成
// <子目录>__<文件名>，加载时还原；kubelet 生成的 ..data、..<时间戳> 不属于技能内容。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { assertValid, CONTRACT_VERSION, type SkillCapability, type SkillManifest } from '@srenautix/contract';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { EMPTY_OUTPUTS, STEP_KINDS } from './kinds.js';
import { collectRefs } from './refs.js';
import { checkTemplate, TemplateError } from './template.js';

export class SkillLintError extends Error {
  constructor(
    readonly where: string,
    detail: string,
  ) {
    super(`${where}：${detail}`);
    this.name = 'SkillLintError';
  }
}

export interface LoadedSkill {
  name: string;
  /** builtin 或 dir:<目录> */
  source: string;
  dir: string;
  manifest: SkillManifest;
  /** SKILL.md 原文；没有时为 null */
  instructions: string | null;
  /** 模板路径（templates/…）→ 原文 */
  templates: Record<string, string>;
  /** 绑定数据的校验函数；清单没有声明 schema 时为 null */
  binding: ValidateFunction | null;
  /** 相对路径 → sha256，按路径排序 */
  files: Array<{ path: string; sha256: string }>;
  /** sha256:<hex>，按路径排序的 "<路径>\0<sha256>\n" 的摘要 */
  digest: string;
}

const TOP = new Set(['skill.yaml', 'SKILL.md', 'binding.schema.json', 'README.md']);
const SUB: Record<string, RegExp> = {
  templates: /^[a-z0-9][A-Za-z0-9_.-]*\.md$/,
  tests: /^[a-z0-9][a-z0-9_-]*\.yaml$/,
};
const FLAT = /^(templates|tests)__([^/]+)$/;

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => !n.startsWith('..'))
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

const semver = (v: string) => v.split('.').map(Number) as [number, number, number];
const cmp = (a: string, b: string) => {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) {
      return x[i]! - y[i]!;
    }
  }
  return 0;
};

/** 契约范围 >=a <b 是否包含版本 v */
export function contractInRange(range: string, v: string): boolean {
  const m = /^>=([0-9.]+) <([0-9.]+)$/.exec(range);
  if (!m) {
    return false;
  }
  return cmp(v, m[1]!) >= 0 && cmp(v, m[2]!) < 0;
}

export function skillDigest(files: Array<{ path: string; sha256: string }>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.sha256}\n`);
  }
  return `sha256:${h.digest('hex')}`;
}

export interface LoadSkillOptions {
  /** 宿主的版本（min_srenautix_version 与它比较） */
  hostVersion: string;
  /** 宿主的契约版本；不填时为 @srenautix/contract 的版本 */
  contractVersion?: string;
}

/** 技能目录的文件（相对路径 → 绝对路径与 sha256）与内容摘要；不读取、不校验内容（重新加载时判断是否变化） */
export function skillFiles(dir: string): {
  files: Array<{ path: string; abs: string; sha256: string }>;
  digest: string;
} {
  if (!existsSync(join(dir, 'skill.yaml'))) {
    throw new SkillLintError(dir, '目录中没有 skill.yaml');
  }
  const seen = new Map<string, string>();
  for (const abs of walk(dir)) {
    const raw = relative(dir, abs).split(sep).join('/');
    const m = FLAT.exec(raw);
    const rel = m ? `${m[1]}/${m[2]}` : raw;
    const parts = rel.split('/');
    const ok = (parts.length === 1 && TOP.has(rel)) || (parts.length === 2 && SUB[parts[0]!]?.test(parts[1]!) === true);
    if (!ok) {
      throw new SkillLintError(join(dir, raw), '技能只能包含约定的数据文件');
    }
    if (seen.has(rel)) {
      throw new SkillLintError(join(dir, raw), '同一文件同时以子目录与 ConfigMap 键两种形式出现');
    }
    seen.set(rel, abs);
  }
  const files = [...seen.entries()].map(([path, abs]) => ({
    path,
    abs,
    sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
  }));
  return { files, digest: skillDigest(files) };
}

export function loadSkillDir(dir: string, source: string, o: LoadSkillOptions): LoadedSkill {
  const file = (rel: string) => join(dir, rel);
  const { files, digest } = skillFiles(dir);
  const seen = new Map(files.map((f) => [f.path, f.abs]));
  const text = (rel: string) => readFileSync(seen.get(rel)!, 'utf8');

  let manifest: SkillManifest;
  try {
    manifest = assertValid<SkillManifest>(
      'schemas/skill.schema.json',
      parse(text('skill.yaml'), { uniqueKeys: true, merge: false }) as unknown,
    );
  } catch (e) {
    throw new SkillLintError(file('skill.yaml'), e instanceof Error ? e.message : String(e));
  }
  const where = `${manifest.name}/skill.yaml`;
  if (dir.split(sep).pop() !== manifest.name) {
    throw new SkillLintError(dir, `目录名必须等于技能名 ${manifest.name}`);
  }
  const contract = o.contractVersion ?? CONTRACT_VERSION;
  if (!contractInRange(manifest.contract, contract)) {
    throw new SkillLintError(where, `契约范围 ${manifest.contract} 不包含宿主的契约版本 ${contract}`);
  }
  if (cmp(o.hostVersion.replace(/-.*$/, ''), manifest.min_srenautix_version) < 0) {
    throw new SkillLintError(
      where,
      `需要 SreNautix ${manifest.min_srenautix_version} 或更新的版本，宿主为 ${o.hostVersion}`,
    );
  }

  checkSteps(manifest, where);

  // 输出模板：标题、正文与评论
  const templates: Record<string, string> = {};
  for (const f of files.filter((x) => x.path.startsWith('templates/'))) {
    templates[f.path] = text(f.path);
  }
  const issue = manifest.outputs.issue;
  const lint = (t: string, at: string) => {
    try {
      checkTemplate(t, at);
    } catch (e) {
      if (!(e instanceof TemplateError)) {
        throw e;
      }
      throw new SkillLintError(at, e.message);
    }
  };
  for (const [lang, t] of Object.entries(issue.title)) {
    lint(t ?? '', `${where} 的 outputs.issue.title.${lang}`);
  }
  for (const p of [...Object.values(issue.templates), ...Object.values(issue.comment_templates)]) {
    if (!(p in templates)) {
      throw new SkillLintError(where, `输出模板 ${p} 不存在`);
    }
  }
  for (const [p, t] of Object.entries(templates)) {
    lint(t, `${manifest.name}/${p}`);
  }

  let binding: ValidateFunction | null = null;
  if (manifest.binding.schema) {
    if (!seen.has('binding.schema.json')) {
      throw new SkillLintError(where, '清单声明了 binding.schema.json，目录中没有这个文件');
    }
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
      binding = ajv.compile(JSON.parse(text('binding.schema.json')) as object);
    } catch (e) {
      throw new SkillLintError(`${manifest.name}/binding.schema.json`, e instanceof Error ? e.message : String(e));
    }
  } else if (manifest.binding.required) {
    throw new SkillLintError(where, 'binding.required 为 true 时必须声明 binding.schema');
  }

  return {
    name: manifest.name,
    source,
    dir,
    manifest,
    instructions: seen.has('SKILL.md') ? text('SKILL.md') : null,
    templates,
    binding,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    digest,
  };
}

/** 步骤：类型已知、id 唯一、依赖存在且没有环、引用的步骤都在 needs 中、参数合法、能力已声明 */
function checkSteps(m: SkillManifest, where: string): void {
  const declared = new Set(Object.keys(m.capabilities) as SkillCapability[]);
  const ids = new Set<string>();
  const ancestors = new Map<string, Set<string>>();
  const params = new Set(Object.keys(m.params ?? {}));
  const inputs = new Set(Object.keys((m.inputs as { properties?: Record<string, unknown> }).properties ?? {}));
  const checkRefs = (v: unknown, at: string, needs: ReadonlySet<string>) => {
    for (const r of collectRefs(v)) {
      if (r.kind === 'param' && !params.has(r.path.split('.')[0]!)) {
        throw new SkillLintError(where, `${at} 引用了没有声明的参数 ${r.path}`);
      }
      if (r.kind === 'input' && !inputs.has(r.path.split('.')[0]!)) {
        throw new SkillLintError(where, `${at} 引用了 inputs 中没有的属性 ${r.path}`);
      }
      if (r.kind === 'binding' && !m.binding.schema) {
        throw new SkillLintError(where, `${at} 引用了绑定，清单没有声明绑定 schema`);
      }
      if (r.kind === 'binding' && r.path.split('.')[0] !== 'id' && r.path.split('.')[0] !== 'data') {
        throw new SkillLintError(where, `${at} 的绑定引用必须以 id 或 data 开头：${r.path}`);
      }
      if (r.kind === 'step' && !needs.has(r.step)) {
        throw new SkillLintError(where, `${at} 引用的步骤 ${r.step} 不在 needs 中`);
      }
    }
  };
  for (const s of m.steps) {
    const at = `步骤 ${s.id}`;
    if (ids.has(s.id)) {
      throw new SkillLintError(where, `步骤 id ${s.id} 重复`);
    }
    const k = STEP_KINDS.get(s.uses);
    if (!k || !(s.uses in EMPTY_OUTPUTS)) {
      throw new SkillLintError(where, `${at} 的步骤类型 ${s.uses} 不是宿主支持的类型`);
    }
    for (const c of k.capabilities) {
      if (!declared.has(c)) {
        throw new SkillLintError(where, `${at}（${s.uses}）需要能力 ${c}，清单的 capabilities 没有声明`);
      }
    }
    const w = s.with ?? {};
    for (const key of Object.keys(w)) {
      if (!k.params.includes(key)) {
        throw new SkillLintError(where, `${at}（${s.uses}）没有参数 ${key}`);
      }
    }
    for (const key of k.required) {
      if (!(key in w)) {
        throw new SkillLintError(where, `${at}（${s.uses}）缺少参数 ${key}`);
      }
    }
    // needs 只能指向之前声明的步骤：执行顺序与声明顺序一致，也就没有环。引用可以指向直接或间接依赖的步骤
    const needs = new Set<string>();
    for (const n of s.needs ?? []) {
      if (!ids.has(n)) {
        throw new SkillLintError(where, `${at} 依赖的步骤 ${n} 不存在或声明在它之后`);
      }
      needs.add(n);
      for (const a of ancestors.get(n)!) {
        needs.add(a);
      }
    }
    checkRefs(w, at, needs);
    checkRefs(s.when, `${at} 的 when`, needs);
    ancestors.set(s.id, needs);
    ids.add(s.id);
  }
  const all = new Set(ids);
  checkRefs(m.outputs.fingerprint, 'outputs.fingerprint', all);
  checkRefs(m.outputs.issue.labels, 'outputs.issue.labels', all);
  if (!m.steps.some((s) => s.uses === 'issue.publish@v1')) {
    throw new SkillLintError(where, '技能没有 issue.publish@v1 步骤，结果无法投递');
  }
  for (const c of declared) {
    if (!m.steps.some((s) => STEP_KINDS.get(s.uses)!.capabilities.includes(c))) {
      throw new SkillLintError(where, `能力 ${c} 已声明，没有任何步骤使用它`);
    }
  }
  for (const t of m.triggers) {
    if (t.kind === 'metric') {
      checkRefs(t.condition?.value, `触发 ${t.id} 的 condition`, all);
      checkRefs(t.for, `触发 ${t.id} 的 for`, all);
    }
  }
}

/** 一个目录下的全部技能（每个子目录一个） */
export function skillDirs(root: string): string[] {
  return readdirSync(root)
    .filter((n) => !n.startsWith('.') && !n.startsWith('_') && statSync(join(root, n)).isDirectory())
    .sort()
    .map((n) => join(root, n));
}
