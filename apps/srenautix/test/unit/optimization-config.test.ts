import { describe, expect, it } from 'vitest';
import { opsRepositories, parseServerConfig, serverConfigSchema } from '../../src/config/server.js';
import { DEFAULT_OPTIMIZATION } from '../../src/optimize/config.js';

// 主动优化已退役（optimization.enabled 必须为 false）；optimization.repositories.business 仍保留供 oom-rootcause 技能定位业务代码

const minimal = (extra: Record<string, unknown>) => ({
  cluster_id: 'c1',
  profile: 'observe',
  public_url: 'https://srenautix.example.com',
  ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }] },
  datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
  packs: { dirs: ['/packs'] },
  callers: { tokens_file: '/callers.yaml' },
  identity: { bindings_dir: '/bindings' },
  audit: { checkpoint_key_file: '/checkpoint.pem' },
  ...extra,
});

const app = { app_id: '1', installation_id: '2', private_key_file: '/k.pem' };

const code = {
  version: { rule: 'running', release_input: 'release_input', field: 'business_commit' },
  root: '',
  include: ['**/*.go', '**/*.ts'],
  exclude: ['**/mocks/**'],
  languages: ['go', 'typescript'],
  anchors: [{ kind: 'sql', paths: ['internal/**'] }],
  labels: [{ paths: ['internal/gateway/**'], label: 'area/gateway' }],
};

describe('optimization 配置', () => {
  it('默认关闭，没有业务仓库；开启 optimization.enabled 时拒绝启动', () => {
    const o = serverConfigSchema.shape.optimization.parse(undefined);
    expect(o).toEqual(DEFAULT_OPTIMIZATION);
    expect(o.enabled).toBe(false);
    expect(o.title_prefix).toBe('[优化]');
    expect(o.repositories.business).toBeUndefined();
    expect(o.limits.dbstats).toEqual({ concurrency: 1, per_hour: 60, statement_text_per_hour: 6 });
    expect(o.limits.metrics).toEqual({ concurrency: 2, per_hour: 600 });
    expect(o.limits.github).toEqual({ concurrency: 2, per_hour: 1000 });
    expect(() => parseServerConfig(minimal({ optimization: { enabled: true } }))).toThrow(
      /主动优化（optimization\.enabled）已退役/,
    );
  });

  it('业务仓库的代码布局按契约 CodeLayout 校验（enabled=false 时供 oom-rootcause 使用），未知键被拒绝', () => {
    const o = serverConfigSchema.shape.optimization.parse({
      enabled: false,
      repositories: { business: { repo: 'CCH-HQ/claude-code-hub-plus', default_branch: 'dev', code } },
    });
    expect(o.repositories.business).toEqual({ repo: 'CCH-HQ/claude-code-hub-plus', default_branch: 'dev', code });
    const parse = (business: unknown) => () =>
      serverConfigSchema.shape.optimization.parse({ repositories: { business } });
    expect(parse({ repo: 'a/b', code, write: true })).toThrow();
    expect(parse({ repo: 'a/b', code: { ...code, anchors: [{ kind: 'regex', paths: ['**'] }] } })).toThrow(
      /CodeLayout/,
    );
    expect(parse({ repo: 'a/b', code: { ...code, max_files: 500 } })).toThrow(/CodeLayout/);
    expect(parse({ repo: 'a/b' })).toThrow();
    expect(() => serverConfigSchema.shape.optimization.parse({ repositories: { other: { repo: 'a/b' } } })).toThrow();
  });

  it('业务仓库需要 github_app，并且不能同时是 ops 仓库', () => {
    const business = { repositories: { business: { repo: 'CCH-HQ/claude-code-hub-plus', code } } };
    expect(() => parseServerConfig(minimal({ optimization: business }))).toThrow(/需要 github_app/);
    const c = parseServerConfig(
      minimal({
        github_app: app,
        optimization: business,
        issues: { enabled: true, repo: 'CCH-HQ/cchp-k8s-ops' },
        topology: { source: 'off', override_pr: { repo: 'CCH-HQ/cchp-k8s-ops' } },
      }),
    );
    expect(opsRepositories(c)).toEqual(['CCH-HQ/cchp-k8s-ops', 'CCH-HQ/cchp-k8s-ops']);
    expect(() =>
      parseServerConfig(
        minimal({
          github_app: app,
          optimization: business,
          issues: { enabled: true, repo: 'cch-hq/Claude-Code-Hub-Plus' },
        }),
      ),
    ).toThrow(/同时是 ops 仓库/);
  });
});
