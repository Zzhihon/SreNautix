import { HubError, type HubClient } from '../research/hub.js';
import type { Tool } from './box.js';
import { ToolArgError } from './limits.js';

// server 提供的只读工具（ADR 0106）：Kubernetes 的 Pod 状态、事件、Pod 列表与日志尾部，由 server 用自己的只读凭证执行。
// 只能看到当前状态，回放时不可用（live）。server 拒绝的调用（参数、命名空间不在范围内、对象不存在）按参数错误记录。

export interface HubToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function hubTools(hub: HubClient, runId: string, specs: readonly HubToolSpec[]): Tool[] {
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
    source: 'hub',
    live: true,
    run: async (args, ctx) => {
      try {
        const r = await hub.runTool(runId, s.name, args, ctx.signal);
        return { text: r.text, truncated: r.truncated, bytes: r.bytes, window: null, limitApplied: null };
      } catch (e) {
        if (e instanceof HubError && e.status >= 400 && e.status < 500) {
          throw new ToolArgError(e.message);
        }
        throw e;
      }
    },
  }));
}
