import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { HttpError } from '../api/errors.js';
import { addOverride, type TopologyOverride } from './overrides.js';

export interface GitHubAppSettings {
  apiBase: string;
  appId: string;
  installationId: string;
  /** GitHub App 私钥（PEM） */
  privateKey: string;
  /** owner/name */
  repo: string;
  baseBranch: string;
  /** 仓库中覆盖文件所在的目录；每个集群一个文件 <dir>/<cluster_id>.yaml */
  dir: string;
}

export interface OverridePrResult {
  pr_url: string;
  branch: string;
  head_sha: string;
}

class GitHubError extends Error {
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
 * 只用到的接口：读取分支与文件、建分支、写文件、开 PR；App 只需要该仓库的 contents 与 pull_requests 写权限。
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
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'x'
  );
}

/**
 * 为未映射的告警开覆盖规则的 PR（DESIGN §12）：在 srenautix/* 分支上修改 <dir>/<cluster_id>.yaml，开 PR，从不合并。
 * - 基础分支上已有同一集群、同一告警名的规则：409；
 * - 同一内容的分支已经存在（PR 已开过）：409；
 * - GitHub 拒绝 App 身份（未安装、私钥或 App id 不对）或不可达：503，带原因。
 */
export async function createOverridePr(
  gh: GitHubApp,
  o: TopologyOverride,
  requestedBy: string,
): Promise<OverridePrResult> {
  const s = gh.settings;
  const path = `${s.dir.replace(/\/+$/, '')}/${o.cluster_id}.yaml`;
  const digest = createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8);
  const branch = `srenautix/topology-override-${slug(o.cluster_id)}-${slug(o.alertname)}-${digest}`;
  try {
    const base = await gh.api<{ object: { sha: string } }>(
      'GET',
      `/repos/${s.repo}/git/ref/heads/${encodeURIComponent(s.baseBranch)}`,
      undefined,
      'get_base_ref',
    );
    let existing: { content: string; sha: string } | null = null;
    try {
      const f = await gh.api<{ content: string; sha: string; encoding: string }>(
        'GET',
        `/repos/${s.repo}/contents/${path}?ref=${encodeURIComponent(s.baseBranch)}`,
        undefined,
        'get_file',
      );
      existing = { content: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha };
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) {
        throw e;
      }
    }
    const next = addOverride(existing?.content ?? null, path, o);
    if (next === null) {
      throw new HttpError(409, 'conflict', `${path} 中已有集群 ${o.cluster_id} 告警 ${o.alertname} 的覆盖规则`);
    }
    try {
      await gh.api(
        'POST',
        `/repos/${s.repo}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: base.object.sha },
        'create_branch',
      );
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) {
        throw new HttpError(409, 'conflict', `分支 ${branch} 已存在：这条覆盖规则的 PR 已经开过`);
      }
      throw e;
    }
    const put = await gh.api<{ commit: { sha: string } }>(
      'PUT',
      `/repos/${s.repo}/contents/${path}`,
      {
        message: `topology: map ${o.alertname} in ${o.cluster_id} to ${o.component} as ${o.role}`,
        content: Buffer.from(next).toString('base64'),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      },
      'put_file',
    );
    const pr = await gh.api<{ html_url: string }>(
      'POST',
      `/repos/${s.repo}/pulls`,
      {
        title: `topology: map ${o.alertname} (${o.cluster_id}) to ${o.component}`,
        head: branch,
        base: s.baseBranch,
        body: [
          `由 SreNautix 控制台为未映射的告警生成，发起人 ${requestedBy}。`,
          '',
          `- 集群：${o.cluster_id}`,
          `- 告警：${o.alertname}`,
          `- 组件：${o.component}`,
          `- 角色：${o.role}`,
          '',
          '合并后 server 在下一次重新加载拓扑覆盖目录时生效。',
        ].join('\n'),
        maintainer_can_modify: true,
      },
      'create_pull',
    );
    return { pr_url: pr.html_url, branch, head_sha: put.commit.sha };
  } catch (e) {
    if (e instanceof GitHubError) {
      const why =
        e.status === 0
          ? 'GitHub 不可达'
          : e.status === 401 || e.op === 'installation_token'
            ? 'GitHub App 身份无效或没有安装到仓库'
            : e.status === 403 || e.status === 404
              ? `GitHub App 没有仓库 ${s.repo} 的权限，或仓库、分支 ${s.baseBranch} 不存在`
              : 'GitHub 请求失败';
      throw new HttpError(503, 'unavailable', `${why}：${e.message}`);
    }
    throw e;
  }
}
