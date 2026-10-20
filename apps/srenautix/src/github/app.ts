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

/**
 * 以 GitHub App 身份访问仓库：用 App 私钥签 JWT（RS256，有效 9 分钟）换取安装令牌（1 小时，提前 5 分钟刷新）。
 * 各功能需要的权限：覆盖 PR 要 contents 与 pull_requests 写；事件 issue 要 issues 写与 pull_requests 写（回链 PR）；
 * 变更源要 contents 读。
 */
export class GitHubApp {
  private readonly key: KeyObject;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly s: GitHubAppSettings,
    private readonly now: () => number = Date.now,
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
