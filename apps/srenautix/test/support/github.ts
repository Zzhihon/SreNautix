import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jwtVerify } from 'jose';

/**
 * 测试用的 GitHub REST API（只实现 server 用到的接口），状态在内存中，行为按 GitHub 文档：
 * - POST /app/installations/{id}/access_tokens：Authorization 为 App 私钥签的 RS256 JWT（iss 为 App id，有效期不超过 10 分钟）；
 * - 其余接口要求安装令牌；
 * - GET /repos/{repo}/git/ref/heads/{branch}、GET/PUT /repos/{repo}/contents/{path}（PUT 更新已有文件时必须带当前 sha）、
 *   POST /repos/{repo}/git/refs（分支已存在时 422）、POST /repos/{repo}/pulls、GET/PATCH /repos/{repo}/pulls/{n}；
 * - issue：POST/GET /repos/{repo}/issues（列表按 labels、创建时间倒序，PR 也出现在列表中并带 pull_request）、
 *   POST/GET /repos/{repo}/issues/{n}/comments；
 * - 提交：GET /repos/{repo}/commits（sha、since、until、per_page、page）与 GET /repos/{repo}/commits/{sha}（带 files）。
 * fault() 注入失败：返回给定状态，或处理请求之后断开连接（客户端收不到响应）。
 */
export class FakeGitHub {
  url = '';
  private server: Server | null = null;
  private readonly tokens = new Set<string>();
  /** 分支 → 文件路径 → 内容 */
  readonly branches = new Map<string, Map<string, string>>();
  readonly heads = new Map<string, string>();
  readonly pulls: Array<{ number: number; head: string; base: string; title: string; body: string }> = [];
  readonly issues: Array<{ number: number; title: string; body: string; labels: string[]; created: number }> = [];
  readonly comments = new Map<number, Array<{ id: number; body: string }>>();
  /** 分支 → 提交（新的在前） */
  readonly commits = new Map<
    string,
    Array<{ sha: string; message: string; author: string; date: string; files: string[]; parents: number }>
  >();
  readonly requests: Array<{ method: string; path: string }> = [];
  private readonly faults: Array<{ method: string; path: RegExp; status: number | 'drop_after'; times: number }> = [];
  private seq = 0;

  /** 接下来 times 次匹配的请求失败：返回 status，或 'drop_after' 照常处理后断开连接 */
  fault(method: string, path: RegExp, status: number | 'drop_after', times = 1): void {
    this.faults.push({ method, path, status, times });
  }

  constructor(
    private readonly appId: string,
    private readonly installationId: string,
    private readonly appPublicKey: KeyObject,
    readonly repo: string,
  ) {
    this.branches.set('main', new Map());
    this.heads.set('main', sha('init'));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.handle(req, res, Buffer.concat(chunks).toString('utf8')).catch((e: unknown) =>
          send(res, 500, { message: String(e) }),
        );
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://github');
    const path = decodeURIComponent(u.pathname);
    const method = req.method ?? 'GET';
    this.requests.push({ method, path });
    const f = this.faults.find((x) => x.times > 0 && x.method === method && x.path.test(path));
    if (f) {
      f.times--;
      if (f.status !== 'drop_after') {
        return send(res, f.status, { message: `injected ${f.status}` });
      }
      // 照常处理，但把响应丢掉：客户端看到连接被重置
      const sink = { writeHead: () => sink, end: () => res.socket?.destroy() } as unknown as ServerResponse;
      return this.handle2(req, sink, u, path, method, raw);
    }
    return this.handle2(req, res, u, path, method, raw);
  }

