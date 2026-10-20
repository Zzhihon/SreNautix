import { describe, expect, it } from 'vitest';
import { componentKeyOf } from '../../src/alerts/resolve.js';
import { parseRootReply } from '../../src/notify/interactions.js';
import { entityOf } from '../../src/research/checks.js';
import { parseStoredKey } from '../../src/topology/keys.js';

/** server 侧的组件键（ADR 0034）：标签里的原始名称编码成键，给人看与查询时解码，旧格式的键照常读取。 */
describe('server 的组件键', () => {
  const rbac = 'ClusterRole:cert-manager-controller-approve%3Acert-manager-io';

  it('告警标签里的原始名称编码成与 reader 相同的键；不能构成键时为 null', () => {
    expect(componentKeyOf('ClusterRole', null, 'cert-manager-controller-approve:cert-manager-io')).toBe(rbac);
    expect(componentKeyOf('Pod', 'Not_A_Label', 'x')).toBeNull();
  });

  it('查询用的实体是原始名称', () => {
    expect(entityOf('c1', rbac)).toMatchObject({
      kind: 'ClusterRole',
      namespace: null,
      name: 'cert-manager-controller-approve:cert-manager-io',
    });
  });

  it('2.8.0 之前写入的未编码键按旧格式读取', () => {
    expect(parseStoredKey('ClusterRole:a:b')).toEqual({ kind: 'ClusterRole', namespace: null, name: 'a:b' });
    expect(parseStoredKey('Pod:shop/api-1')).toEqual({ kind: 'Pod', namespace: 'shop', name: 'api-1' });
  });

  it('回复根因时可以写展示的原始名称，也可以写编码后的键', () => {
    const choices = [rbac, 'Deployment:shop/api'];
    expect(parseRootReply('ClusterRole:cert-manager-controller-approve:cert-manager-io 权限', choices)).toEqual({
      kind: 'ok',
      component: rbac,
      reason: '权限',
    });
    expect(parseRootReply(rbac, choices)).toMatchObject({ kind: 'ok', component: rbac });
    expect(parseRootReply('cert-manager-controller-approve:cert-manager-io', choices)).toMatchObject({
      kind: 'ok',
      component: rbac,
    });
  });
});
