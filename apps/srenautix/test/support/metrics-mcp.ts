import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// 测试用的只读 MCP 服务器（真实的 MCP 协议实现）：query、query_range 转发到真实的 VictoriaMetrics；
// pod_get 返回一个固定的 Pod 对象（含环境变量字面值），用来验证只读当前状态的工具在回放时不可用、字面值被剔除；
// secret_get 用来验证白名单之外的工具不可见。

export interface MetricsMcp {
  url: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  stop(): Promise<void>;
}

const POD = {
  kind: 'Pod',
  metadata: { name: 'api-7d9c8b6f5-x2k4q', namespace: 'shop' },
  spec: {
    containers: [
      {
        name: 'api',
        env: [
          { name: 'DB_PASSWORD', value: 'literal-should-not-leave' },
          { name: 'MODE', value: 'prod' },
        ],
      },
    ],
  },
  status: { phase: 'Running' },
};

export async function startMetricsMcp(vmUrl: string): Promise<MetricsMcp> {
  const calls: MetricsMcp['calls'] = [];
  const build = () => {
    const s = new McpServer({ name: 'test-metrics', version: '1.0.0' });
    s.registerTool(
      'query_range',
      {
        description: 'Run a PromQL range query.',
        inputSchema: { query: z.string(), start: z.string(), end: z.string(), step: z.string().optional() },
      },
      async (args) => {
        calls.push({ tool: 'query_range', args });
        const u = new URL(`${vmUrl}/api/v1/query_range`);
        u.searchParams.set('query', args.query);
        u.searchParams.set('start', args.start);
        u.searchParams.set('end', args.end);
        u.searchParams.set('step', args.step ?? '60s');
        const r = await fetch(u);
        return { content: [{ type: 'text', text: await r.text() }], isError: !r.ok };
      },
    );
    s.registerTool(
      'query',
      { description: 'Run an instant PromQL query.', inputSchema: { query: z.string(), time: z.string().optional() } },
      async (args) => {
        calls.push({ tool: 'query', args });
        const u = new URL(`${vmUrl}/api/v1/query`);
        u.searchParams.set('query', args.query);
        if (args.time) {
          u.searchParams.set('time', args.time);
        }
        const r = await fetch(u);
        return { content: [{ type: 'text', text: await r.text() }], isError: !r.ok };
      },
    );
    s.registerTool(
      'pod_get',
      { description: 'Read a pod.', inputSchema: { namespace: z.string(), name: z.string() } },
      async (args) => {
        calls.push({ tool: 'pod_get', args });
        return { content: [{ type: 'text', text: JSON.stringify(POD) }] };
      },
    );
    s.registerTool(
      'secret_get',
      { description: 'Read a secret.', inputSchema: { namespace: z.string(), name: z.string() } },
      async (args) => {
        calls.push({ tool: 'secret_get', args });
        return { content: [{ type: 'text', text: '{"data":{"password":"x"}}' }] };
      },
    );
    return s;
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : undefined;
      const mcp = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      void mcp.connect(transport).then(() => transport.handleRequest(req, res, body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
