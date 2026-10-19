import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair } from 'jose';
import Provider, { errors } from 'oidc-provider';

// 测试用的真实 OAuth 2.1 授权服务器（node-oidc-provider）：client_credentials 授权，按 RFC 8707 的 resource 参数
// 签发绑定受众的 JWT 访问令牌（ES256，typ=at+jwt）。只登记 resources 中的资源标识。

export interface TestAs {
  issuer: string;
  token(clientId: string, resource: string, scope: string): Promise<string>;
  close(): Promise<void>;
}

export interface TestClient {
  client_id: string;
  client_secret: string;
}

export async function startAs(clients: TestClient[], resources: string[]): Promise<TestAs> {
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'test-es256', alg: 'ES256', use: 'sig' };
  const provider = new Provider(issuer, {
    clients: clients.map((c) => ({
      ...c,
      grant_types: ['client_credentials'],
      response_types: [],
      redirect_uris: [],
      token_endpoint_auth_method: 'client_secret_post',
      // 只有 ES256 签名密钥：客户端元数据的 ID Token 算法必须与之一致
      id_token_signed_response_alg: 'ES256',
    })),
    jwks: { keys: [jwk] },
    scopes: ['srenautix:read', 'srenautix:propose'],
    features: {
      clientCredentials: { enabled: true },
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => undefined,
        useGrantedResource: async () => false,
        getResourceServerInfo: async (_ctx, resourceIndicator) => {
          if (!resources.includes(resourceIndicator)) {
            throw new errors.InvalidTarget();
          }
          return {
            scope: 'srenautix:read srenautix:propose',
            accessTokenFormat: 'jwt',
            accessTokenTTL: 600,
            jwt: { sign: { alg: 'ES256' } },
          };
        },
      },
    },
  });
  server.on('request', provider.callback());
  const secrets = new Map(clients.map((c) => [c.client_id, c.client_secret]));
  return {
    issuer,
    async token(clientId, resource, scope) {
      const r = await fetch(`${issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: secrets.get(clientId) ?? '',
          resource,
          scope,
        }),
      });
      const body = (await r.json()) as { access_token?: string; error?: string; error_description?: string };
      if (!body.access_token) {
        throw new Error(`授权服务器拒绝签发令牌：${body.error} ${body.error_description}`);
      }
      return body.access_token;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
