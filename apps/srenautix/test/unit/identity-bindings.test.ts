import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bindings, scopeMatches, tierCeiling, visibleTo, type RoleBinding } from '../../src/identity/bindings.js';

const root = resolve(import.meta.dirname, `../../../../.scratch/bindings-unit-${process.pid}`);

const binding = (b: Partial<RoleBinding> & Pick<RoleBinding, 'role'>): RoleBinding => ({
  subject: { kind: 'group', name: 'sre' },
  scope: { clusters: ['prod'], namespaces: ['shop'], component_labels: {} },
  ...b,
});

beforeAll(() => mkdirSync(root, { recursive: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('作用域匹配', () => {
  it('集群、命名空间与组件标签都要命中；* 匹配任意值', () => {
    const b = binding({
      role: 'viewer',
      scope: { clusters: ['prod'], namespaces: ['shop'], component_labels: { team: 'a' } },
    });
    expect(scopeMatches(b, { cluster: 'prod', namespace: 'shop', labels: { team: 'a' } })).toBe(true);
    expect(scopeMatches(b, { cluster: 'prod', namespace: 'shop', labels: { team: 'b' } })).toBe(false);
    expect(scopeMatches(b, { cluster: 'dev', namespace: 'shop', labels: { team: 'a' } })).toBe(false);
    expect(scopeMatches(b, { cluster: 'prod', namespace: 'pay', labels: { team: 'a' } })).toBe(false);
    const all = binding({ role: 'viewer', scope: { clusters: ['*'], namespaces: ['*'], component_labels: {} } });
    expect(scopeMatches(all, { cluster: 'x', namespace: 'y', labels: {} })).toBe(true);
  });

  it('集群级对象只由命名空间为 * 的绑定覆盖', () => {
    expect(scopeMatches(binding({ role: 'viewer' }), { cluster: 'prod', namespace: null, labels: {} })).toBe(false);
    const all = binding({ role: 'viewer', scope: { clusters: ['prod'], namespaces: ['*'], component_labels: {} } });
    expect(scopeMatches(all, { cluster: 'prod', namespace: null, labels: {} })).toBe(true);
    expect(visibleTo([binding({ role: 'viewer' }), all], { cluster: 'prod', namespace: null, labels: {} })).toBe(true);
  });
});

describe('风险上限', () => {
  it('approver 默认 L，admin 默认 H，可显式指定；没有审批权限的角色没有上限', () => {
    expect(tierCeiling(binding({ role: 'approver' }))).toBe('L');
    expect(tierCeiling(binding({ role: 'approver', max_risk_tier: 'H' }))).toBe('H');
    expect(tierCeiling(binding({ role: 'admin' }))).toBe('H');
    expect(tierCeiling(binding({ role: 'admin', max_risk_tier: 'L' }))).toBe('L');
    expect(tierCeiling(binding({ role: 'viewer' }))).toBeNull();
    expect(tierCeiling(binding({ role: 'auditor' }))).toBeNull();
  });
});

describe('权限解释', () => {
  const b = new Bindings(
    [
      { binding: binding({ role: 'viewer', subject: { kind: 'user', name: 'oidc:bob' } }), file: 'a.yaml' },
      { binding: binding({ role: 'responder' }), file: 'a.yaml' },
      { binding: binding({ role: 'approver' }), file: 'b.yaml' },
    ],
    'rev',
  );
  const alice = { id: 'oidc:alice', groups: ['sre'] };
  const shop = { cluster: 'prod', namespace: 'shop', labels: {} };

  it('逐条给出原因，任一条全部满足即允许', () => {
    const e = b.explain(alice, 'approve', shop, 'L');
    expect(e.allowed).toBe(true);
    expect(e.entries.map((x) => x.reason)).toEqual(['主体不匹配', '角色 responder 不包含权限 approve', '允许']);
  });

  it('风险上限不覆盖 H 档时拒绝', () => {
    const e = b.explain(alice, 'approve', shop, 'H');
    expect(e.allowed).toBe(false);
    expect(e.entries[2]?.reason).toBe('风险上限 L 不覆盖 H 档');
  });

  it('作用域外的目标拒绝', () => {
    expect(b.allowed(alice, 'feedback', { cluster: 'prod', namespace: 'pay', labels: {} })).toBe(false);
    expect(b.allowed(alice, 'feedback', shop)).toBe(true);
  });

  it('auditor 可以读原始提示词，不能审批', () => {
    const a = new Bindings([{ binding: binding({ role: 'auditor' }), file: 'c.yaml' }], 'rev');
    expect(a.allowed(alice, 'prompt.raw', shop)).toBe(true);
    expect(a.allowed(alice, 'approve', shop, 'L')).toBe(false);
  });
});

describe('从目录加载', () => {
  it('合并目录下的 YAML 文件；有 REVISION 时用它作为版本，没有时用内容哈希', () => {
    const dir = join(root, 'with-rev');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '10-sre.yaml'),
      'bindings:\n  - subject: { kind: group, name: sre }\n    role: approver\n    scope: { clusters: [prod], namespaces: [shop] }\n',
    );
    writeFileSync(
      join(dir, '20-audit.yml'),
      'bindings:\n  - subject: { kind: user, name: "oidc:carol" }\n    role: auditor\n    scope: { clusters: ["*"], namespaces: ["*"] }\n',
    );
    writeFileSync(join(dir, 'REVISION'), 'abc123\n');
    const b = Bindings.load(dir);
    expect(b.revision).toBe('abc123');
    expect(b.entries.map((e) => e.file)).toEqual(['10-sre.yaml', '20-audit.yml']);
    expect(b.entries[0]?.binding.scope.component_labels).toEqual({});

    rmSync(join(dir, 'REVISION'));
    const h1 = Bindings.load(dir).revision;
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
    writeFileSync(join(dir, '20-audit.yml'), 'bindings: []\n');
    expect(Bindings.load(dir).revision).not.toBe(h1);
  });

  it('未知字段、未知角色或缺少目录都会失败', () => {
    const dir = join(root, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'x.yaml'),
      'bindings:\n  - subject: { kind: group, name: sre }\n    role: root\n    scope: { clusters: [a], namespaces: [b] }\n',
    );
    expect(() => Bindings.load(dir)).toThrow(/x\.yaml 不合法/);
    writeFileSync(
      join(dir, 'x.yaml'),
      'bindings:\n  - subject: { kind: group, name: sre }\n    role: viewer\n    extra: 1\n    scope: { clusters: [a], namespaces: [b] }\n',
    );
    expect(() => Bindings.load(dir)).toThrow(/不合法/);
    expect(() => Bindings.load(join(root, 'missing'))).toThrow(/不存在/);
  });
});
