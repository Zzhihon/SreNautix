import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { parse } from 'yaml';
import { z } from 'zod';
import { parseListen, readSecretFile } from '../config/files.js';
import { configureLog, logger } from '../log.js';
import type { RoleArgs } from '../main.js';
import { startMetricsServer } from '../metrics.js';
import { discover, ResourceServer } from '../mcp/auth.js';
import { Quotas, type QuotaLimits } from '../mcp/quota.js';
import { mcpHttpServer, type McpCaller } from '../mcp/server.js';
import { WorkerMetrics } from '../research/metrics.js';

// mcp 角色（DESIGN §1.1、§16.4）：默认关闭（Helm 不部署），只在集群内可达；OAuth 资源服务器，没有数据库，没有审批能力。
//
//   enabled: true
//   log_level: info
//   listen: { api: ":8080", metrics: ":9090" }
//   public_url: http://srenautix-mcp.srenautix.svc:8080/mcp   # 本服务的资源标识（令牌的 aud 必须等于它）
//   authorization_server: https://idp.example.com            # 发行方（issuer）
//   allowed_origins: []
//   hub_url: http://srenautix-server:8080
//   clients:
//     - client_id: holmes
//       hub_token_file: /etc/srenautix/secrets/mcp/holmes   # 中心登记的外部调用方（kind=external，channel=mcp）
//       reads_per_minute: 60
//       proposals_per_hour: 20

const schema = z
  .object({
    enabled: z.boolean(),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    listen: z
      .object({ api: z.string().default(':8080'), metrics: z.string().default(':9090') })
      .strict()
      .default({ api: ':8080', metrics: ':9090' }),
    public_url: z.string().url(),
    authorization_server: z.string().url(),
    allowed_origins: z.array(z.string()).default([]),
    hub_url: z.string().url(),
    clients: z
      .array(
        z
          .object({
            client_id: z.string().min(1),
            hub_token_file: z.string(),
            reads_per_minute: z.number().int().min(1).max(10_000).default(60),
            proposals_per_hour: z.number().int().min(1).max(1_000).default(20),
            rejection_threshold: z.number().int().min(1).max(100).default(5),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type McpConfig = z.infer<typeof schema>;

export function parseMcpConfig(raw: unknown): McpConfig {
  return schema.parse(raw);
}

export interface McpHandle {
  url: string;
  stop(): Promise<void>;
}

export async function buildMcpRole(
  c: McpConfig,
  listenOverride?: { host: string; port: number },
  noAux = false,
): Promise<McpHandle> {
  configureLog(c.log_level, { role: 'mcp' });
  if (!c.enabled) {
    throw new Error('mcp 角色默认关闭：配置中 enabled 必须为 true 才能启动');
  }
  const as = await discover(c.authorization_server);
  const callers = new Map<string, McpCaller>(
    c.clients.map((x) => [
      x.client_id,
      { clientId: x.client_id, hubToken: readSecretFile(`客户端 ${x.client_id} 的 hub_token_file`, x.hub_token_file) },
    ]),
  );
  const limits = new Map<string, QuotaLimits>(
    c.clients.map((x) => [
      x.client_id,
      {
        readsPerMinute: x.reads_per_minute,
        proposalsPerHour: x.proposals_per_hour,
        rejectionThreshold: x.rejection_threshold,
        rejectionWindowMs: 10 * 60_000,
        blockMs: 30 * 60_000,
      },
    ]),
  );
  const metrics = new WorkerMetrics('mcp', !noAux);
  const resource = new ResourceServer(c.public_url, as.issuer, as.jwks_uri, new Set(callers.keys()));
  const server = mcpHttpServer({
    hubUrl: c.hub_url.replace(/\/+$/, ''),
    callers,
    resource,
    quotas: new Quotas((id) => limits.get(id) as QuotaLimits),
    metrics,
    allowedOrigins: c.allowed_origins,
    publicUrl: c.public_url,
  });
  const l =
    listenOverride ??
    (() => {
      const p = parseListen('listen.api', c.listen.api);
      return { host: p.host ?? '0.0.0.0', port: p.port };
    })();
  await new Promise<void>((r) => server.listen(l.port, l.host, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : l.port;
  const aux: Server[] = [];
  if (!noAux) {
    const m = parseListen('listen.metrics', c.listen.metrics);
    aux.push(startMetricsServer(metrics.registry, m.host, m.port));
  }
  logger.info('mcp 已启动', { port, resource: c.public_url, clients: [...callers.keys()] });
  return {
    url: `http://${l.host}:${port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const s of aux) {
        s.close();
      }
    },
  };
}

export async function run(args: RoleArgs): Promise<void> {
  const c = parseMcpConfig(parse(readFileSync(args.configPath, 'utf8')));
  const h = await buildMcpRole(c);
  const shutdown = () => void h.stop().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
