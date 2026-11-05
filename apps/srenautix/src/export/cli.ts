import { parseArgs } from 'node:util';
import { readSecretFile } from '../config/files.js';

// srenautix incidents export（ADR 0186）：调中心的 GET /v1/incidents/export，结果原样写到标准输出。鉴权用中心登记的
// 外部调用方 token 或控制台创建的 API token（与 mcp 角色的 hub_token_file 相同的 bearer token），从文件读取。

const EXPORT_TIMEOUT_MS = 180_000;
const RELATIVE = /^(\d+)(m|h|d)$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3600_000, d: 86_400_000 };

/** 时间参数：RFC 3339 时间，或 30m、12h、3d 这样相对于现在的时长 */
export function exportTime(what: string, raw: string, now: number): string {
  const m = RELATIVE.exec(raw);
  if (m) {
    return new Date(now - Number(m[1]) * (UNIT_MS[m[2] as string] as number)).toISOString();
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    throw new Error(`${what} 必须是 RFC 3339 时间或 30m、12h、3d 这样的时长：${raw}`);
  }
  return new Date(t).toISOString();
}

const OPTIONS = {
  'hub-url': { type: 'string' },
  'token-file': { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'cluster-id': { type: 'string' },
  severity: { type: 'string' },
  component: { type: 'string' },
  category: { type: 'string', multiple: true },
  'exclude-category': { type: 'string', multiple: true },
  'exclude-component': { type: 'string', multiple: true },
  suppressed: { type: 'boolean' },
  format: { type: 'string', default: 'json' },
  group: { type: 'string' },
  'group-gap': { type: 'string' },
  'group-before': { type: 'string' },
  'group-after': { type: 'string' },
  'group-min-incidents': { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
} as const;

/** 命令行参数 → 中心的地址、token 文件与查询串；参数的取值由中心校验 */
export function exportRequest(
  args: string[],
  env: NodeJS.ProcessEnv,
  now: number,
): { hubUrl: string; tokenFile: string; path: string } {
  const { values } = parseArgs({ args, options: OPTIONS, strict: true });
  const hubUrl = values['hub-url'] ?? env.SRENAUTIX_HUB_URL;
  const tokenFile = values['token-file'] ?? env.SRENAUTIX_TOKEN_FILE;
  if (!hubUrl) {
    throw new Error('incidents export 需要 --hub-url 或环境变量 SRENAUTIX_HUB_URL');
  }
  if (!tokenFile) {
    throw new Error('incidents export 需要 --token-file 或环境变量 SRENAUTIX_TOKEN_FILE');
  }
  if (!values.from) {
    throw new Error('incidents export 需要 --from');
  }
  const q = new URLSearchParams();
  q.append('from', exportTime('--from', values.from, now));
  q.append('to', values.to === undefined ? new Date(now).toISOString() : exportTime('--to', values.to, now));
  const single: Array<[keyof typeof OPTIONS, string]> = [
    ['cluster-id', 'cluster_id'],
    ['severity', 'severity'],
    ['component', 'component'],
    ['format', 'format'],
    ['group', 'group'],
    ['group-gap', 'group_gap'],
    ['group-before', 'group_before'],
    ['group-after', 'group_after'],
    ['group-min-incidents', 'group_min_incidents'],
    ['limit', 'limit'],
    ['cursor', 'cursor'],
  ];
  for (const [opt, param] of single) {
    const v = values[opt];
    if (typeof v === 'string') {
      q.append(param, v);
    }
  }
  const multiple: Array<[keyof typeof OPTIONS, string]> = [
    ['category', 'category'],
    ['exclude-category', 'exclude_category'],
    ['exclude-component', 'exclude_component'],
  ];
  for (const [opt, param] of multiple) {
    const v = values[opt];
    for (const x of Array.isArray(v) ? v : []) {
      q.append(param, x);
    }
  }
  if (values.suppressed) {
    q.append('suppressed', 'true');
  }
  return { hubUrl: hubUrl.replace(/\/+$/, ''), tokenFile, path: `/v1/incidents/export?${q.toString()}` };
}

/** 执行导出：响应体逐块写到 out；中心返回错误时以中心的说明报错 */
export async function runIncidentsExport(
  args: string[],
  out: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const r = exportRequest(args, env, Date.now());
  const token = readSecretFile('--token-file', r.tokenFile);
  const res = await fetch(`${r.hubUrl}${r.path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    const message = text.startsWith('{') ? ((JSON.parse(text) as { message?: string }).message ?? text) : text;
    throw new Error(`中心返回 HTTP ${res.status}：${message.slice(0, 500)}`);
  }
  if (!res.body) {
    throw new Error('中心的响应没有内容');
  }
  for await (const chunk of res.body) {
    out.write(chunk);
  }
}
