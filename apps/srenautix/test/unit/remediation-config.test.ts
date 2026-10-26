import { describe, expect, it } from 'vitest';
import { serverConfigSchema, upgradeRaw } from '../../src/config/server.js';

// 自愈 PR 的 server 配置：与 packs 的 RepositoryLayout、platform-ops 的 values 商定的形状

describe('remediation 配置', () => {
  it('默认关闭，三类修复，likely 与 evidence_consistent 触发，被拒绝的修改冷却 7 天', () => {
    const r = serverConfigSchema.shape.remediation.parse(undefined);
    expect(r).toEqual({
      enabled: false,
      repositories: {},
      categories: ['release_rollback', 'config_resource', 'alert_rule'],
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

  it('categories 中的 topology_coverage（ADR 0171）在解析之前去掉，返回弃用说明；其余类别与配置不变', () => {
    const raw = { remediation: { enabled: true, categories: ['release_rollback', 'topology_coverage', 'alert_rule'] } };
    const up = upgradeRaw(raw);
    expect(up.raw).toEqual({ remediation: { enabled: true, categories: ['release_rollback', 'alert_rule'] } });
    expect(up.deprecated).toEqual([
      'remediation.categories 中的 topology_coverage 已忽略：拓扑与领域包覆盖的缺口不再开自愈 PR，改为每个缺口一个 issue（issues 开启时，ADR 0171）',
    ]);
    // 原始配置不被改动
    expect(raw.remediation.categories).toEqual(['release_rollback', 'topology_coverage', 'alert_rule']);
    expect(
      serverConfigSchema.shape.remediation.parse((up.raw as { remediation: unknown }).remediation).categories,
    ).toEqual(['release_rollback', 'alert_rule']);
    // 只写了 topology_coverage 时类别为空：不开任何自愈 PR
    expect(upgradeRaw({ remediation: { categories: ['topology_coverage'] } }).raw).toEqual({
      remediation: { categories: [] },
    });
    // 没有写 topology_coverage 时没有弃用说明；解析不接受它
    expect(upgradeRaw({ remediation: { categories: ['alert_rule'] } }).deprecated).toEqual([]);
    expect(() => serverConfigSchema.shape.remediation.parse({ categories: ['topology_coverage'] })).toThrow();
  });
});
