import { describe, expect, it } from 'vitest';
import { managingApplications, parseApplication, sameRepo } from '../../src/optimize/argo.js';
import { invertPatch, settingApplied } from '../../src/optimize/verifier.js';

// 验证循环的确定性部分（ADR 0146 §2.6）：revert 补丁、GUC 是否生效、管理被修改文件的 Argo 应用

describe('revert 补丁', () => {
  it('+ 与 - 行互换，hunk 的新旧范围互换；反转两次回到原补丁', () => {
    const patch = [
      '--- a/clusters/cchp/pg.yaml',
      '+++ b/clusters/cchp/pg.yaml',
      '@@ -10,3 +10,3 @@ spec:',
      '   postgresql:',
      '-    work_mem: 64MB',
      '+    work_mem: 96MB',
      '   other: x',
      '',
    ].join('\n');
    const r = invertPatch(patch);
    expect(r).toBe(
      [
        '--- a/clusters/cchp/pg.yaml',
        '+++ b/clusters/cchp/pg.yaml',
        '@@ -10,3 +10,3 @@ spec:',
        '   postgresql:',
        '+    work_mem: 64MB',
        '-    work_mem: 96MB',
        '   other: x',
        '',
      ].join('\n'),
    );
    expect(invertPatch(r)).toBe(patch);
    expect(invertPatch('@@ -1,0 +1,2 @@\n+a\n+b')).toBe('@@ -1,2 +1,0 @@\n-a\n-b');
  });
});

describe('GUC 是否生效', () => {
  it('按 pg_settings 的 unit 换算后比较', () => {
    expect(settingApplied('96MB', { setting: '98304', unit: 'kB' })).toBe(true);
    expect(settingApplied('96MB', { setting: '65536', unit: 'kB' })).toBe(false);
    expect(settingApplied('1GB', { setting: '131072', unit: '8kB' })).toBe(true);
    expect(settingApplied('on', { setting: 'on', unit: null })).toBe(true);
    expect(settingApplied('200', { setting: '100', unit: null })).toBe(false);
  });
});

describe('管理被修改文件的 Argo 应用', () => {
  const apps = [
    parseApplication({
      metadata: { name: 'cchp-data' },
      spec: { source: { repoURL: 'https://github.com/Zzhihon/cchp-k8s-ops.git', path: 'clusters/cchp/data' } },
      status: { sync: { status: 'Synced', revision: 'abc1234' }, health: { status: 'Healthy' } },
    }),
    parseApplication({
      metadata: { name: 'cchp-apps' },
      spec: { sources: [{ repoURL: 'git@github.com:Zzhihon/cchp-k8s-ops.git', path: 'clusters/cchp/apps' }] },
      status: { sync: { status: 'OutOfSync', revisions: ['def5678'] }, health: { status: 'Progressing' } },
    }),
    parseApplication({
      metadata: { name: 'other' },
      spec: { source: { repoURL: 'https://github.com/acme/other', path: '' } },
    }),
  ];

  it('repoURL 的几种写法指向同一个仓库，大小写不敏感', () => {
    expect(sameRepo('https://github.com/Zzhihon/cchp-k8s-ops.git', 'zzhihon/CCHP-k8s-ops')).toBe(true);
    expect(sameRepo('git@github.com:Zzhihon/cchp-k8s-ops', 'Zzhihon/cchp-k8s-ops')).toBe(true);
    expect(sameRepo('https://gitlab.com/Zzhihon/cchp-k8s-ops', 'Zzhihon/cchp-k8s-ops')).toBe(false);
  });

  it('按 source.path 匹配被修改的文件；同步与健康状态、版本从 status 读出', () => {
    const hit = managingApplications(apps, 'Zzhihon/cchp-k8s-ops', ['clusters/cchp/data/pg-cluster.yaml']);
    expect(hit.map((a) => a.name)).toEqual(['cchp-data']);
    expect(hit[0]).toMatchObject({ synced: true, healthy: true, revisions: ['abc1234'] });
    expect(managingApplications(apps, 'Zzhihon/cchp-k8s-ops', ['README.md'])).toEqual([]);
    const both = managingApplications(apps, 'Zzhihon/cchp-k8s-ops', [
      'clusters/cchp/data/a.yaml',
      'clusters/cchp/apps/b.yaml',
    ]);
    expect(both.map((a) => [a.name, a.synced, a.healthy])).toEqual([
      ['cchp-data', true, true],
      ['cchp-apps', false, false],
    ]);
    // path 为空的应用管理整个仓库
    expect(managingApplications(apps, 'acme/other', ['x/y.yaml']).map((a) => a.name)).toEqual(['other']);
  });
});