  private async handle2(
    req: IncomingMessage,
    res: ServerResponse,
    u: URL,
    path: string,
    method: string,
    raw: string,
  ): Promise<void> {
    const auth = req.headers.authorization ?? '';
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (method === 'POST' && path === `/app/installations/${this.installationId}/access_tokens`) {
      const jwt = /^Bearer (.+)$/.exec(auth)?.[1];
      if (!jwt) {
        return send(res, 401, { message: 'A JSON web token could not be decoded' });
      }
      try {
        const { payload } = await jwtVerify(jwt, this.appPublicKey, { algorithms: ['RS256'], issuer: this.appId });
        if ((payload.exp ?? 0) - (payload.iat ?? 0) > 600) {
          return send(res, 401, { message: "'Expiration time' claim ('exp') is too far in the future" });
        }
      } catch (e) {
        return send(res, 401, { message: `A JSON web token could not be decoded: ${(e as Error).message}` });
      }
      const token = `ghs_${randomBytes(16).toString('hex')}`;
      this.tokens.add(token);
      return send(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (method === 'POST' && path.startsWith('/app/installations/')) {
      return send(res, 404, { message: 'Not Found' });
    }
    const token = /^token (.+)$/.exec(auth)?.[1];
    if (!token || !this.tokens.has(token)) {
      return send(res, 401, { message: 'Bad credentials' });
    }
    const prefix = `/repos/${this.repo}/`;
    if (!path.startsWith(prefix)) {
      return send(res, 404, { message: 'Not Found' });
    }
    const rest = path.slice(prefix.length);
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      const head = this.heads.get(m[1] as string);
      return head ? send(res, 200, { object: { sha: head } }) : send(res, 404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === 'git/refs') {
      const ref = String(body.ref).replace(/^refs\/heads\//, '');
      if (this.branches.has(ref)) {
        return send(res, 422, { message: 'Reference already exists' });
      }
      const from = [...this.heads].find(([, s]) => s === body.sha);
      if (!from) {
        return send(res, 422, { message: 'Object does not exist' });
      }
      this.branches.set(ref, new Map(this.branches.get(from[0])));
      this.heads.set(ref, String(body.sha));
      return send(res, 201, { ref: `refs/heads/${ref}`, object: { sha: body.sha } });
    }
    if ((m = /^contents\/(.+)$/.exec(rest))) {
      const file = m[1] as string;
      if (method === 'GET') {
        const files = this.branches.get(u.searchParams.get('ref') ?? 'main');
        const content = files?.get(file);
        return content === undefined
          ? send(res, 404, { message: 'Not Found' })
          : send(res, 200, { content: Buffer.from(content).toString('base64'), sha: sha(content), encoding: 'base64' });
      }
      if (method === 'PUT') {
        const files = this.branches.get(String(body.branch));
        if (!files) {
          return send(res, 404, { message: 'Branch not found' });
        }
        const cur = files.get(file);
        if (cur !== undefined && body.sha !== sha(cur)) {
          return send(res, 409, { message: `${file} does not match ${String(body.sha)}` });
        }
        if (cur === undefined && body.sha !== undefined) {
          return send(res, 422, { message: 'sha was supplied but the file does not exist' });
        }
        const content = Buffer.from(String(body.content), 'base64').toString('utf8');
        files.set(file, content);
        const commit = sha(`${String(body.branch)}\0${file}\0${content}\0${String(body.message)}`);
        this.heads.set(String(body.branch), commit);
        return send(res, cur === undefined ? 201 : 200, { content: { sha: sha(content) }, commit: { sha: commit } });
      }
    }
    if (method === 'POST' && rest === 'issues') {
      const number = ++this.seq;
      this.issues.push({
        number,
        title: String(body.title),
        body: String(body.body ?? ''),
        labels: (body.labels as string[] | undefined) ?? [],
        created: Date.now() + number,
      });
      return send(res, 201, { number, html_url: `https://github.example.test/${this.repo}/issues/${number}` });
    }
    if (method === 'GET' && rest === 'issues') {
      const label = u.searchParams.get('labels');
      const items = [
        ...this.issues
          .filter((i) => !label || i.labels.includes(label))
          .map((i) => ({
            number: i.number,
            html_url: `https://github.example.test/${this.repo}/issues/${i.number}`,
            body: i.body,
            created: i.created,
          })),
        ...this.pulls.map((p) => ({
          number: p.number,
          html_url: `https://github.example.test/${this.repo}/pull/${p.number}`,
          body: p.body,
          created: 0,
          pull_request: {},
        })),
      ].sort((a, b) => b.created - a.created);
      return send(res, 200, items.slice(0, Number(u.searchParams.get('per_page') ?? 30)));
    }
    if ((m = /^issues\/(\d+)\/comments$/.exec(rest))) {
      const n = Number(m[1]);
      if (!this.issues.some((i) => i.number === n) && !this.pulls.some((p) => p.number === n)) {
        return send(res, 404, { message: 'Not Found' });
      }
      const list = this.comments.get(n) ?? [];
      this.comments.set(n, list);
      if (method === 'POST') {
        const id = ++this.seq;
        list.push({ id, body: String(body.body) });
        return send(res, 201, {
          id,
          html_url: `https://github.example.test/${this.repo}/issues/${n}#issuecomment-${id}`,
        });
      }
      return send(
        res,
        200,
        list.map((c) => ({
          id: c.id,
          body: c.body,
          html_url: `https://github.example.test/${this.repo}/issues/${n}#issuecomment-${c.id}`,
        })),
      );
    }
    if ((m = /^pulls\/(\d+)$/.exec(rest))) {
      const pr = this.pulls.find((p) => p.number === Number(m![1]));
      if (!pr) {
        return send(res, 404, { message: 'Not Found' });
      }
      if (method === 'PATCH' && typeof body.body === 'string') {
        pr.body = body.body;
      }
      return send(res, 200, {
        number: pr.number,
        body: pr.body,
        html_url: `https://github.example.test/${this.repo}/pull/${pr.number}`,
      });
    }
    if (method === 'GET' && rest === 'commits') {
      const all = this.commits.get(u.searchParams.get('sha') ?? 'main');
      if (!all) {
        return send(res, 404, { message: 'No commit found for SHA' });
      }
      const since = u.searchParams.get('since');
      const until = u.searchParams.get('until');
      const inWindow = all.filter((c) => (!since || c.date >= since) && (!until || c.date <= until));
      const per = Number(u.searchParams.get('per_page') ?? 30);
      const page = Number(u.searchParams.get('page') ?? 1);
      const slice = inWindow.slice((page - 1) * per, page * per);
      return send(
        res,
        200,
        slice.map((c) => ({
          sha: c.sha,
          html_url: `https://github.example.test/${this.repo}/commit/${c.sha}`,
          commit: {
            message: c.message,
            author: { name: c.author, email: `${c.author}@example.test`, date: c.date },
            committer: { date: c.date },
          },
          parents: Array.from({ length: c.parents }, (_, i) => ({ sha: `p${i}` })),
        })),
      );
    }
    if (method === 'GET' && (m = /^commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = [...this.commits.values()].flat().find((x) => x.sha === m![1]);
      if (!c) {
        return send(res, 404, { message: 'No commit found for SHA' });
      }
      return send(res, 200, {
        sha: c.sha,
        html_url: `https://github.example.test/${this.repo}/commit/${c.sha}`,
        commit: {
          message: c.message,
          author: { name: c.author, email: `${c.author}@example.test`, date: c.date },
          committer: { date: c.date },
        },
        parents: Array.from({ length: c.parents }, (_, i) => ({ sha: `p${i}` })),
        files: c.files.map((f) => ({ filename: f, status: 'modified', patch: `@@ -1 +1 @@\n-old\n+new` })),
      });
    }
    if (method === 'POST' && rest === 'pulls') {
      if (!this.branches.has(String(body.head)) || !this.branches.has(String(body.base))) {
        return send(res, 422, { message: 'Validation Failed' });
      }
      const number = ++this.seq;
      this.pulls.push({
        number,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body),
      });
      return send(res, 201, { number, html_url: `https://github.example.test/${this.repo}/pull/${number}` });
    }
    return send(res, 404, { message: 'Not Found' });
  }

  /** 在分支上加一个提交（新的在前） */
  commit(
    branch: string,
    c: { message: string; author?: string; date: Date; files: string[]; parents?: number },
  ): string {
    const list = this.commits.get(branch) ?? [];
    this.commits.set(branch, list);
    const s = sha(`${branch}\0${c.message}\0${c.date.toISOString()}\0${list.length}`);
    list.unshift({
      sha: s,
      message: c.message,
      author: c.author ?? 'dev',
      date: c.date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      files: c.files,
      parents: c.parents ?? 1,
    });
    return s;
  }

  /** 把分支合并到 main（测试中模拟审阅者合并 PR） */
  merge(branch: string): void {
    this.branches.set('main', new Map(this.branches.get(branch)));
    this.heads.set('main', this.heads.get(branch) as string);
  }
}

function sha(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
