// 业务仓库的目录树与文件内容缓存（ADR 0146 §3.5）：每个提交读取一次目录树（GET git/trees/{sha}?recursive=1），
// 在 server 内存中保留最近 3 个提交；文件内容按 blob sha 缓存，内容不变就不再读取。请求都经 GitHub App 的
// 业务仓库角色白名单（只读 contents 与 git/trees）。

export interface GitHubReader {
  api<T>(method: string, path: string, body: unknown, op: string): Promise<T>;
}

export interface TreeEntry {
  path: string;
  /** blob sha */
  sha: string;
  size: number;
}

export interface RepoTree {
  repo: string;
  commit: string;
  entries: TreeEntry[];
  /** GitHub 截断了目录树（条目过多）；截断时只有部分文件可以定位 */
  truncated: boolean;
}

interface TreeResponse {
  sha: string;
  truncated?: boolean;
  tree: Array<{ path: string; type: string; sha: string; size?: number }>;
}

interface ContentResponse {
  type: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
}

export const TREE_COMMITS = 3;
/** 文件内容缓存的总字节上限 */
export const BLOB_CACHE_BYTES = 64 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

export class RepoCodeCache {
  private readonly trees = new Map<string, RepoTree>();
  private readonly blobs = new Map<string, string>();
  private blobBytes = 0;
  /** 本对象发出的 GitHub 请求数（计入运行的 GitHub 预算） */
  requests = 0;

  constructor(private readonly gh: GitHubReader) {}

  async tree(repo: string, commit: string): Promise<RepoTree> {
    if (!SHA.test(commit)) {
      throw new Error(`目录树只按完整的提交 sha 读取：${commit}`);
    }
    const key = `${repo.toLowerCase()}@${commit}`;
    const hit = this.trees.get(key);
    if (hit) {
      // 最近使用的放到最后
      this.trees.delete(key);
      this.trees.set(key, hit);
      return hit;
    }
    this.requests++;
    const r = await this.gh.api<TreeResponse>(
      'GET',
      `/repos/${repo}/git/trees/${commit}?recursive=1`,
      undefined,
      'code_tree',
    );
    const tree: RepoTree = {
      repo,
      commit,
      entries: r.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
      truncated: r.truncated === true,
    };
    this.trees.set(key, tree);
    while (this.trees.size > TREE_COMMITS) {
      this.trees.delete(this.trees.keys().next().value as string);
    }
    return tree;
  }

  /** 文件内容（UTF-8）：按 blob sha 缓存；读取时核对 GitHub 返回的 sha 与目录树中的一致 */
  async content(repo: string, commit: string, entry: TreeEntry): Promise<string> {
    const hit = this.blobs.get(entry.sha);
    if (hit !== undefined) {
      this.blobs.delete(entry.sha);
      this.blobs.set(entry.sha, hit);
      return hit;
    }
    this.requests++;
    const path = entry.path.split('/').map(encodeURIComponent).join('/');
    const r = await this.gh.api<ContentResponse>(
      'GET',
      `/repos/${repo}/contents/${path}?ref=${commit}`,
      undefined,
      'code_content',
    );
    if (r.type !== 'file' || r.encoding !== 'base64' || r.content === undefined) {
      throw new Error(`${entry.path} 不是可以读取内容的文件（${r.type}${r.encoding ? `，${r.encoding}` : ''}）`);
    }
    if (r.sha !== entry.sha) {
      throw new Error(`${entry.path} 的内容 sha ${r.sha} 与目录树中的 ${entry.sha} 不一致`);
    }
    const text = Buffer.from(r.content, 'base64').toString('utf8');
    this.blobs.set(entry.sha, text);
    this.blobBytes += text.length;
    while (this.blobBytes > BLOB_CACHE_BYTES && this.blobs.size > 1) {
      const [k, v] = this.blobs.entries().next().value as [string, string];
      this.blobs.delete(k);
      this.blobBytes -= v.length;
    }
    return text;
  }
}
