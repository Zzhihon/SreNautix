import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
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
 * 回放队列项：夹具，或带节奏的夹具（流式请求时每个事件之间等 paceMs；stallAfter 个事件之后不再发送，用于验证空闲超时），
 * 或 'hang'（不响应，用于验证首 token 超时）。
 */
export type ReplayItem = LlmFixture | 'hang' | { fixture: LlmFixture; paceMs?: number; stallAfter?: number };

const PIECE = 24;

function pieces(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += PIECE) {
    out.push(text.slice(i, i + PIECE));
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 夹具是服务方的原始 JSON */
/**
 * 把非流式夹具的响应体转成服务方会发出的流式事件（SSE 的 data 部分，按顺序）：
 * Responses 为 response.created、各输出增量、response.completed（或 incomplete）；
 * Chat 为逐块的 delta、带 finish_reason 的块、只有 usage 的块与 [DONE]。
 */
export function toStreamEvents(path: string, body: any): string[] {
  const out: unknown[] = [];
  if (path.endsWith('/responses')) {
    let seq = 0;
    out.push({
      type: 'response.created',
      sequence_number: seq++,
      response: { ...body, status: 'in_progress', output: [] },
    });
    (body.output ?? []).forEach((item: any, oi: number) => {
      if (item.type === 'message') {
        (item.content ?? []).forEach((c: any, ci: number) => {
          const text = c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : '';
          const type = c.type === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta';
          for (const d of pieces(text ?? '')) {
            out.push({ type, item_id: item.id, output_index: oi, content_index: ci, delta: d, sequence_number: seq++ });
          }
        });
      } else if (item.type === 'function_call') {
        for (const d of pieces(item.arguments ?? '')) {
          out.push({
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: oi,
            delta: d,
            sequence_number: seq++,
          });
        }
      } else if (item.type === 'reasoning') {
        for (const s of item.summary ?? []) {
          for (const d of pieces(s.text ?? '')) {
            out.push({
              type: 'response.reasoning_summary_text.delta',
              item_id: item.id,
              output_index: oi,
              summary_index: 0,
              delta: d,
              sequence_number: seq++,
            });
          }
        }
      }
    });
    out.push({
      type: body.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      sequence_number: seq++,
      response: body,
    });
    return out.map((x) => JSON.stringify(x));
  }
  const head = {
    id: body.id,
    object: 'chat.completion.chunk',
    created: body.created,
    model: body.model,
    system_fingerprint: body.system_fingerprint ?? null,
  };
  const choice = body.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const chunk = (delta: unknown, finish: string | null = null) => ({
    ...head,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
  out.push(chunk({ role: 'assistant', content: '' }));
  for (const d of pieces(msg.reasoning_content ?? '')) {
    out.push(chunk({ reasoning_content: d }));
  }
  for (const d of pieces(msg.content ?? '')) {
    out.push(chunk({ content: d }));
  }
  (msg.tool_calls ?? []).forEach((t: any, i: number) => {
    out.push(
      chunk({
        tool_calls: [{ index: i, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } }],
      }),
    );
    for (const d of pieces(t.function.arguments ?? '')) {
      out.push(chunk({ tool_calls: [{ index: i, function: { arguments: d } }] }));
    }
  });
  out.push(chunk({}, choice.finish_reason ?? 'stop'));
  if (body.usage) {
    out.push({ ...head, choices: [], usage: body.usage });
  }
  return [...out.map((x) => JSON.stringify(x)), '[DONE]'];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
    const { fixture: f, paceMs = 0, stallAfter } = 'fixture' in item ? item : { fixture: item };
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
