import { globToRegExp, type RepoCommit, type RepoReader } from '@srenautix/packs-sdk';
import { GitHubError, type GitHubApp } from '../github/app.js';

/**
 * 修复模板读取仓库的 GitHub REST 实现（ADR 0103、0108）：server 镜像里没有 git（ADR 0096），按 GitHub App 的安装令牌只读访问。
 * - head：base 分支当前的提交（git/ref/heads），第一次调用后固定，之后的读取都在这个提交上；
 * - read：contents?ref=<提交>，不存在或是目录时为 null；
 * - list：从 glob 中第一个通配符之前的目录开始，用 contents 的目录列表逐层展开（* 不跨目录时只展开到 glob 的层数），
 *   最多 MAX_DIRS 次目录请求；
 * - history：commits?sha=<提交>&path=<路径>，再逐个读取该提交时的文件内容。
 * 只发 GET；一次计划内同一路径只读一次。
 */
const MAX_DIRS = 200;

interface ContentFile {
  type: 'file';
  content?: string;
  encoding?: string;
}

interface ContentEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  path: string;
}

interface CommitItem {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null; committer: { date: string } | null };
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export class GitHubRepoReader implements RepoReader {
  private sha: string | null = null;
  private readonly files = new Map<string, Promise<string | null>>();
  private readonly dirs = new Map<string, Promise<ContentEntry[] | null>>();

  constructor(
    private readonly gh: GitHubApp,
    readonly repo: string,
    readonly branch: string,
  ) {}

  async head(): Promise<string> {
    if (!this.sha) {
      const r = await this.gh.api<{ object: { sha: string } }>(
        'GET',
        `/repos/${this.repo}/git/ref/heads/${enc(this.branch)}`,
        undefined,
        'get_base_ref',
      );
      this.sha = r.object.sha;
    }
    return this.sha;
  }

  /** 某个提交时的文件内容；不存在或是目录时为 null */
  private async readAt(ref: string, path: string): Promise<string | null> {
    try {
      const r = await this.gh.api<ContentFile | ContentEntry[]>(
        'GET',
        `/repos/${this.repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
        undefined,
        'get_file',
      );
      if (Array.isArray(r) || r.type !== 'file' || typeof r.content !== 'string') {
        return null;
      }
      return Buffer.from(r.content, (r.encoding ?? 'base64') as BufferEncoding).toString('utf8');
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        return null;
      }
      throw e;
    }
  }

  async read(path: string): Promise<string | null> {
    const ref = await this.head();
    let p = this.files.get(path);
    if (!p) {
      p = this.readAt(ref, path);
      this.files.set(path, p);
    }
    return p;
  }

  private async listDir(dir: string): Promise<ContentEntry[] | null> {
    const ref = await this.head();
    let p = this.dirs.get(dir);
    if (!p) {
      p = (async () => {
        try {
          const r = await this.gh.api<ContentFile | ContentEntry[]>(
            'GET',
            `/repos/${this.repo}/contents/${enc(dir)}?ref=${encodeURIComponent(ref)}`,
            undefined,
            'list_dir',
          );
          return Array.isArray(r) ? r : null;
        } catch (e) {
          if (e instanceof GitHubError && e.status === 404) {
            return null;
          }
          throw e;
        }
      })();
      this.dirs.set(dir, p);
    }
    return p;
  }

  async list(glob: string): Promise<string[]> {
    const segs = glob.split('/');
    const firstWild = segs.findIndex((s) => /[*?[]/.test(s));
    if (firstWild < 0) {
      return (await this.read(glob)) === null ? [] : [glob];
    }
    const re = globToRegExp(glob);
    const deep = segs.some((s) => s.includes('**'));
    const maxDepth = segs.length;
    const out: string[] = [];
    let budget = MAX_DIRS;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (budget-- <= 0) {
        throw new Error(`展开 ${glob} 需要超过 ${MAX_DIRS} 次目录请求，请把布局的 glob 写得更具体`);
      }
      for (const e of (await this.listDir(dir)) ?? []) {
        if (e.type === 'file' && re.test(e.path)) {
          out.push(e.path);
        } else if (e.type === 'dir' && (deep || depth + 1 < maxDepth)) {
          await walk(e.path, depth + 1);
        }
      }
    };
    await walk(segs.slice(0, firstWild).join('/'), firstWild);
    return out.sort();
  }

  async history(path: string, n: number): Promise<RepoCommit[]> {
    const ref = await this.head();
    const q = new URLSearchParams({ sha: ref, path, per_page: String(Math.max(1, Math.min(100, n))) });
    const items = await this.gh.api<CommitItem[]>(
      'GET',
      `/repos/${this.repo}/commits?${q.toString()}`,
      undefined,
      'list_commits',
    );
    const out: RepoCommit[] = [];
    for (const c of items.slice(0, n)) {
      const time = c.commit.author?.date ?? c.commit.committer?.date ?? new Date(0).toISOString();
      out.push({
        commit: c.sha,
        author: c.commit.author?.name ?? '',
        time: new Date(time).toISOString(),
        message: c.commit.message.split('\n')[0] ?? '',
        content: await this.readAt(c.sha, path),
      });
    }
    return out;
  }
}
