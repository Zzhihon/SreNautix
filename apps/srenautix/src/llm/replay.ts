import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { logger } from '../log.js';

/**
 * 录制回放的模型服务（`srenautix llm-replay`，kind-e2e 与离线演示用，OpenAI 兼容：POST /v1/responses、/v1/chat/completions）。
 *
 * - 按"结构化输出的名称 + 第几次出现"取录制：目录中的 `<名称>-<n>.json`（n 从 1 开始），没有时取 `<名称>.json`（任意次）；
 *   名称是 Responses 的 text.format.name 或 Chat 的 response_format.json_schema.name，没有结构化输出时为 `text`。
 *   提示中的易变内容（时间、Pod 名、卡片编号）不参与匹配。没有可用的录制时返回 503，worker 视为模型不可用。
 * - 录制文件两种形态：录制得到的 `{status, body}`（服务方的原始响应），或手写的 `{output: <结构化输出对象>}`，
 *   回放时包成对应协议的响应。
 * - 结构化输出中的占位符按本次请求解析（只对整串是占位符的字符串）：
 *   `{{ref:<卡片 id>}}`、`{{ref:<卡片 id>@<实体>}}` 为提示中这张卡的引用（card:N）；
 *   `{{component:<正则>}}` 为 schema 组件枚举（没有 schema 时为提示）中第一个匹配的组件键，没有匹配时退回事件的根因（在枚举里时）；`{{enum:<值>}}` 为该值本身，只在它出现在 schema 的某个枚举里时。
 *   解析不出的占位符删除它所在的数组元素（数组外为 null），录制因此不依赖某张卡或某个工具一定存在。
 * - 请求为流式时按服务方的事件格式发出。
 * - 录制模式（--record --upstream <base_url>）：以非流式转发到上游，响应写入目录（`<名称>-<n>.json`）后按请求方式返回。
 * 只读目录（回放）；GET /healthz 返回录制数、已回放与缺失的键。
 */

export interface Recording {
  status?: number;
  body?: unknown;
  output?: unknown;
  provenance?: Record<string, string>;
}

export interface ReplayOptions {
  dir: string;
  record?: { upstream: string; apiKey: string | null } | null;
}

const PIECE = 24;

function pieces(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += PIECE) {
    out.push(text.slice(i, i + PIECE));
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 服务方的原始 JSON */
/**
 * 非流式响应体 → 服务方会发出的流式事件（SSE 的 data 部分，按顺序）：
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

/** 请求的结构化输出名称；没有结构化输出时为 text */
export function outputName(req: any): string {
  return (
    (typeof req?.text?.format?.name === 'string' && req.text.format.name) ||
    (typeof req?.response_format?.json_schema?.name === 'string' && req.response_format.json_schema.name) ||
    'text'
  );
}

/** 请求里的全部文本（提示、指令、工具结果），用于解析占位符 */
function requestText(req: any): string {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      parts.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k !== 'text' || typeof x === 'string') {
          walk(x);
        }
      }
    }
  };
  walk([req?.instructions, req?.input, req?.messages]);
  return parts.join('\n');
}

/** 请求 schema 中出现的全部枚举值 */
function schemaEnums(req: any): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'enum' && Array.isArray(x)) {
          x.filter((e): e is string => typeof e === 'string').forEach((e) => out.add(e));
        } else {
          walk(x);
        }
      }
    }
  };
  walk(req?.text?.format?.schema ?? req?.response_format?.json_schema?.schema);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const DROP = Symbol('drop');
