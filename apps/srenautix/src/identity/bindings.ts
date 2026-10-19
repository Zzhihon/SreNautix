import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../config/files.js';

/**
 * 角色绑定来自 Git 挂载的目录（DESIGN §12.3、§13）。目录下每个 *.yaml 文件：
 *
 *   bindings:
 *     - subject: { kind: group, name: sre }
 *       role: approver
 *       scope: { clusters: ['*'], namespaces: [shop, pay], component_labels: {} }
 *       max_risk_tier: L
 *
 * 目录中的 REVISION 文件（git-sync 等工具写入的提交 SHA）作为版本展示；没有时用内容哈希。
 */
export const ROLES = ['viewer', 'responder', 'approver', 'auditor', 'admin', 'sys-admin', 'security-admin'] as const;
export type Role = (typeof ROLES)[number];

const bindingSchema = z
  .object({
    subject: z.object({ kind: z.enum(['user', 'group']), name: z.string().min(1) }).strict(),
    role: z.enum(ROLES),
    scope: z
      .object({
        clusters: z.array(z.string().min(1)).min(1),
        namespaces: z.array(z.string().min(1)).min(1),
        component_labels: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
    max_risk_tier: z.enum(['L', 'H']).optional(),
  })
  .strict();

const fileSchema = z.object({ bindings: z.array(bindingSchema) }).strict();

export type RoleBinding = z.infer<typeof bindingSchema>;

export const PERMISSIONS = [
  'read',
  'feedback',
  'propose',
  'research.request',
  'evidence.rerun',
  'approve',
  'reject',
  'undo',
  'audit.read',
  'prompt.raw',
  'users.read',
  'settings.write',
  'suppression.write',
  'pause.write',
  'eval.write',
  'api_tokens.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const RESPONDER: Permission[] = ['read', 'feedback', 'propose', 'research.request', 'evidence.rerun'];
const APPROVER: Permission[] = [...RESPONDER, 'approve', 'reject', 'undo'];

/** 标准配置的 5 种角色；合规配置把 admin 拆成 sys-admin 与 security-admin，与 auditor 三权分立。 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ['read'],
  responder: RESPONDER,
  approver: APPROVER,
  auditor: ['read', 'audit.read', 'prompt.raw', 'users.read'],
  admin: PERMISSIONS,
  'sys-admin': [...APPROVER, 'settings.write', 'suppression.write', 'pause.write', 'eval.write', 'api_tokens.write'],
  'security-admin': ['read', 'users.read', 'audit.read', 'settings.write'],
};

/** 授权对象：集群、命名空间（集群级对象为 null）、组件标签。 */
export interface Target {
  cluster: string;
  namespace: string | null;
  labels: Record<string, string>;
}

export interface Subject {
  id: string;
  groups: readonly string[];
}

export interface ExplainEntry {
  binding: RoleBinding;
  file: string;
  subject_match: boolean;
  grants_permission: boolean;
  scope_match: boolean;
  tier_ok: boolean;
  reason: string;
}

export interface Explanation {
  allowed: boolean;
  permission: Permission;
  target: Target | null;
  tier: 'L' | 'H' | null;
  entries: ExplainEntry[];
}

function wildcard(list: readonly string[], v: string): boolean {
  return list.includes('*') || list.includes(v);
}

export function scopeMatches(b: RoleBinding, t: Target): boolean {
  if (!wildcard(b.scope.clusters, t.cluster)) {
    return false;
  }
  // 集群级对象（命名空间为空）只由命名空间为 * 的绑定覆盖
  if (t.namespace === null ? !b.scope.namespaces.includes('*') : !wildcard(b.scope.namespaces, t.namespace)) {
    return false;
  }
  return Object.entries(b.scope.component_labels).every(([k, v]) => t.labels[k] === v);
}

/** 审批人的风险上限：未写时 approver 与 sys-admin 为 L，admin 为 H。 */
export function tierCeiling(b: RoleBinding): 'L' | 'H' | null {
  if (!ROLE_PERMISSIONS[b.role].includes('approve')) {
    return null;
  }
  return b.max_risk_tier ?? (b.role === 'admin' ? 'H' : 'L');
}

export class Bindings {
  constructor(
    readonly entries: ReadonlyArray<{ binding: RoleBinding; file: string }>,
    readonly revision: string,
  ) {}

  static load(dir: string): Bindings {
    if (!existsSync(dir)) {
      throw new ConfigError(`角色绑定目录不存在：${dir}`);
    }
    const files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
    const h = createHash('sha256');
    const entries: Array<{ binding: RoleBinding; file: string }> = [];
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      h.update(f).update('\0').update(text).update('\0');
      let raw: unknown;
      try {
        raw = parseYaml(text);
      } catch (e) {
        throw new ConfigError(`角色绑定文件 ${f} 不是合法 YAML：${(e as Error).message}`);
      }
      const r = fileSchema.safeParse(raw);
      if (!r.success) {
        throw new ConfigError(
          `角色绑定文件 ${f} 不合法：${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
        );
      }
      for (const b of r.data.bindings) {
        entries.push({ binding: b, file: f });
      }
    }
    const revFile = join(dir, 'REVISION');
    const revision = existsSync(revFile) ? readFileSync(revFile, 'utf8').trim() : `sha256:${h.digest('hex')}`;
    return new Bindings(entries, revision);
  }

  /** 主体（用户 id 与组）命中的绑定。 */
  forSubject(s: Subject): RoleBinding[] {
    return this.entries.filter((e) => subjectMatches(e.binding, s)).map((e) => e.binding);
  }

  /**
   * 判定并解释：主体对目标是否有某项权限。target 为 null 表示不针对具体对象（例如读取全局设置）。
   * tier 只用于 approve：审批人的风险上限必须覆盖提议的档位。
   */
  explain(s: Subject, permission: Permission, target: Target | null, tier: 'L' | 'H' | null = null): Explanation {
    const entries: ExplainEntry[] = this.entries.map(({ binding, file }) => {
      const subject_match = subjectMatches(binding, s);
      const grants_permission = ROLE_PERMISSIONS[binding.role].includes(permission);
      const scope_match = target === null ? true : scopeMatches(binding, target);
      const ceiling = tierCeiling(binding);
      const tier_ok =
        permission !== 'approve' || tier === null || (ceiling !== null && (ceiling === 'H' || tier === 'L'));
      let reason: string;
      if (!subject_match) {
        reason = '主体不匹配';
      } else if (!grants_permission) {
        reason = `角色 ${binding.role} 不包含权限 ${permission}`;
      } else if (!scope_match) {
        reason = '目标不在绑定的作用域内';
      } else if (!tier_ok) {
        reason = `风险上限 ${ceiling ?? '无'} 不覆盖 ${tier} 档`;
      } else {
        reason = '允许';
      }
      return { binding, file, subject_match, grants_permission, scope_match, tier_ok, reason };
    });
    const allowed = entries.some((e) => e.subject_match && e.grants_permission && e.scope_match && e.tier_ok);
    return { allowed, permission, target, tier, entries };
  }

  allowed(s: Subject, permission: Permission, target: Target | null, tier: 'L' | 'H' | null = null): boolean {
    return this.explain(s, permission, target, tier).allowed;
  }

  /** 有某项权限的作用域（用于列表过滤）：返回命中的绑定。 */
  scopesFor(s: Subject, permission: Permission): RoleBinding[] {
    return this.forSubject(s).filter((b) => ROLE_PERMISSIONS[b.role].includes(permission));
  }
}

function subjectMatches(b: RoleBinding, s: Subject): boolean {
  return b.subject.kind === 'user' ? b.subject.name === s.id : s.groups.includes(b.subject.name);
}

/** 命中的绑定中，任一个覆盖目标即可见。 */
export function visibleTo(scopes: readonly RoleBinding[], t: Target): boolean {
  return scopes.some((b) => scopeMatches(b, t));
}
