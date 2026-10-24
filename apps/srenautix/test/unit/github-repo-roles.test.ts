import { describe, expect, it } from 'vitest';
import { deniedRequest, RepoRoles } from '../../src/github/app.js';

// 不变量 15（ADR 0146 §6.4、§6.5）的白名单部分：同一个 GitHub App 安装覆盖 ops 仓库与业务仓库，
// 业务仓库（business 角色）只读代码，写入只有 issue 与评论；不在任何角色里的仓库一律拒绝。

const OPS = 'CCH-HQ/cchp-k8s-ops';
const BIZ = 'CCH-HQ/claude-code-hub-plus';
const roles = new RepoRoles([
  [OPS, 'ops'],
  [BIZ, 'business'],
]);
const B = `/repos/${BIZ}`;
const O = `/repos/${OPS}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('业务仓库角色的请求白名单', () => {
  it('允许：读代码与目录树、创建 issue、追加评论、只改 issue 的标题与正文、读 issue 与评论、读提交与比较', () => {
    for (const [m, p, b] of [
      ['GET', `${B}/contents/internal/gateway/plan.go?ref=${SHA}`, undefined],
      ['GET', `${B}/contents?ref=dev`, undefined],
      ['GET', `${B}/git/trees/${SHA}?recursive=1`, undefined],
      ['POST', `${B}/issues`, { title: '[优化] 慢语句：x', body: 'y', labels: ['srenautix', 'perf'] }],
      ['POST', `${B}/issues/12/comments`, { body: '验证结果' }],
      ['PATCH', `${B}/issues/12`, { title: 't' }],
      ['PATCH', `${B}/issues/12`, { body: 'b' }],
      ['PATCH', `${B}/issues/12`, { title: 't', body: 'b' }],
      ['GET', `${B}/issues?labels=srenautix&state=all&per_page=100`, undefined],
      ['GET', `${B}/issues/12`, undefined],
      ['GET', `${B}/issues/12/comments?per_page=100`, undefined],
      ['GET', `${B}/commits/${SHA}`, undefined],
      ['GET', `${B}/compare/${SHA}...${SHA.slice(0, 12)}`, undefined],
      ['GET', `${B}/compare/v1.2.0...dev`, undefined],
    ] as Array<[string, string, unknown]>) {
      expect(deniedRequest(m, p, b, roles), `${m} ${p}`).toBeNull();
    }
  });

  it('拒绝：创建与修改 PR、读 PR、写入 contents、建分支与引用、提交、代码搜索、改标签与指派、关闭 issue、删除', () => {
    for (const [m, p, b] of [
      ['POST', `${B}/pulls`, { head: 'srenautix/x', base: 'dev' }],
      ['PATCH', `${B}/pulls/3`, { body: 'x' }],
      ['GET', `${B}/pulls`, undefined],
      ['GET', `${B}/pulls/3`, undefined],
      ['PUT', `${B}/pulls/3/merge`, {}],
      ['PUT', `${B}/contents/a.go`, { content: 'eA==', message: 'x' }],
      ['DELETE', `${B}/contents/a.go`, { message: 'x' }],
      ['POST', `${B}/git/refs`, { ref: 'refs/heads/srenautix/x', sha: SHA }],
      ['PATCH', `${B}/git/refs/heads/dev`, { sha: SHA }],
      ['GET', `${B}/git/ref/heads/dev`, undefined],
      ['POST', `${B}/git/trees`, { tree: [] }],
      ['POST', `${B}/git/commits`, {}],
      ['POST', `${B}/git/blobs`, {}],
      ['GET', `/search/code?q=repo:${BIZ}+usage_logs`, undefined],
      ['POST', `${B}/issues/12/labels`, { labels: ['a'] }],
      ['PUT', `${B}/issues/12/labels`, { labels: ['a'] }],
      ['POST', `${B}/issues/12/assignees`, { assignees: ['a'] }],
      ['PATCH', `${B}/issues/12`, { state: 'closed' }],
      ['PATCH', `${B}/issues/12`, { state: 'closed', state_reason: 'completed' }],
      ['PATCH', `${B}/issues/12`, { body: 'x', labels: ['a'] }],
      ['PATCH', `${B}/issues/12`, { assignees: ['a'] }],
      ['PATCH', `${B}/issues/12`, { milestone: 1 }],
      ['PATCH', `${B}/issues/12`, {}],
      ['DELETE', `${B}/issues/comments/5`, undefined],
      ['PATCH', `${B}/issues/comments/5`, { body: 'x' }],
      ['GET', `${B}/commits?sha=dev`, undefined],
      ['GET', `${B}/git/trees/dev`, undefined],
      ['GET', `${B}/contents/../../x`, undefined],
      ['GET', `${B}/compare/a..b`, undefined],
    ] as Array<[string, string, unknown]>) {
      expect(deniedRequest(m, p, b, roles), `${m} ${p}`).not.toBeNull();
    }
  });

  it('ops 角色的白名单与没有角色时相同；不在任何角色里的仓库与非仓库请求一律拒绝', () => {
    for (const [m, p, b] of [
      ['GET', `${O}/pulls/7`, undefined],
      ['PATCH', `${O}/pulls/7`, { body: 'Refs #3' }],
      ['GET', `${O}/git/ref/heads/main`, undefined],
      ['POST', `${O}/issues`, { title: 't' }],
      ['GET', `${O}/commits?sha=main&path=x`, undefined],
      ['PUT', `${O}/contents/a.yaml`, { content: 'x' }],
      ['POST', `${O}/pulls`, { head: 'x', base: 'main' }],
      ['GET', `${O}/git/trees/${SHA}`, undefined],
      ['GET', `${O}/compare/a...b`, undefined],
    ] as Array<[string, string, unknown]>) {
      expect(deniedRequest(m, p, b, roles), `${m} ${p}`).toBe(deniedRequest(m, p, b));
    }
    expect(deniedRequest('GET', '/repos/CCH-HQ/other/issues/1', undefined, roles)).toMatch(/不在任何仓库角色中/);
    expect(deniedRequest('GET', '/user/repos', undefined, roles)).not.toBeNull();
    // 仓库名不区分大小写
    expect(deniedRequest('POST', `/repos/${BIZ.toLowerCase()}/issues`, { title: 't' }, roles)).toBeNull();
    expect(deniedRequest('POST', `/repos/${BIZ.toUpperCase()}/pulls`, { head: 'x' }, roles)).not.toBeNull();
  });

  it('同一个仓库不能同时是两种角色', () => {
    expect(
      () =>
        new RepoRoles([
          [BIZ, 'business'],
          [BIZ.toLowerCase(), 'ops'],
        ]),
    ).toThrow(/同时被配置/);
  });
});
