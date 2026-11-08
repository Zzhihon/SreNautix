// server 经 forward() 转发到 worker 的路由必须在 OpenAPI 契约里声明，且 worker 必须真的注册对应 handler。
// 历史上这些转发只加了 server 侧，worker 没有实现，线上直接 404。这里从源码提取，而不是硬编码清单：
// 以后新增 forward 会自动进入断言，漏写 worker handler 就会让本测试失败。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const APP = resolve(import.meta.dirname, '../..');
const REPO = resolve(APP, '../..');
const ROUTES_SYSTEM = readFileSync(resolve(APP, 'src/console-bff/routes-system.ts'), 'utf8');
const WORKER = readFileSync(resolve(APP, 'src/roles/worker.ts'), 'utf8');
const OPENAPI = parseYaml(readFileSync(resolve(REPO, 'contract/openapi.yaml'), 'utf8')) as {
  paths?: Record<string, Record<string, unknown>>;
};

interface Forward {
  method: 'GET' | 'POST';
  route: string;
}

/** 从 routes-system.ts 源码里提取 forward('GET'|'POST', '<path>', ...)，不执行路由注册。 */
function forwards(): Forward[] {
  const re = /forward\(\s*'(GET|POST)'\s*,\s*'([^']+)'/g;
  const found: Forward[] = [];
  for (const m of ROUTES_SYSTEM.matchAll(re)) {
    found.push({ method: m[1] as Forward['method'], route: m[2]! });
  }
  return found;
}

/**
 * 路径规范化：worker 与 OpenAPI 的参数写法可能不同。
 * `:report_id`、`:id` 与 `{report_id}` 都统一成 `:param`，其余段原样保留。
 */
function normalize(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return ':param';
      if (seg.startsWith('{') && seg.endsWith('}')) return ':param';
      return seg;
    })
    .join('/');
}

/** worker 源码里的 app.get/post/route 注册；覆盖位置参数与 app.route({ method, url }) 两种写法。 */
function workerRoutes(): Set<string> {
  const out = new Set<string>();
  const positional = /app\.(get|post)\(\s*'([^']+)'/g;
  for (const m of WORKER.matchAll(positional)) {
    out.add(`${m[1]!.toUpperCase()} ${normalize(m[2]!)}`);
  }
  // 对每个 app.route(...) 截取一段窗口，在其中分别找 method 与 url 字符串（顺序无关，容忍 handler 里的括号）。
  const routeCall = /app\.route\(\s*\{/g;
  for (const m of WORKER.matchAll(routeCall)) {
    const window = WORKER.slice(m.index!, m.index! + 600);
    const method = /\bmethod:\s*'([A-Z]+)'/.exec(window)?.[1];
    const url = /\burl:\s*'([^']+)'/.exec(window)?.[1];
    if (method && url) out.add(`${method.toUpperCase()} ${normalize(url)}`);
  }
  return out;
}

describe('server 转发路由的覆盖（ADR：server 只转发、worker 实现）', () => {
  const list = forwards();
  const contractPaths = OPENAPI.paths ?? {};

  it('从 routes-system.ts 至少能提取到 forward 路由（防止正则失效导致空跑）', () => {
    expect(list.length).toBeGreaterThan(0);
  });

  it('每条 forward 路由都在 contract/openapi.yaml 里声明了对应方法', () => {
    const missing = list.filter((f) => {
      const entry = Object.entries(contractPaths).find(([p]) => normalize(p) === normalize(f.route))?.[1];
      return !entry || typeof entry[f.method.toLowerCase()] !== 'object';
    });
    expect(missing).toEqual([]);
  });

  it('每条 forward 路由在 worker.ts 里都有对应方法 + 规范化路径的 handler', () => {
    const registered = workerRoutes();
    const missing = list.filter((f) => !registered.has(`${f.method} ${normalize(f.route)}`));
    expect(missing).toEqual([]);
  });

  // 当前 server 侧的转发清单，作为回归基线：新增或删除 forward 时这里会提醒同步检查 worker。
  it('当前基线是 9 条 eval / agent / egress / models 转发', () => {
    expect(list).toEqual([
      { method: 'GET', route: '/v1/eval/reports' },
      { method: 'GET', route: '/v1/eval/reports/:report_id' },
      { method: 'GET', route: '/v1/eval/cases' },
      { method: 'GET', route: '/v1/eval/trend' },
      { method: 'POST', route: '/v1/eval/estimate' },
      { method: 'GET', route: '/v1/agent/health' },
      { method: 'GET', route: '/v1/agent/cost' },
      { method: 'GET', route: '/v1/egress/ledger' },
      { method: 'GET', route: '/v1/models/routes' },
    ]);
  });
});
