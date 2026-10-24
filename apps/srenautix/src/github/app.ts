import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

/** GitHub App 的身份：拓扑覆盖 PR、事件 issue 与 GitHub 变更源共用同一个安装（ADR 0095）。 */
export interface GitHubAppSettings {
  apiBase: string;
  appId: string;
  installationId: string;
  /** GitHub App 私钥（PEM） */
  privateKey: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    message: string,
  ) {
    super(`GitHub ${op} 返回 HTTP ${status}：${message}`);
    this.name = 'GitHubError';
  }
}

/** 请求不在 server 的 GitHub 请求白名单内，没有发出 */
export class GitHubDenied extends GitHubError {
  constructor(op: string, detail: string) {
    super(403, op, `请求不在 server 的 GitHub 白名单内（${detail}）`);
    this.name = 'GitHubDenied';
  }
}

const REPO = '/repos/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}';
const REPO_OF = /^\/repos\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})(\/|$)/;

/**
 * 仓库角色（ADR 0146 §6.4）：同一个 GitHub App 安装覆盖 ops 仓库与业务仓库，安装的权限一样，收窄只靠 server 的
 * 请求白名单。ops 是事件 issue、修复补丁、变更源与拓扑覆盖使用的仓库；business 是主动优化读取代码、创建 issue 的
 * 业务仓库（只读代码，写入只有 issue 与评论）。
 */
export type RepoRole = 'ops' | 'business';

/** ops 角色允许的请求（路径不含查询串）：issue（含更新标题与正文）与评论、读 PR、读引用、读文件与目录、读提交 */
const ALLOWED: Array<[method: string, path: RegExp]> = [
  ['GET', new RegExp(`^${REPO}/issues$`)],
  ['GET', new RegExp(`^${REPO}/issues/\\d+$`)],
  ['PATCH', new RegExp(`^${REPO}/issues/\\d+$`)],
  ['GET', new RegExp(`^${REPO}/issues/\\d+/comments$`)],
  ['POST', new RegExp(`^${REPO}/issues$`)],
  ['POST', new RegExp(`^${REPO}/issues/\\d+/comments$`)],
  ['GET', new RegExp(`^${REPO}/pulls$`)],
  ['GET', new RegExp(`^${REPO}/pulls/\\d+$`)],
  ['PATCH', new RegExp(`^${REPO}/pulls/\\d+$`)],
  ['GET', new RegExp(`^${REPO}/git/ref/heads/.+$`)],
  ['GET', new RegExp(`^${REPO}/contents(/.*)?$`)],
  ['GET', new RegExp(`^${REPO}/commits$`)],
  ['GET', new RegExp(`^${REPO}/commits/[0-9a-f]{7,40}$`)],
];

/**
 * business 角色允许的请求（ADR 0146 §6.4）：读代码文件与目录树；创建 issue、追加评论、只改 issue 的标题与正文；
 * 为找回 issue、评论去重与读取关闭原因读 issue 与评论；为判断修复是否已部署读提交与比较。不读 PR、不读引用
 */
const BUSINESS_ALLOWED: Array<[method: string, path: RegExp]> = [
  ['GET', new RegExp(`^${REPO}/contents(/.*)?$`)],
  ['GET', new RegExp(`^${REPO}/git/trees/[0-9a-f]{7,40}$`)],
  ['POST', new RegExp(`^${REPO}/issues$`)],
  ['POST', new RegExp(`^${REPO}/issues/\\d+/comments$`)],
  ['PATCH', new RegExp(`^${REPO}/issues/\\d+$`)],
  ['GET', new RegExp(`^${REPO}/issues$`)],
  ['GET', new RegExp(`^${REPO}/issues/\\d+$`)],
  ['GET', new RegExp(`^${REPO}/issues/\\d+/comments$`)],
  ['GET', new RegExp(`^${REPO}/commits/[0-9a-f]{7,40}$`)],
  ['GET', new RegExp(`^${REPO}/compare/[A-Za-z0-9._-]{1,100}\\.\\.\\.[A-Za-z0-9._-]{1,100}$`)],
];

/** PATCH issue 时允许改的字段：标题与正文（ADR 0125、0142） */
const ISSUE_PATCH_FIELDS: ReadonlySet<string> = new Set(['title', 'body']);

/**
 * 仓库 → 角色。键不区分大小写（GitHub 的仓库名不区分大小写）。不在其中的仓库的请求一律拒绝
 */
export class RepoRoles {
  private readonly roles = new Map<string, RepoRole>();

  constructor(entries: Iterable<readonly [repo: string, role: RepoRole]>) {
    for (const [repo, role] of entries) {
      const k = repo.toLowerCase();
      const prev = this.roles.get(k);
      if (prev && prev !== role) {
        throw new Error(`仓库 ${repo} 同时被配置为 ${prev} 与 ${role} 角色`);
      }
      this.roles.set(k, role);
    }
  }

  role(repo: string): RepoRole | null {
    return this.roles.get(repo.toLowerCase()) ?? null;
  }

