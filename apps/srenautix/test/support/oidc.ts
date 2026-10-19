import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider, { type KoaContextWithOIDC } from 'oidc-provider';
import type { CookieJar } from 'tough-cookie';

/**
 * 测试用的真实 OIDC 身份提供方（node-oidc-provider），在进程内监听随机端口。
 * 登录用它自带的开发交互页（任意口令），授权直接按已有授权处理，所以每次交互都是登录。
 */
export interface TestIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  close(): Promise<void>;
}

export interface TestAccount {
  sub: string;
  preferred_username: string;
  email: string;
  groups: string[];
  union_id: string;
}

export async function startIdp(redirectUri: string, accounts: TestAccount[]): Promise<TestIdp> {
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://127.0.0.1:${port}`;
  const clientId = 'srenautix-test';
  const clientSecret = 'idp-client-secret-for-tests-only';
  const byId = new Map(accounts.map((a) => [a.sub, a]));
  const provider: Provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    ],
    pkce: { required: () => true },
    conformIdTokenClaims: false,
    claims: {
      openid: ['sub'],
      profile: ['preferred_username'],
      email: ['email'],
      groups: ['groups', 'union_id'],
    },
    scopes: ['openid', 'profile', 'email', 'groups'],
    features: { devInteractions: { enabled: true } },
    async findAccount(_ctx: KoaContextWithOIDC, sub: string) {
      const a = byId.get(sub);
      if (!a) {
        return undefined;
      }
      return { accountId: sub, claims: async () => ({ ...a }) };
    },
    async loadExistingGrant(ctx: KoaContextWithOIDC): Promise<InstanceType<Provider['Grant']> | undefined> {
      const accountId = ctx.oidc.session?.accountId;
      const client = ctx.oidc.client;
      if (!accountId || !client) {
        return undefined;
      }
      const grant: InstanceType<Provider['Grant']> = new provider.Grant({ accountId, clientId: client.clientId });
      grant.addOIDCScope('openid profile email groups');
      grant.addOIDCClaims(['sub', 'preferred_username', 'email', 'groups', 'union_id', 'auth_time']);
      await grant.save();
      return grant;
    },
  });
  server.on('request', provider.callback());
  return {
    issuer,
    clientId,
    clientSecret,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * 像浏览器一样跟随 IdP 的跳转（cookie 由 tough-cookie 的 CookieJar 保存）：遇到登录交互页时以 login 提交表单，
 * 直到跳到 stopAt 开头的地址。返回 stopAt 处的完整 URL（不请求它）。
 */
export async function browseUntil(start: string, stopAt: string, jar: CookieJar, login: string): Promise<URL> {
  let url = new URL(start);
  for (let hop = 0; hop < 20; hop++) {
    if (url.toString().startsWith(stopAt)) {
      return url;
    }
    let res: Response;
    if (/^\/interaction\/[^/]+$/.test(url.pathname)) {
      const body = new URLSearchParams({ prompt: 'login', login, password: 'any' });
      res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookieHeader(jar, url) },
        body,
      });
    } else {
      res = await fetch(url, { redirect: 'manual', headers: cookieHeader(jar, url) });
    }
    for (const sc of res.headers.getSetCookie()) {
      jar.setCookieSync(sc, url.toString());
    }
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) {
      throw new Error(`${url} 返回 ${res.status}，没有跳转：${(await res.text()).slice(0, 300)}`);
    }
    url = new URL(loc, url);
  }
  throw new Error('跳转次数过多');
}

function cookieHeader(jar: CookieJar, url: URL): Record<string, string> {
  const h = jar.getCookieStringSync(url.toString());
  return h ? { cookie: h } : {};
}
