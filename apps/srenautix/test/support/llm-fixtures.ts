import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';

// 模型层测试的夹具：test/fixtures/llm/<provider>/<name>.json，内容是服务方实际返回（或官方文档给出）的响应，
// 由 scripts/record-llm-fixtures.ts 与 scripts/extract-openai-doc-fixtures.ts 生成。

export interface LlmFixture {
  provenance: Record<string, string>;
  request?: Record<string, unknown>;
  status: number;
  body: unknown;
}

const ROOT = resolve(import.meta.dirname, '../fixtures/llm');

export function fixture(provider: string, name: string): LlmFixture {
  return JSON.parse(readFileSync(join(ROOT, provider, `${name}.json`), 'utf8')) as LlmFixture;
}

export function fixtureNames(provider: string): string[] {
  return readdirSync(join(ROOT, provider))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

export interface ReceivedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * 按顺序回放录制的响应的本地 HTTP 服务（VCR）：第 n 个请求得到队列中第 n 个夹具。
 * 队列项为 'hang' 时不响应，用于验证调用超时。收到的请求原样保存，供断言出站内容。
 */
export class ReplayServer {
  readonly received: ReceivedRequest[] = [];
  /** 录制模式下转发到上游后得到的响应，按请求顺序 */
  readonly recorded: LlmFixture[] = [];
  private queue: Array<LlmFixture | 'hang'> = [];
  private server: Server | null = null;
  private port = 0;

  /** upstream 不为 null 时为录制模式：请求转发到上游（例如本地 llama-server 的 …/v1），响应原样返回并保存 */
  constructor(private readonly upstream: string | null = null) {}

  enqueue(...items: Array<LlmFixture | 'hang'>): void {
    this.queue.push(...items);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get pending(): number {
    return this.queue.length;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.received.push({ path: req.url ?? '', headers: req.headers, body });
        if (this.upstream) {
          const path = (req.url ?? '').replace(/^\/v1/, '');
          void fetch(`${this.upstream}${path}`, {
            method: req.method,
            headers: { 'content-type': 'application/json' },
            body: req.method === 'GET' ? undefined : body,
          }).then(async (up) => {
            const text = await up.text();
            this.recorded.push({
              provenance: { mode: 'recorded', path },
              status: up.status,
              body: JSON.parse(text) as unknown,
            });
            res.writeHead(up.status, { 'content-type': 'application/json' });
            res.end(text);
          });
          return;
        }
        const next = this.queue.shift();
        if (next === undefined) {
          res.writeHead(599, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'replay queue empty' } }));
          return;
        }
        if (next === 'hang') {
          return;
        }
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    this.port = typeof a === 'object' && a ? a.port : 0;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
