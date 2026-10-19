import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { stripEnvLiterals } from '../llm/redact.js';
import type { Tool, ToolOutcome, ToolRunContext } from './box.js';
import {
  capLines,
  capPromResult,
  clampRange,
  LIMITS,
  parseDuration,
  parseTime,
  shape,
  ToolArgError,
} from './limits.js';

// 带类型的只读 MCP 配置档（DESIGN §10.4）：worker 作为 MCP 客户端连接只读的 MCP 服务器。
// 服务器的工具默认关闭，管理员逐个加入白名单，并为每个工具声明时间参数的位置；
// 没有时间参数、只能读取当前状态的工具标为 live，回放时不可用。返回结果按不可信文本处理并有大小上限。

export interface McpToolAllow {
  name: string;
  /** 区间查询的起止参数名 */
  range?: { from: string; to: string; format: 'unix' | 'rfc3339' };
  /** 瞬时查询的时刻参数名 */
  instant?: { at: string; format: 'unix' | 'rfc3339' };
  /** 步长参数名；不小于 15 秒 */
  step?: string;
  /** 日志行数参数名；不超过 50 行 */
  lines?: string;
  /** 只读当前状态（例如 Kubernetes 对象） */
  live: boolean;
  /** 结果是 Prometheus API 形状时按 20 序列 × 60 点裁剪 */
  result: 'prometheus' | 'json' | 'text' | 'lines';
}

export interface McpServerConfig {
  id: string;
  url: string;
  bearerToken: string | null;
  tools: McpToolAllow[];
}

/** 永远不允许经工具读取的 Kubernetes 资源（不变量 1：不读 Secret；worker 不读 ConfigMap） */
const FORBIDDEN_KINDS = new Set(['secret', 'secrets', 'configmap', 'configmaps']);

function fmt(ms: number, format: 'unix' | 'rfc3339'): string {
  return format === 'unix' ? String(Math.floor(ms / 1000)) : new Date(ms).toISOString();
}

/** 按白名单声明约束参数：时间范围、步长、行数；拒绝读取 Secret 与 ConfigMap */
export function prepareArgs(allow: McpToolAllow, input: Record<string, unknown>, bounds: ToolRunContext['bounds']) {
  const args: Record<string, unknown> = { ...input };
  const notes: string[] = [];
  let window: { from: number; to: number } | null = null;
  let limit: number | null = null;
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && FORBIDDEN_KINDS.has(v.toLowerCase())) {
      throw new ToolArgError('不允许读取 Secret 或 ConfigMap');
    }
  }
  if (allow.range) {
    const { from, to, format } = allow.range;
    if (args[from] === undefined || args[to] === undefined) {
      throw new ToolArgError(`${allow.name} 必须给出 ${from} 与 ${to}`);
    }
    const c = clampRange(parseTime(args[from], from), parseTime(args[to], to), bounds);
    window = c.window;
    notes.push(...c.notes);
    args[from] = fmt(c.window.from, format);
    args[to] = fmt(c.window.to, format);
  }
  if (allow.instant) {
    const { at, format } = allow.instant;
    const t = args[at] === undefined || args[at] === '' ? bounds.to : parseTime(args[at], at);
    const c = clampRange(t, t, bounds);
    window = c.window;
    notes.push(...c.notes);
    args[at] = fmt(c.window.to, format);
  }
  if (allow.step) {
    const raw = args[allow.step];
    const span = window ? (window.to - window.from) / 1000 : 0;
    const asked = raw === undefined || raw === '' ? Math.ceil(span / LIMITS.points) : parseDuration(raw, allow.step);
    const s = Math.max(LIMITS.minStepSeconds, asked, Math.ceil(span / LIMITS.points));
    if (raw !== undefined && s !== asked) {
      notes.push(`step 已改为 ${s}s（不小于 ${LIMITS.minStepSeconds}s，且不超过 ${LIMITS.points} 点）`);
    }
    args[allow.step] = `${s}s`;
  }
  if (allow.lines) {
    const asked = typeof args[allow.lines] === 'number' ? (args[allow.lines] as number) : LIMITS.logLines;
    limit = Math.max(1, Math.min(LIMITS.logLines, asked));
    if (limit !== asked) {
      notes.push(`${allow.lines} 已改为 ${limit}`);
    }
    args[allow.lines] = limit;
  }
  return { args, notes, window, limit };
}

/** MCP 返回的文本 → 给模型的结果 */
export function shapeResult(
  allow: McpToolAllow,
  text: string,
  notes: string[],
): { text: string; truncated: boolean; bytes: number } {
  if (allow.result === 'prometheus' || allow.result === 'json') {
    const parsed = JSON.parse(text) as unknown;
    const withoutEnv = stripEnvLiterals(parsed).value;
    if (allow.result === 'prometheus') {
      const capped = capPromResult(withoutEnv as { data?: { result?: unknown } });
      return shape(capped.result, [...notes, ...capped.notes]);
    }
    return shape(withoutEnv, notes);
  }
  const lines = allow.result === 'lines' ? capLines(text) : { text, notes: [] };
  return shape(lines.text, [...notes, ...lines.notes]);
}

export interface McpSession {
  tools: Tool[];
  /** 白名单中、服务器没有提供的工具 */
  missing: string[];
  close(): Promise<void>;
}

/** 连接一个只读 MCP 服务器（streamable HTTP），按白名单取工具；每次研判单独连接 */
export async function openMcp(cfg: McpServerConfig, signal: AbortSignal): Promise<McpSession> {
  const client = new Client({ name: 'srenautix-worker', version: '1' });
  const headers: Record<string, string> = cfg.bearerToken ? { authorization: `Bearer ${cfg.bearerToken}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } }), { signal });
  const listed = await client.listTools(undefined, { signal });
  const allowed = new Map(cfg.tools.map((t) => [t.name, t]));
  const present = new Set(listed.tools.map((t) => t.name));
  const tools: Tool[] = listed.tools
    .filter((t) => allowed.has(t.name))
    .map((t) => {
      const allow = allowed.get(t.name) as McpToolAllow;
      return {
        name: `${cfg.id}.${t.name}`,
        description: `${(t.description ?? t.name).slice(0, 600)}\n只读；结果最多 ${LIMITS.series} 个序列 × ${LIMITS.points} 点、${LIMITS.logLines} 行日志、16 KiB。`,
        parameters: t.inputSchema as Record<string, unknown>,
        source: `mcp:${cfg.id}`,
        live: allow.live,
        async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolOutcome> {
          const p = prepareArgs(allow, input, ctx.bounds);
          const res = await client.callTool({ name: t.name, arguments: p.args }, undefined, { signal: ctx.signal });
          const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n');
          if (res.isError) {
            throw new Error(`${t.name} 返回错误：${text.slice(0, 500)}`);
          }
          const shaped = shapeResult(allow, text, p.notes);
          return { ...shaped, window: p.window, limitApplied: p.limit };
        },
      };
    });
  return { tools, missing: cfg.tools.map((t) => t.name).filter((n) => !present.has(n)), close: () => client.close() };
}