  list(): Array<[string, RepoRole]> {
    return [...this.roles.entries()];
  }
}

/**
 * server 的 GitHub 请求白名单（ADR 0025、0108、0125、0142、0146）。先按请求路径中的仓库取角色（roles 为 null 时所有仓库
 * 都按 ops 角色判断），再按角色的白名单判断：
 * - ops：server 只开 issue、更新 issue 的标题与正文、写评论、读 PR、给 PR 描述补 Refs，以及只读地访问仓库（修复补丁的计划、
 *   变更源、拓扑覆盖的计划）。建分支、提交、写文件、开 PR、请求审阅、合并都不在其中——Git 写入只经 gateway 的 gitops_pr。
 *   PATCH PR 只允许改描述（关闭、改标签、改指派、改 PR 的标题与目标分支都不允许）；
 * - business：见 BUSINESS_ALLOWED，没有任何 PR 请求；
 * 两个角色的 PATCH issue 都只允许改标题与正文。返回拒绝原因，允许时为 null。
 */
export function deniedRequest(
  method: string,
  path: string,
  body: unknown,
  roles: RepoRoles | null = null,
): string | null {
  const p = path.split('?')[0] ?? path;
  if (/(^|\/)\.\.(\/|$)/.test(p)) {
    return '路径含 ..';
  }
  let role: RepoRole = 'ops';
  if (roles) {
    const repo = REPO_OF.exec(p)?.[1];
    const r = repo ? roles.role(repo) : null;
    if (!r) {
      return repo ? `仓库 ${repo} 不在任何仓库角色中` : '不是仓库请求';
    }
    role = r;
  }
  if (role === 'business') {
    if (!BUSINESS_ALLOWED.some(([m, re]) => m === method && re.test(p))) {
      return '业务仓库只读代码，写入只有 issue 与评论';
    }
  } else if (!ALLOWED.some(([m, re]) => m === method && re.test(p))) {
    return 'server 不写 Git，不开 PR，不合并';
  }
  if (method === 'PATCH') {
    const keys = body && typeof body === 'object' ? Object.keys(body) : [];
    if (/\/issues\/\d+$/.test(p)) {
      if (keys.length === 0 || !keys.every((k) => ISSUE_PATCH_FIELDS.has(k))) {
        return '只允许修改 issue 的标题与正文';
      }
    } else if (keys.length !== 1 || keys[0] !== 'body') {
      return '只允许修改 PR 的描述';
    }
  }
  return null;
}

/**
 * 以 GitHub App 身份访问仓库：用 App 私钥签 JWT（RS256，有效 9 分钟）换取安装令牌（1 小时，提前 5 分钟刷新）。
 * server 只发白名单内的请求（deniedRequest）：事件 issue 要 issues 写（开出、改标题与正文、评论）与 pull_requests 写
 * （只改描述、回链 PR）；
 * 变更源、修复补丁与拓扑覆盖的计划要 contents 读。Git 写入都经 gateway 的 gitops_pr，server 不需要 contents 写。
 */
export class GitHubApp {
  private readonly key: KeyObject;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly s: GitHubAppSettings,
    private readonly now: () => number = Date.now,
    /** 仓库角色；null 时所有仓库按 ops 角色判断（只有 ops 仓库的安装与测试） */
    readonly roles: RepoRoles | null = null,
  ) {
    this.key = createPrivateKey(s.privateKey);
  }

  private async jwt(): Promise<string> {
    const iat = Math.floor(this.now() / 1000) - 60;
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.s.appId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 540)
      .sign(this.key);
  }

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > 5 * 60_000) {
      return this.token.value;
    }
    const body = await this.call<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${this.s.installationId}/access_tokens`,
      undefined,
      `Bearer ${await this.jwt()}`,
      'installation_token',
    );
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  private async call<T>(method: string, path: string, body: unknown, auth: string, op: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.s.apiBase.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: auth,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'srenautix',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new GitHubError(0, op, `不可达：${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // 非 JSON 的错误页，原样截取
      }
      throw new GitHubError(res.status, op, message);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async api<T>(method: string, path: string, body: unknown, op: string): Promise<T> {
    const denied = deniedRequest(method, path, body, this.roles);
    if (denied) {
      // 不发出请求：server 对 Git 只读，写入都经 gateway 的 gitops_pr（ADR 0025、0108）；业务仓库只有 issue 与评论（ADR 0146）
      throw new GitHubDenied(op, `${method} ${path.split('?')[0]}：${denied}`);
    }
    return this.call<T>(method, path, body, `token ${await this.installationToken()}`, op);
  }

  get settings(): GitHubAppSettings {
    return this.s;
  }

  /** 单个 issue 或 PR 在网页上的地址之外的引用写法：同仓库 #n，跨仓库 owner/name#n */
  static ref(fromRepo: string, toRepo: string, n: number): string {
    return fromRepo === toRepo ? `#${n}` : `${toRepo}#${n}`;
  }
}
