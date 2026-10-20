import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApp } from '../../src/github/app.js';
import { GitHubRepoReader } from '../../src/remediation/github-repo.js';
import { FakeGitHub } from '../support/github.js';

// 修复模板读取仓库的 GitHub REST 实现（ADR 0108）：基准提交固定在第一次 head()；目录展开 glob；文件历史读出各提交时的内容；只发 GET

const REPO = 'acme/gitops';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
let gh: FakeGitHub;
let app: GitHubApp;
const release = (id: string) =>
  `${JSON.stringify({ data: { image: `registry.example/shop@sha256:${id}`, release_id: id } }, null, 2)}\n`;

beforeAll(async () => {
  gh = new FakeGitHub('1', '2', key.publicKey, REPO);
  await gh.start();
  app = new GitHubApp({ apiBase: gh.url, appId: '1', installationId: '2', privateKey: pem });
  gh.write(
    'main',
    {
      'apps/shop/release.json': release('r1'),
      'platform/rules/shop.yaml': 'groups: []\n',
      'platform/rules/node.yaml': 'groups: []\n',
      'platform/rules/legacy/old.yaml': 'groups: []\n',
      'platform/rules/README.md': 'rules\n',
    },
    { message: 'release r1\n\nbody', author: 'alice' },
  );
  gh.write('main', { 'apps/shop/release.json': release('r2') }, { message: 'release r2', author: 'bob' });
  gh.write('main', { 'platform/rules/node.yaml': 'groups: [x]\n' }, { message: 'tune node rules' });
}, 60_000);

afterAll(async () => {
  await gh?.stop();
});

describe('GitHub REST 的仓库读取', () => {
  it('读取固定在第一次 head() 的提交上；不存在的文件与目录为 null', async () => {
    const r = new GitHubRepoReader(app, REPO, 'main');
    const head = await r.head();
    expect(head).toBe(gh.heads.get('main'));
    // 读取开始后 base 前进：同一个读取器仍然读基准提交
    gh.write('main', { 'apps/shop/release.json': release('r3') }, { message: 'release r3' });
    expect(await r.head()).toBe(head);
    expect(await r.read('apps/shop/release.json')).toBe(release('r2'));
    expect(await r.read('apps/shop/missing.json')).toBeNull();
    expect(await r.read('platform/rules')).toBeNull();
    expect(await new GitHubRepoReader(app, REPO, 'main').read('apps/shop/release.json')).toBe(release('r3'));
  });

  it('glob：* 不跨目录，** 跨目录；没有通配符时只核对文件存在', async () => {
    const r = new GitHubRepoReader(app, REPO, 'main');
    expect(await r.list('platform/rules/*.yaml')).toEqual(['platform/rules/node.yaml', 'platform/rules/shop.yaml']);
    expect(await r.list('platform/**/*.yaml')).toEqual([
      'platform/rules/legacy/old.yaml',
      'platform/rules/node.yaml',
      'platform/rules/shop.yaml',
    ]);
    expect(await r.list('apps/shop/release.json')).toEqual(['apps/shop/release.json']);
    expect(await r.list('apps/web/*.json')).toEqual([]);
  });

  it('文件历史：从基准提交往回、只含改过该文件的提交，带各提交时的内容；只发 GET', async () => {
    const before = gh.requests.length;
    const r = new GitHubRepoReader(app, REPO, 'main');
    const h = await r.history('apps/shop/release.json', 2);
    expect(h.map((c) => [c.message, c.author, c.content])).toEqual([
      ['release r3', 'dev', release('r3')],
      ['release r2', 'bob', release('r2')],
    ]);
    const all = await r.history('apps/shop/release.json', 10);
    expect(all.map((c) => c.message)).toEqual(['release r3', 'release r2', 'release r1']);
    expect(all.every((c) => /^[0-9a-f]{40}$/.test(c.commit) && !Number.isNaN(Date.parse(c.time)))).toBe(true);
    expect(
      gh.requests
        .slice(before)
        .filter((q) => !q.path.startsWith('/app/'))
        .every((q) => q.method === 'GET'),
    ).toBe(true);
  });
});
