import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitChangesAdapter } from '../src/changes/git.js';
import { runChangesConformance } from '../src/conformance/changes.js';
import { backendsDir } from '../src/testing/backends.js';

let repo: string;
const shas: string[] = [];

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  }).trim();
}

function commit(file: string, message: string, at: string): string {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), `${message}\n`);
  git(['add', '-A']);
  const who = {
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.org',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.org',
  };
  git(['commit', '-q', '-m', message], { ...who, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  const root = join(backendsDir(), 'runs');
  mkdirSync(root, { recursive: true });
  repo = mkdtempSync(join(root, 'git-'));
  git(['init', '-q', '-b', 'main']);
  shas.push(commit('apps/web/deployment.yaml', 'web: bump image to 1.2.0', '2026-01-01T00:10:00Z'));
  shas.push(commit('apps/api/deployment.yaml', 'api: raise memory limit', '2026-01-01T00:20:00Z'));
  shas.push(commit('docs/readme.md', 'docs only', '2026-01-01T00:25:00Z'));
  shas.push(commit('apps/web/configmap.yaml', 'web: feature flag on', '2026-01-01T00:30:00Z'));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('一致性测试：changes/v1', () => {
  it('通用 git 适配器', async () => {
    const a = new GitChangesAdapter({
      id: 'git-apps',
      repo_dir: repo,
      ref: 'main',
      link_template: 'https://git.example.org/org/apps/commit/{sha}',
      paths: [
        { prefix: 'apps/web/', targets: ['Deployment:shop/web'], kind: 'gitops_sync' },
        { prefix: 'apps/api/', targets: ['Deployment:shop/api'], kind: 'gitops_sync' },
      ],
    });
    const id = (i: number) => `git-apps:${shas[i]}`;
    const r = await runChangesConformance(
      { name: 'git', source: 'git-apps', list: (req, clock) => a.list(req, clock) },
      {
        cluster_id: 'c1',
        clock: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
        busy: { window: { from: '2026-01-01T00:05:00Z', to: '2026-01-01T00:40:00Z' }, expected: [id(3), id(1), id(0)] },
        quiet: { from: '2026-01-01T00:40:00Z', to: '2026-01-01T00:50:00Z' },
        component: { key: 'Deployment:shop/web', expected: [id(3), id(0)] },
      },
    );
    expect(r.checks.filter((x) => !x.ok)).toEqual([]);
  });
});
