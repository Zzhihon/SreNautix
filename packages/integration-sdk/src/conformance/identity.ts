// identity/v1 一致性测试（DESIGN §10.3、§13）：身份集成输出的 AuthenticatedPrincipal 必须符合契约，
// 主体 id 稳定（同一用户两次登录得到同一 id），组或部门映射到角色绑定，auth_time 反映这次认证，
// 强制重新认证（H 档审批要求 5 分钟内认证过）后 auth_time 更新。
// 被测对象由身份实现提供（OIDC、本地管理员），在它自己的集成测试里用真实的身份提供方运行本套件。

import { validatorFor, type AuthenticatedPrincipal } from '@srenautix/contract';
import { Checks, expectEq, type ConformanceReport } from './report.js';

export interface IdentitySubject {
  name: string;
  /** 以测试用户完成一次完整的登录，返回认证结果 */
  login(user: string): Promise<AuthenticatedPrincipal>;
  /** 要求重新认证（OIDC max_age=0）后再次登录 */
  reauthenticate(user: string): Promise<AuthenticatedPrincipal>;
  /** 测试用户在身份提供方中的组 */
  expectedGroups: Record<string, string[]>;
}

export async function runIdentityConformance(s: IdentitySubject, users: [string, string]): Promise<ConformanceReport> {
  const c = new Checks('identity/v1', s.name);
  const valid = validatorFor('integrations/identity/v1/identity.schema.json#/$defs/AuthenticatedPrincipal');
  const [a, b] = users;

  await c.run('shape', '认证结果符合契约', async () => {
    const p = await s.login(a);
    if (!valid(p)) {
      throw new Error(`不符合契约：${JSON.stringify(valid.errors)}`);
    }
    return p.principal.id;
  });
  await c.run('stable-id', '同一用户两次登录得到同一主体 id，不同用户不同', async () => {
    const p1 = await s.login(a);
    const p2 = await s.login(a);
    const q = await s.login(b);
    expectEq('同一用户', p1.principal.id, p2.principal.id);
    if (p1.principal.id === q.principal.id) {
      throw new Error('两个用户得到同一主体 id');
    }
    return p1.principal.id;
  });
  await c.run('groups', '组映射', async () => {
    for (const u of users) {
      const p = await s.login(u);
      expectEq(`${u} 的组`, [...p.principal.groups].sort(), [...(s.expectedGroups[u] ?? [])].sort());
    }
    return '一致';
  });
  await c.run('reauth', '重新认证更新 auth_time', async () => {
    const p1 = await s.login(a);
    await new Promise((r) => setTimeout(r, 1100));
    const p2 = await s.reauthenticate(a);
    if (Date.parse(p2.auth_time) <= Date.parse(p1.auth_time)) {
      throw new Error(`auth_time 没有更新：${p1.auth_time} → ${p2.auth_time}`);
    }
    expectEq('主体 id', p2.principal.id, p1.principal.id);
    return `${p1.auth_time} → ${p2.auth_time}`;
  });
  return c.report();
}