const PLACEHOLDER = /^\{\{(ref|component|enum):(.+)\}\}$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 按请求解析结构化输出中的占位符；解析不出的删除所在的数组元素（数组外为 null） */
export function resolvePlaceholders(output: unknown, req: unknown): unknown {
  const text = requestText(req);
  const enums = schemaEnums(req);
  // schema 带有组件枚举时只从枚举里取（取枚举之外的值会让输出不合 schema）；没有 schema 时取提示中出现的组件
  const components = enums.size
    ? [...enums]
    : [...text.matchAll(/"(?:entity|component|root_component)":"([^"]+)"/g)].map((m) => m[1] as string);
  // 事件的根因（提示中事件段的 root.component）：组件占位符没有匹配时的退路，录制因此不依赖场景里事件的根因恰好是哪个组件
  const incidentRoot = /"root":\{"component":"([^"]+)"/.exec(text)?.[1] ?? null;
  const rootOk = incidentRoot !== null && (enums.size === 0 || enums.has(incidentRoot));
  const one = (s: string): unknown => {
    const m = PLACEHOLDER.exec(s);
    if (!m) {
      return s;
    }
    const [, kind, arg] = m as unknown as [string, string, string];
    if (kind === 'ref') {
      const [card, entity] = arg.split('@') as [string, string | undefined];
      const re = new RegExp(`"ref":"(card:\\d+)","card":"${esc(card)}"${entity ? `,"entity":"${esc(entity)}"` : ''}`);
      return re.exec(text)?.[1] ?? DROP;
    }
    if (kind === 'component') {
      const re = new RegExp(arg);
      return components.find((c) => re.test(c)) ?? (rootOk ? incidentRoot : DROP);
    }
    return enums.has(arg) ? arg : DROP;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return one(v);
    }
    if (Array.isArray(v)) {
      return v.map(walk).filter((x) => x !== DROP);
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = walk(x);
        if (r === DROP) {
          return DROP;
        }
        out[k] = r;
      }
      return out;
    }
    return v;
  };
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(output)) {
      const r = walk(x);
      out[k] = r === DROP ? null : r;
    }
    return out;
  }
  const r = walk(output);
  return r === DROP ? null : r;
}

