// 适配器共用的 HTTP 客户端：凭证只从挂载文件读取，可选自定义 CA，请求超时，错误转为 DatasourceError。

import { readFileSync } from 'node:fs';
// 自定义 CA 的 Agent 来自 undici 包，必须配同一个包的 fetch：Node 内置 fetch 绑定的 undici 版本不同，
// 收到这个包的 dispatcher 时以 UND_ERR_INVALID_ARG 拒绝（只报 fetch failed）
import { Agent, fetch, type RequestInit } from 'undici';
import { DatasourceError } from './errors.js';

export interface HttpAuthConfig {
  bearer_token_file?: string | null;
  basic_auth?: { username: string; password_file: string } | null;
  ca_file?: string | null;
  /** 多租户后端（Mimir、Loki、Tempo）的租户，作为 X-Scope-OrgID 发送 */
  tenant?: string | null;
  /** 证书主机名与连接地址不同时（例如经 port-forward 访问）用于 TLS 校验的主机名 */
  tls_server_name?: string | null;
}

export class HttpClient {
  private readonly headers: Record<string, string> = {};
  private readonly dispatcher: Agent | undefined;

  constructor(
    readonly integration: string,
    readonly baseUrl: string,
    auth: HttpAuthConfig,
  ) {
    if (auth.tenant) {
      this.headers['X-Scope-OrgID'] = auth.tenant;
    }
    if (auth.bearer_token_file) {
      this.headers['Authorization'] = `Bearer ${readFileSync(auth.bearer_token_file, 'utf8').trim()}`;
    } else if (auth.basic_auth) {
      const pw = readFileSync(auth.basic_auth.password_file, 'utf8').trim();
      this.headers['Authorization'] = `Basic ${Buffer.from(`${auth.basic_auth.username}:${pw}`).toString('base64')}`;
    }
    if (auth.ca_file || auth.tls_server_name) {
      this.dispatcher = new Agent({
        connect: {
          ...(auth.ca_file ? { ca: readFileSync(auth.ca_file, 'utf8') } : {}),
          ...(auth.tls_server_name ? { servername: auth.tls_server_name } : {}),
        },
      });
    }
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: URLSearchParams; form?: URLSearchParams; json?: unknown; timeoutMs: number },
  ): Promise<{ status: number; text: string }> {
    const base = this.baseUrl.replace(/\/$/, '');
    const url = `${base}${path}${opts.query ? `?${opts.query.toString()}` : ''}`;
    const headers: Record<string, string> = { ...this.headers };
    let body: string | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = opts.form.toString();
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    // 超时覆盖响应头与响应体：AbortSignal.timeout 到期时 fetch 或读取响应体以 TimeoutError 失败
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } satisfies RequestInit);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      throw new DatasourceError(
        this.integration,
        `${method} ${path} 失败：${describe(err)}`,
        err instanceof Error && err.name === 'TimeoutError',
      );
    }
  }

  /** 发出请求并要求 2xx 与 JSON 响应 */
  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: URLSearchParams; form?: URLSearchParams; json?: unknown; timeoutMs: number },
  ): Promise<T> {
    const r = await this.request(method, path, opts);
    if (r.status < 200 || r.status >= 300) {
      throw new DatasourceError(this.integration, `${method} ${path} 返回 HTTP ${r.status}：${r.text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new DatasourceError(this.integration, `${method} ${path} 的响应不是 JSON：${r.text.slice(0, 200)}`);
    }
  }
}

/** fetch 只报 fetch failed，真正的原因（证书、连接拒绝、DNS）在 cause 里 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return `${err.message}（${typeof code === 'string' ? `${code} ` : ''}${cause.message}）`;
  }
  return err.message;
}
