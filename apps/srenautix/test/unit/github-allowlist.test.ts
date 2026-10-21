import { generateKeyPairSync } from 'node:crypto';
import { applyPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { deniedRequest, GitHubApp, GitHubDenied } from '../../src/github/app.js';
import { filePatch } from '../../src/remediation/patch.js';

// server 的 GitHub 请求白名单（ADR 0025、0108）：server 对 Git 只读，写入都经 gateway 的 gitops_pr

const R = '/repos/acme/gitops';

describe('GitHub 请求白名单', () => {
  it('允许：issue 与评论、只改 issue 正文、读 PR、只改 PR 描述、读引用、读文件与目录、读提交', () => {
    for (const [m, p, b] of [
      ['GET', `${R}/issues?labels=srenautix&state=all`, undefined],
      ['POST', `${R}/issues`, { title: 't' }],
      ['PATCH', `${R}/issues/3`, { body: '新的报告' }],
      ['GET', `${R}/issues/3/comments?per_page=100`, undefined],
      ['POST', `${R}/issues/3/comments`, { body: 'x' }],
      ['GET', `${R}/pulls?head=acme:srenautix/x&state=all`, undefined],
      ['GET', `${R}/pulls/7`, undefined],
      ['PATCH', `${R}/pulls/7`, { body: 'Refs #3' }],
      ['GET', `${R}/git/ref/heads/main`, undefined],
      ['GET', `${R}/contents/apps/shop/release.json?ref=abc`, undefined],
      ['GET', `${R}/contents?ref=abc`, undefined],
      ['GET', `${R}/commits?sha=main&path=x`, undefined],
      ['GET', `${R}/commits/0123456789abcdef0123456789abcdef01234567`, undefined],
    ] as Array<[string, string, unknown]>) {
      expect(deniedRequest(m, p, b), `${m} ${p}`).toBeNull();
    }
  });

  it('拒绝：建分支、写文件、提交、开 PR、请求审阅、合并、改 issue 与 PR 的其他字段、删除、路径穿越', () => {
    for (const [m, p, b] of [
      ['POST', `${R}/git/refs`, { ref: 'refs/heads/x', sha: 'a' }],
      ['PATCH', `${R}/git/refs/heads/main`, { sha: 'a' }],
      ['DELETE', `${R}/git/refs/heads/srenautix/x`, undefined],
      ['PUT', `${R}/contents/a.yaml`, { content: 'x' }],
      ['DELETE', `${R}/contents/a.yaml`, undefined],
      ['POST', `${R}/git/commits`, {}],
      ['POST', `${R}/git/trees`, {}],
      ['POST', `${R}/pulls`, { head: 'x', base: 'main' }],
      ['POST', `${R}/pulls/7/requested_reviewers`, { reviewers: ['a'] }],
      ['PUT', `${R}/pulls/7/merge`, {}],
      ['PATCH', `${R}/pulls/7`, { state: 'closed' }],
      ['PATCH', `${R}/issues/3`, { state: 'closed' }],
      ['PATCH', `${R}/issues/3`, { body: 'x', title: 't' }],
      ['PATCH', `${R}/pulls/7`, { body: 'x', base: 'release' }],
      ['GET', `${R}/contents/../../x`, undefined],
      ['GET', '/user/repos', undefined],
    ] as Array<[string, string, unknown]>) {
      expect(deniedRequest(m, p, b), `${m} ${p}`).not.toBeNull();
    }
  });

  it('被拒绝的请求不发出（不取安装令牌、不连接 GitHub）', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;
    const gh = new GitHubApp({ apiBase: 'http://127.0.0.1:9', appId: '1', installationId: '2', privateKey: key });
    const p = gh.api('PUT', `${R}/contents/a.yaml`, { content: 'eA==' }, 'put_file');
    await expect(p).rejects.toBeInstanceOf(GitHubDenied);
    await expect(p).rejects.toMatchObject({ status: 403, message: expect.stringContaining('白名单') });
  });
});

describe('单文件补丁', () => {
  it('新文件带 new file mode 与 /dev/null；已有文件按上下文生成，两者都能应用', () => {
    const created = filePatch('a/b.yaml', null, 'x: 1\n');
    expect(created).toMatch(
      /^diff --git a\/a\/b\.yaml b\/a\/b\.yaml\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/a\/b\.yaml\n/,
    );
    expect(applyPatch('', created)).toBe('x: 1\n');
    const changed = filePatch('a/b.yaml', 'x: 1\ny: 2\n', 'x: 1\ny: 3\n');
    expect(changed).not.toContain('new file mode');
    expect(applyPatch('x: 1\ny: 2\n', changed)).toBe('x: 1\ny: 3\n');
  });
});
