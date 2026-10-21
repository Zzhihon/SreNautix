import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { toStreamEvents } from '../../src/llm/replay.js';

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
 * 回放队列项：夹具，或带节奏的夹具（流式请求时每个事件之间等 paceMs；stallAfter 个事件之后不再发送，用于验证空闲超时；
 * cutAfter 个事件之后断开连接，用于验证流读到一半时连接中断；malformedAfter 个事件之后送一个 data 不是 JSON 的坏 SSE 帧
 * 再正常结束，用于验证 SDK 的 SSE 解析错误），或 'hang'（不响应，用于验证首 token 超时）。
 */
export type ReplayItem =
  | LlmFixture
  | 'hang'
  | { fixture: LlmFixture; paceMs?: number; stallAfter?: number; cutAfter?: number; malformedAfter?: number };

// 流式事件的转换与 llm-replay 子命令共用（src/llm/replay.ts）
export { toStreamEvents } from '../../src/llm/replay.js';

function isStream(body: string): boolean {
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/**
 * 按顺序回放录制的响应的本地 HTTP 服务（VCR）：第 n 个请求得到队列中第 n 个夹具。
 * 请求是流式（stream: true）且夹具为 200 时，把夹具转成流式事件发送。
 * 队列项为 'hang' 时不响应，用于验证首 token 超时。收到的请求原样保存，供断言出站内容。
 */
export class ReplayServer {
  readonly received: ReceivedRequest[] = [];
  /** 录制模式下转发到上游后得到的响应，按请求顺序 */
  readonly recorded: LlmFixture[] = [];
  private queue: ReplayItem[] = [];
  private server: Server | null = null;
  private port = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  /** upstream 不为 null 时为录制模式：请求以非流式转发到上游（例如本地 llama-server 的 …/v1），响应保存后按请求方式返回 */
  constructor(private readonly upstream: string | null = null) {}

  enqueue(...items: ReplayItem[]): void {
    this.queue.push(...items);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get pending(): number {
    return this.queue.length;
  }

  private send(res: ServerResponse, path: string, body: string, item: Exclude<ReplayItem, 'hang'>): void {
    const {
      fixture: f,
      paceMs = 0,
      stallAfter,
      cutAfter,
      malformedAfter,
    } = 'fixture' in item ? item : { fixture: item };
    if (!isStream(body) || f.status !== 200) {
      res.writeHead(f.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(f.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const events = toStreamEvents(path, f.body);
    const limit = stallAfter ?? events.length;
    let i = 0;
    const next = () => {
      if (res.destroyed) {
        return;
      }
      if (cutAfter !== undefined && i >= cutAfter) {
        // 连接在流中途断开（客户端读响应体时收到 undici 的 TypeError: terminated）
        res.socket?.destroy();
        return;
      }
      if (malformedAfter !== undefined && i >= malformedAfter) {
        // 服务方送来一个坏帧（SDK 抛 SyntaxError: malformed server-sent event JSON）
        res.end('data: {"id":"chatcmpl-x","choices":[{"delta":{"content":"tr\n\n');
        return;
      }
      if (i >= limit) {
        if (limit >= events.length) {
          res.end();
        }
        return;
      }
      res.write(`data: ${events[i++]}\n\n`);
      if (paceMs > 0) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          next();
        }, paceMs);
        this.timers.add(t);
      } else {
        next();
      }
    };
    next();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const reqPath = req.url ?? '';
        this.received.push({ path: reqPath, headers: req.headers, body });
        if (this.upstream) {
          const path = reqPath.replace(/^\/v1/, '');
          let upBody = body;
          if (req.method !== 'GET' && isStream(body)) {
            const rest = JSON.parse(body) as Record<string, unknown>;
            delete rest.stream;
            delete rest.stream_options;
            upBody = JSON.stringify(rest);
          }
          void fetch(`${this.upstream}${path}`, {
            method: req.method,
            headers: { 'content-type': 'application/json' },
            body: req.method === 'GET' ? undefined : upBody,
          }).then(async (up) => {
            const text = await up.text();
            const recorded: LlmFixture = {
              provenance: { mode: 'recorded', path },
              status: up.status,
              body: JSON.parse(text) as unknown,
            };
            this.recorded.push(recorded);
            this.send(res, reqPath, body, recorded);
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
        this.send(res, reqPath, body, next);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    this.port = typeof a === 'object' && a ? a.port : 0;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
