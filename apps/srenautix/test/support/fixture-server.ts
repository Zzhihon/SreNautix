import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * 回放录制夹具的 HTTP 服务：按方法与路径匹配，依次返回登记的响应，并记录收到的每个请求。
 * 被测客户端经可配置的 api_base 指向它，走真实的 HTTP 往返。没有登记的请求返回 599，测试据此失败。
 */
export interface FixtureResponse {
  status: number;
  body: unknown;
  /** 返回前等待的毫秒数。 */
  delayMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface Route {
  method: string;
  path: string | RegExp;
  queue: FixtureResponse[];
  /** 队列用完后重复最后一个响应。 */
  repeat: boolean;
  last: FixtureResponse | null;
}

const FIXTURES = resolve(import.meta.dirname, '../fixtures');

/** 有集成清单的渠道（integrations/<渠道>/）的录制夹具与签名向量只保存一份，在清单目录中。 */
const INTEGRATION_FIXTURES = new Set(['telegram', 'feishu']);

/** 夹具目录：渠道为 integrations/<dir>/fixtures，其余为 test/fixtures/<dir>。 */
export function fixtureDir(dir: string): string {
  return INTEGRATION_FIXTURES.has(dir)
    ? resolve(import.meta.dirname, '../../../../integrations', dir, 'fixtures')
    : join(FIXTURES, dir);
}

/** 读取 <夹具目录>/<name>.json 中的录制响应（字段 response）。 */
export function fixture(dir: string, name: string): FixtureResponse {
  const f = JSON.parse(readFileSync(join(fixtureDir(dir), `${name}.json`), 'utf8')) as { response: FixtureResponse };
  return f.response;
}

/** 读取整个夹具文件。 */
export function fixtureFile<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(fixtureDir(dir), name), 'utf8')) as T;
}

export class FixtureServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Route[] = [];
  private server: Server | null = null;
  url = '';

  on(method: string, path: string | RegExp, responses: FixtureResponse[], repeat = true): this {
    this.routes.push({ method, path, queue: [...responses], repeat, last: null });
    return this;
  }

  /** 清掉某个路径的全部登记，之后用 on 重新登记。 */
  reset(method: string, path: string | RegExp): this {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i] as Route;
      if (r.method === method && String(r.path) === String(path)) {
        this.routes.splice(i, 1);
      }
    }
    return this;
  }

  calls(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)),
    );
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://fixture');
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        if (raw && (req.headers['content-type'] ?? '').includes('json')) {
          body = JSON.parse(raw);
        }
        this.requests.push({ method: req.method ?? '', path: u.pathname, query: u.search, headers: req.headers, body });
        const route = this.routes.find(
          (r) =>
            r.method === req.method &&
            (typeof r.path === 'string' ? r.path === u.pathname : r.path.test(u.pathname)) &&
            (r.queue.length || (r.repeat && r.last)),
        );
        if (!route) {
          res
            .writeHead(599, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: `没有登记 ${req.method} ${u.pathname}` }));
          return;
        }
        const next = route.queue.shift() ?? (route.last as FixtureResponse);
        route.last = next;
        const send = () =>
          res.writeHead(next.status, { 'content-type': 'application/json' }).end(JSON.stringify(next.body));
        if (next.delayMs) {
          setTimeout(send, next.delayMs);
        } else {
          send();
        }
      });
    });
    await new Promise<void>((r) => (this.server as Server).listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${((this.server as Server).address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
