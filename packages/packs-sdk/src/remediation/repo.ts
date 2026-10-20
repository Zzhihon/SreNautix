// 修复模板读取仓库的接口（ADR 0103）。server 用 GitHub REST 实现（镜像里没有 git，ADR 0096）；
// 这里的 GitRepoReader 读本地克隆的某个提交，用于 pack 命令行、测试与离线验证。

import { execFileSync } from 'node:child_process';

export interface RepoCommit {
  commit: string;
  author: string;
  /** RFC 3339 */
  time: string;
  message: string;
  /** 该提交时的文件内容；文件在该提交被删除时为 null */
  content: string | null;
}

export interface RepoReader {
  /** 基准提交 SHA（补丁基于它生成，gitops_pr 的 base_head 预检用它） */
  head(): Promise<string>;
  /** 基准提交中的文件内容；不存在时为 null */
  read(path: string): Promise<string | null>;
  /** 基准提交中匹配 glob 的文件（* 不跨目录，** 跨目录），按路径排序 */
  list(glob: string): Promise<string[]>;
  /** 修改过 path 的最近 n 个提交（含基准提交之前最近一次修改），从新到旧 */
  history(path: string, n: number): Promise<RepoCommit[]>;
}

/** glob → 正则：** 匹配任意层目录，* 与 ? 不跨目录 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export class GitRepoReader implements RepoReader {
  private files: string[] | null = null;

  constructor(
    private readonly dir: string,
    private readonly rev = 'HEAD',
  ) {}

  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  }

  private show(rev: string, path: string): string | null {
    try {
      return execFileSync('git', ['-C', this.dir, 'show', `${rev}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      // git show 对不存在的路径以非 0 退出；其余错误（仓库不存在等）由 head() 首先暴露
      if ((err as { status?: number }).status === 128) {
        return null;
      }
      throw err;
    }
  }

  async head(): Promise<string> {
    return this.git(['rev-parse', `${this.rev}^{commit}`]).trim();
  }

  async read(path: string): Promise<string | null> {
    return this.show(this.rev, path);
  }

  async list(glob: string): Promise<string[]> {
    this.files ??= this.git(['ls-tree', '-r', '--name-only', this.rev]).split('\n').filter(Boolean);
    const re = globToRegExp(glob);
    return this.files.filter((f) => re.test(f)).sort();
  }

  async history(path: string, n: number): Promise<RepoCommit[]> {
    const out = this.git(['log', `-n${n}`, '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', this.rev, '--', path]);
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [commit, author, time, message] = r.split('\x1f') as [string, string, string, string];
        return { commit, author, time: new Date(time).toISOString(), message, content: this.show(commit, path) };
      });
  }
}