/** 手写录制的结构化输出 → 对应协议的响应体 */
export function wrapOutput(path: string, model: string, output: unknown, n: number): unknown {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const created = 1_767_225_600 + n;
  if (path.endsWith('/responses')) {
    return {
      id: `resp_replay_${n}`,
      object: 'response',
      created_at: created,
      status: 'completed',
      model,
      output: [
        {
          id: `msg_replay_${n}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
    };
  }
  return {
    id: `chatcmpl-replay-${n}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
  };
}

/** 响应体中结构化输出的文本：Responses 的 output_text 或 Chat 的 message.content */
function replaceOutputText(body: unknown, fn: (text: string) => string): unknown {
  const b = structuredClone(body) as {
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  for (const item of b.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') {
        c.text = fn(c.text);
      }
    }
  }
  for (const ch of b.choices ?? []) {
    if (ch.message && typeof ch.message.content === 'string') {
      ch.message.content = fn(ch.message.content);
    }
  }
  return b;
}

export class LlmReplay {
  private server: Server | null = null;
  private readonly seen = new Map<string, number>();
  readonly served: string[] = [];
  readonly missing: string[] = [];

  constructor(private readonly o: ReplayOptions) {
    if (o.record) {
      mkdirSync(o.dir, { recursive: true });
    } else if (!existsSync(o.dir)) {
      throw new Error(`录制目录不存在：${o.dir}`);
    }
  }

  recordings(): string[] {
    return existsSync(this.o.dir)
      ? readdirSync(this.o.dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
      : [];
  }

  private load(name: string, n: number): { file: string; rec: Recording } | null {
    for (const file of [`${name}-${n}.json`, `${name}.json`]) {
      const p = join(this.o.dir, file);
      if (existsSync(p)) {
        return { file, rec: JSON.parse(readFileSync(p, 'utf8')) as Recording };
      }
    }
    return null;
  }

  /** 一次请求的响应（状态与响应体）；没有可用录制时为 503 */
  async respond(path: string, raw: string): Promise<{ status: number; body: unknown; key: string }> {
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: { message: '请求体不是 JSON' } }, key: '' };
    }
    const name = outputName(req);
    const n = (this.seen.get(name) ?? 0) + 1;
    this.seen.set(name, n);
    const key = `${name}-${n}`;
    if (this.o.record) {
      const rest = { ...req };
      delete rest.stream;
      delete rest.stream_options;
      const up = await fetch(`${this.o.record.upstream.replace(/\/+$/, '')}${path.replace(/^\/v1/, '')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.o.record.apiKey ? { authorization: `Bearer ${this.o.record.apiKey}` } : {}),
        },
        body: JSON.stringify(rest),
      });
      const text = await up.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { message: text.slice(0, 2000) } };
      }
      const rec: Recording = {
        provenance: { mode: 'recorded', path, recorded_at: new Date().toISOString() },
        status: up.status,
        body,
      };
      writeFileSync(join(this.o.dir, `${key}.json`), `${JSON.stringify(rec, null, 2)}\n`);
      this.served.push(key);
      return { status: up.status, body, key };
    }
    const hit = this.load(name, n);
    if (!hit) {
      this.missing.push(key);
      return {
        status: 503,
        body: { error: { message: `llm-replay 没有 ${key} 的录制（目录 ${this.o.dir}）`, type: 'replay_missing' } },
        key,
      };
    }
    this.served.push(`${key}:${hit.file}`);
    const resolve = (text: string) => {
      try {
        return JSON.stringify(resolvePlaceholders(JSON.parse(text), req));
      } catch {
        return text;
      }
    };
    if (hit.rec.output !== undefined) {
      const model = typeof req.model === 'string' ? req.model : 'replay';
      return { status: 200, body: wrapOutput(path, model, resolvePlaceholders(hit.rec.output, req), n), key };
    }
    const status = hit.rec.status ?? 200;
    return { status, body: status === 200 ? replaceOutputText(hit.rec.body, resolve) : hit.rec.body, key };
  }

  private async handle(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] as string;
    if (req.method === 'GET' && (path === '/healthz' || path === '/readyz')) {
      return json(res, 200, { recordings: this.recordings().length, served: this.served, missing: this.missing });
    }
    if (req.method !== 'POST' || !/\/(responses|chat\/completions)$/.test(path)) {
      return json(res, 404, { error: { message: `llm-replay 不提供 ${req.method} ${path}` } });
    }
    const r = await this.respond(path, raw);
    logger.info('llm-replay', { key: r.key, status: r.status });
    // respond() 已经确认请求体是 JSON（否则为 400）
    const stream = r.status === 200 && (JSON.parse(raw) as { stream?: unknown }).stream === true;
    if (!stream) {
      return json(res, r.status, r.body);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const e of toStreamEvents(path, r.body)) {
      res.write(`data: ${e}\n\n`);
    }
    res.end();
  }

  async listen(host: string, port: number): Promise<number> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.handle(req, res, Buffer.concat(chunks).toString('utf8')).catch((e: unknown) => {
          logger.error('llm-replay 处理请求失败', { error: e });
          json(res, 500, { error: { message: String(e) } });
        });
      });
    });
    await new Promise<void>((r) => this.server?.listen(port, host, r));
    const a = this.server.address();
    return typeof a === 'object' && a ? a.port : port;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** `srenautix llm-replay --dir <目录> [--listen :8080] [--record --upstream <base_url> [--api-key-file <文件>]]` */
export async function runLlmReplay(args: string[]): Promise<void> {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      listen: { type: 'string', default: ':8080' },
      record: { type: 'boolean', default: false },
      upstream: { type: 'string' },
      'api-key-file': { type: 'string' },
    },
  });
  if (!values.dir) {
    throw new Error('llm-replay 需要 --dir');
  }
  if (values.record && !values.upstream) {
    throw new Error('llm-replay --record 需要 --upstream');
  }
  const m = /^(.*):(\d+)$/.exec(values.listen);
  if (!m) {
    throw new Error('--listen 的格式是 [host]:port');
  }
  const replay = new LlmReplay({
    dir: values.dir,
    record: values.record
      ? {
          upstream: values.upstream as string,
          apiKey: values['api-key-file'] ? readFileSync(values['api-key-file'], 'utf8').trim() : null,
        }
      : null,
  });
  const port = await replay.listen(m[1] || '0.0.0.0', Number(m[2]));
  logger.info('llm-replay 已启动', {
    port,
    dir: values.dir,
    mode: values.record ? 'record' : 'replay',
    recordings: replay.recordings().length,
  });
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await replay.close();
}
