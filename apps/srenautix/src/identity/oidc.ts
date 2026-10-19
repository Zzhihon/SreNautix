import * as client from 'openid-client';
import type pg from 'pg';
import type { AuthenticatedPrincipal } from './sessions.js';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  groupsClaim: string;
  nameClaim: string;
  /** 回调地址：<public_url>/v1/auth/oidc/callback */
  redirectUri: string;
  /** 只有测试与内网开发环境的 http issuer 才允许。 */
  allowHttp: boolean;
}

export class OidcError extends Error {
  override name = 'OidcError';
}

export const OIDC_PROVIDER = 'oidc';

const STATE_TTL_S = 600;

/**
 * server 作为 OIDC 客户端（授权码 + PKCE + nonce）。state、verifier、nonce 存在 PG，10 分钟有效，用一次即删除。
 * 重新认证（H 档审批）带 max_age=0，回调时要求 ID Token 的 auth_time 不早于本次请求。
 */
export class Oidc {
  private config: client.Configuration | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly s: OidcSettings,
  ) {}

  /** 登录页显示的名称：身份提供方的主机名。 */
  get displayName(): string {
    return new URL(this.s.issuer).host;
  }

  private async cfg(): Promise<client.Configuration> {
    if (!this.config) {
      this.config = await client.discovery(
        new URL(this.s.issuer),
        this.s.clientId,
        { client_secret: this.s.clientSecret },
        client.ClientSecretPost(this.s.clientSecret),
        this.s.allowHttp ? { execute: [client.allowInsecureRequests] } : undefined,
      );
    }
    return this.config;
  }

  /** 连接测试：重新执行发现（不复用缓存），返回授权端点。身份提供方不可达或元数据不合法时抛出。 */
  async verify(): Promise<string> {
    this.config = null;
    const meta = (await this.cfg()).serverMetadata();
    if (!meta.authorization_endpoint || !meta.token_endpoint) {
      throw new OidcError('发现文档缺少 authorization_endpoint 或 token_endpoint');
    }
    return meta.authorization_endpoint;
  }

  /** 生成跳转地址并登记一次性状态。returnTo 只接受站内路径。 */
  async start(returnTo: string, maxAge: number | null): Promise<URL> {
    if (!returnTo.startsWith('/') || returnTo.startsWith('//')) {
      throw new OidcError('return_to 只能是站内路径');
    }
    const cfg = await this.cfg();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    await this.pool.query(
      'INSERT INTO server.oidc_states (state, nonce, code_verifier, return_to, max_age, created_at) VALUES ($1, $2, $3, $4, $5, now())',
      [state, nonce, verifier, returnTo, maxAge],
    );
    const params: Record<string, string> = {
      redirect_uri: this.s.redirectUri,
      scope: this.s.scopes.join(' '),
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    };
    if (maxAge !== null) {
      params.max_age = String(maxAge);
      params.prompt = 'login';
    }
    return client.buildAuthorizationUrl(cfg, params);
  }

  /** 处理回调，返回主体与跳回地址。 */
  async callback(currentUrl: URL): Promise<{ principal: AuthenticatedPrincipal; returnTo: string; reauth: boolean }> {
    const state = currentUrl.searchParams.get('state');
    if (!state) {
      throw new OidcError('回调缺少 state');
    }
    const r = await this.pool.query<{
      nonce: string;
      code_verifier: string;
      return_to: string;
      max_age: number | null;
      created_at: Date;
      expired: boolean;
    }>(
      `DELETE FROM server.oidc_states WHERE state = $1
       RETURNING nonce, code_verifier, return_to, max_age, created_at, created_at < now() - make_interval(secs => $2) AS expired`,
      [state, STATE_TTL_S],
    );
    const st = r.rows[0];
    if (!st || st.expired) {
      throw new OidcError('state 未知或已过期，请重新登录');
    }
    const cfg = await this.cfg();
    const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
      pkceCodeVerifier: st.code_verifier,
      expectedState: state,
      expectedNonce: st.nonce,
      ...(st.max_age !== null ? { maxAge: st.max_age } : {}),
    });
    const claims = tokens.claims();
    if (!claims) {
      throw new OidcError('令牌响应没有 ID Token');
    }
    const authTime = typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : new Date();
    if (st.max_age !== null && authTime.getTime() < st.created_at.getTime() - 1000) {
      throw new OidcError('身份提供方没有重新认证（auth_time 早于本次请求）');
    }
    const groupsRaw = claims[this.s.groupsClaim];
    const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : [];
    const name = claims[this.s.nameClaim];
    const externalIds: Record<string, string> = {};
    for (const k of ['union_id', 'email']) {
      const v = claims[k];
      if (typeof v === 'string') {
        externalIds[k] = v;
      }
    }
    return {
      principal: {
        principal: { id: `oidc:${claims.sub}`, display_name: typeof name === 'string' ? name : claims.sub, groups },
        provider: OIDC_PROVIDER,
        auth_time: authTime,
        mfa: Array.isArray(claims.amr) && claims.amr.includes('mfa'),
        external_ids: externalIds,
      },
      returnTo: st.return_to,
      reauth: st.max_age !== null,
    };
  }

  async purgeStates(): Promise<void> {
    await this.pool.query('DELETE FROM server.oidc_states WHERE created_at < now() - make_interval(secs => $1)', [
      STATE_TTL_S,
    ]);
  }
}
