import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 测试用的真实 git 仓库（变更源的上游）：提交时间可以指定，克隆地址就是目录路径。 */
export class GitRepo {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir]);
  }

  git(args: string[], at?: number): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alice',
      GIT_AUTHOR_EMAIL: 'alice@example.test',
      GIT_COMMITTER_NAME: 'Alice',
      GIT_COMMITTER_EMAIL: 'alice@example.test',
      ...(at ? { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() } : {}),
    };
    return execFileSync('git', ['-C', this.dir, ...args], { env, encoding: 'utf8' }).trim();
  }

  /** 写入文件并提交，提交时间为 at（unix 毫秒）；返回提交号。 */
  commit(path: string, content: string, message: string, at: number): string {
    mkdirSync(resolve(this.dir, path, '..'), { recursive: true });
    writeFileSync(join(this.dir, path), content);
    this.git(['add', path]);
    this.git(['commit', '--quiet', '-m', message], at);
    return this.git(['rev-parse', 'HEAD']);
  }
}
