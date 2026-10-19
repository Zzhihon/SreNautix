import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../api/errors.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** uPlot 与 Radix 使用内联 style 属性，style-src 需要 'unsafe-inline'；其余只允许同源。 */
export const CONSOLE_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** 不属于控制台前端的路径：接口与探针，没有匹配的路由时返回 JSON 404。 */
const API_PREFIXES = ['/v1/', '/healthz', '/readyz', '/metrics'];

/**
 * 控制台前端的静态文件（DESIGN §1.1：控制台由 server 进程提供）：
 * - `/assets/*` 是带内容哈希的构建产物，长期缓存；
 * - 根目录下的其他文件（favicon 等）每次校验；
 * - 其余 GET 返回 index.html（前端路由），不缓存，带 CSP。
 */
export function registerConsoleStatic(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(`控制台目录 ${root} 中没有 index.html（console.dir；只提供接口时用 --serve=api）`);
  }
  const index = readFileSync(indexPath);

  /** dir 内的普通文件；路径越出 dir 或不存在时为 null。 */
  const fileIn = (urlPath: string): string | null => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    const p = resolve(root, `.${decoded}`);
    if (!p.startsWith(root + sep) || !existsSync(p) || !statSync(p).isFile()) {
      return null;
    }
    return p;
  };

  app.get('/*', async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '/').replace(/\/{2,}/g, '/');
    if (API_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) {
      throw notFound(`没有接口 GET ${path}`);
    }
    reply.header('x-content-type-options', 'nosniff');
    const file = path === '/' ? null : fileIn(path);
    if (file) {
      const immutable = path.startsWith('/assets/');
      return reply
        .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .type(TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
        .send(await readFile(file));
    }
    if (path.startsWith('/assets/')) {
      throw notFound(`没有静态文件 ${path}`);
    }
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', CONSOLE_CSP)
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'same-origin')
      .type('text/html; charset=utf-8')
      .send(index);
  });
}
