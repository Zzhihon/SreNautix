import type { WorkerMetrics } from '../research/metrics.js';
import { ToolArgError, type Window } from './limits.js';

// 一次研判可用的只读工具。工具由控制器执行（区分性检查 type=tool），模型从不直接调用。

export interface ToolOutcome {
  /** 结果文本（JSON），不超过 16 KiB；属于不可信数据 */
  text: string;
  truncated: boolean;
  /** 截断前的结果字节数 */
  bytes: number;
  window: Window | null;
  limitApplied: number | null;
}

export interface ToolRunContext {
  /** 允许查询的时间窗口：日常研判为事件窗口前后各 24 小时，回放为快照窗口 */
  bounds: Window;
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** builtin：内置；mcp:<server id>：经 MCP 桥接 */
  source: string;
  /** 只能看到当前状态、不能按时间窗查询的工具（例如 Kubernetes 实时读取）；回放时不可用 */
  live: boolean;
  run(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolOutcome>;
}

/** worker.tool_calls 的一行（契约 ToolCall） */
export interface ToolCallRecord {
  seq: number;
  at: string;
  tool: string;
  arguments: Record<string, unknown>;
  window: { from: string; to: string } | null;
  limit_applied: number | null;
  result_size: number;
  truncated: boolean;
  duration_ms: number;
  error: string | null;
  result_ref: string | null;
}

export class ToolRejected extends Error {
  override name = 'ToolRejected';
}

export interface ToolResult {
  record: ToolCallRecord;
  /** 成功时的结果文本；失败时为 null */
  text: string | null;
}

/** 一次研判独占的工具箱：只暴露名单内的工具，按次数预算计数，每次调用都留下记录 */
export class ToolBox {
  private seq = 0;
  private readonly byName: Map<string, Tool>;

  constructor(
    tools: readonly Tool[],
    private readonly metrics: WorkerMetrics,
    private readonly budget: number,
  ) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
    if (this.byName.size !== tools.length) {
      throw new Error(`工具名重复：${tools.map((t) => t.name).join('、')}`);
    }
  }

  get tools(): Tool[] {
    return [...this.byName.values()];
  }

  get remaining(): number {
    return this.budget - this.seq;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async invoke(name: string, rawArgs: string, ctx: ToolRunContext): Promise<ToolResult> {
    const seq = ++this.seq;
    const started = Date.now();
    let args: Record<string, unknown> = {};
    let error: string | null = null;
    let outcome: ToolOutcome | null = null;
    let label: string;
    try {
      if (seq > this.budget) {
        throw new ToolRejected(`工具调用次数已达上限 ${this.budget}`);
      }
      const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ToolRejected('参数必须是 JSON 对象');
      }
      args = parsed as Record<string, unknown>;
      const tool = this.byName.get(name);
      if (!tool) {
        throw new ToolRejected(`工具 ${name} 不在可用名单中`);
      }
      outcome = await tool.run(args, ctx);
      label = outcome.truncated ? 'truncated' : 'ok';
    } catch (e) {
      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }
      if (!(e instanceof Error)) {
        throw e;
      }
      label = e instanceof ToolRejected || e instanceof ToolArgError || e instanceof SyntaxError ? 'rejected' : 'error';
      error = e.message.slice(0, 1000);
    }
    this.metrics.checks.inc({ type: 'tool', outcome: label });
    return {
      text: outcome?.text ?? null,
      record: {
        seq,
        at: new Date(started).toISOString(),
        tool: name,
        arguments: args,
        window: outcome?.window
          ? { from: new Date(outcome.window.from).toISOString(), to: new Date(outcome.window.to).toISOString() }
          : null,
        limit_applied: outcome?.limitApplied ?? null,
        result_size: outcome?.bytes ?? 0,
        truncated: outcome?.truncated ?? false,
        duration_ms: Date.now() - started,
        error,
        result_ref: null,
      },
    };
  }
}
