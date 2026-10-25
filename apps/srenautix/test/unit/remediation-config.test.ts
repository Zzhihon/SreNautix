import { describe, expect, it } from 'vitest';
import { serverConfigSchema } from '../../src/config/server.js';

// 自愈 PR 的 server 配置：与 packs 的 RepositoryLayout、platform-ops 的 values 商定的形状

describe('remediation 配置', () => {
  it('默认关闭，四类修复，likely 与 evidence_consistent 触发，被拒绝的修改冷却 7 天', () => {
    const r = serverConfigSchema.shape.remediation.parse(undefined);
    expect(r).toEqual({
      enabled: false,
      repositories: {},
      categories: ['release_rollback', 'config_resource', 'alert_rule', 'topology_coverage'],
      conclusions: ['likely', 'evidence_consistent'],
      rejected_cooldown: '7d',
    });
    expect(serverConfigSchema.shape.remediation.parse({ enabled: true }).rejected_cooldown).toBe('7d');
    expect(() => serverConfigSchema.shape.remediation.parse({ rejected_cooldown: '7 days' })).toThrow();
  });

  it('仓库角色带文件布局；未知键（branch_prefix、max_per_hour、reviewers 在 gateway 策略里）被拒绝', () => {
    const ok = serverConfigSchema.shape.remediation.parse({
      enabled: true,
      repositories: {
        gitops: {
          repo: 'acme/gitops',
          base_branch: 'main',
          files: {
            release_input: {
              path: 'apps/shop/prod/release.json',
              format: 'json',
              fields: { image: 'data.image', release_id: 'data.release_id' },
            },
            alert_rules: { path: 'platform/observability/metrics/*.yaml', format: 'yaml' },
          },
        },
      },
    });
    expect(ok.repositories.gitops?.files.release_input?.fields).toEqual({
      image: 'data.image',
      release_id: 'data.release_id',
    });
    for (const extra of [{ branch_prefix: 'srenautix/' }, { max_per_hour: 2 }, { reviewers: ['Zzhihon'] }]) {
      expect(() => serverConfigSchema.shape.remediation.parse({ enabled: true, ...extra })).toThrow();
    }
  });
});
