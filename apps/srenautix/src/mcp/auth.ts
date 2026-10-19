import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

// MCP 服务的 OAuth 2.1 资源服务器（DESIGN §16.4，MCP 授权规范）：
// - 只接受授权服务器签发的 JWT 访问令牌（RFC 9068，typ=at+jwt），按发行方的 JWKS 验签；
// - 令牌必须按受众绑定到本服务（RFC 8707 Resource Indicators：aud 等于本服务的资源标识）；
// - 令牌只用于本服务，从不转发给下游（调用中心时使用该调用方自己的服务 token）；
// - 失败时返回 401 与 WWW-Authenticate，指向受保护资源元数据（RFC 9728）。

export const SCOPE_READ = 'srenautix:read';
export const SCOPE_PROPOSE = 'srenautix:propose';

export interface Principal {
  clientId: string;
  subject: string;
  scopes: Set<string>;
  expiresAt: number;
}

export class AuthFailure extends Error {
  override name = 'AuthFailure';
  constructor(
    readonly status: 401 | 403,
    readonly code: 'invalid_token' | 'insufficient_scope' | 'invalid_request',
    message: string,
  ) {
    super(message);
  }
}

interface AsMetadata {
  issuer: string;
  jwks_uri: string;
}

/** 读取授权服务器元数据（RFC 8414，失败时再试 OpenID Connect Discovery） */
export async function discover(issuer: string): Promise<AsMetadata> {
  const base = issuer.replace(/\/+$/, '');
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const m = (await r.json()) as Partial<AsMetadata>;
      if (m.issuer !== issuer || typeof m.jwks_uri !== 'string') {
        throw new Error(`授权服务器元数据不一致：issuer=${String(m.issuer)}，期望 ${issuer}`);
      }
      return { issuer: m.issuer, jwks_uri: m.jwks_uri };
    }
  }
  throw new Error(`读取授权服务器 ${issuer} 的元数据失败`);
}

export class ResourceServer {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    readonly resource: string,
    readonly issuer: string,
    jwksUri: string,
    /** 本服务认可的客户端（client_id）；不在其中的令牌拒绝 */
    private readonly clients: ReadonlySet<string>,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }

  /** WWW-Authenticate 头（RFC 6750 与 RFC 9728）；头部只能是 ASCII，中文说明放在响应体里 */
  challenge(e: AuthFailure, metadataUrl: string): string {
    const scope = e.code === 'insufficient_scope' ? `, scope="${SCOPE_READ} ${SCOPE_PROPOSE}"` : '';
    return `Bearer resource_metadata="${metadataUrl}", error="${e.code}"${scope}`;
  }

  /** 受保护资源元数据（RFC 9728） */
  metadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [SCOPE_READ, SCOPE_PROPOSE],
      bearer_methods_supported: ['header'],
    };
  }

  async verify(authorization: string | undefined): Promise<Principal> {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(authorization ?? '');
    if (!m) {
      throw new AuthFailure(401, 'invalid_token', '需要 Authorization: Bearer 访问令牌');
    }
    let payload: JWTPayload;
    try {
      const v = await jwtVerify(m[1] as string, this.jwks, {
        issuer: this.issuer,
        audience: this.resource,
        typ: 'at+jwt',
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      payload = v.payload;
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) {
        throw new AuthFailure(401, 'invalid_token', `访问令牌无效：${e.code}`);
      }
      throw e;
    }
    const clientId = typeof payload.client_id === 'string' ? payload.client_id : null;
    if (!clientId || !this.clients.has(clientId)) {
      throw new AuthFailure(403, 'invalid_token', `客户端 ${String(clientId)} 没有在本服务登记`);
    }
    const scopes = new Set(typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : []);
    return { clientId, subject: payload.sub as string, scopes, expiresAt: (payload.exp as number) * 1000 };
  }
}

export function requireScope(p: Principal, scope: string): void {
  if (!p.scopes.has(scope)) {
    throw new AuthFailure(403, 'insufficient_scope', `需要作用域 ${scope}`);
  }
}
