import type { ModelRoute } from '@srenautix/contract';
import { DEFAULT_BUDGET } from '../../src/llm/budget.js';
import { Egress } from '../../src/llm/egress.js';
import { buildRuntimes } from '../../src/llm/routes.js';
import { ModelLayer, type LlmCallRecord } from '../../src/llm/session.js';
import { DEFAULT_LIMITS, type ResearchEnv, type ResearchState, type RunSink } from '../../src/research/controller.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import type { ToolCallRecord, Tool } from '../../src/tools/box.js';
import { openMcp, type McpSession } from '../../src/tools/mcp.js';

export const LIVE_MODEL = 'qwen3-1.7b';

export function testRoute(baseUrl: string, over: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id: 'local',
    base_url: baseUrl,
    api: 'chat_completions',
    model: LIVE_MODEL,
    dialect_profile: 'llamacpp',
    price: { currency: 'CNY', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
    failure_domain: [],
    in_domain: true,
    tier: 'large',
    retention_terms: 'local process, no retention',
    ...over,
  };
}

export function testLayer(routes: ModelRoute[], callTimeoutMs = 90_000): ModelLayer {
  const egress = new Egress({ allowCrossBorder: false, honeytokens: ['srx-honey-7f3a9c1e5b2d4f60'] }, () => undefined);
  const runtimes = buildRuntimes(
    routes.map((r) => ({ route: r, apiKey: 'local', state: { profile: null, calibration: null, fingerprint: null } })),
    egress,
    callTimeoutMs,
  );
  // 本地小模型的上下文为 16k：评测用的路由按服务端实际配置设置
  for (const rt of runtimes) {
    rt.profile = { ...rt.profile, context_tokens: 16_384 };
  }
  return new ModelLayer({
    routes: runtimes,
    egress,
    budget: {
      ...DEFAULT_BUDGET,
      stages: {
        ...DEFAULT_BUDGET.stages,
        hypothesize: { inputTokens: 14_000, outputTokens: 2_000 },
        conclude: { inputTokens: 14_000, outputTokens: 2_000 },
        compress: { inputTokens: 14_000, outputTokens: 1_000 },
      },
    },
    metrics: new WorkerMetrics('worker', false),
    language: 'zh',
    callTimeoutMs,
    onCalibration: async () => undefined,
    onDrift: async () => undefined,
  });
}

export async function metricsTools(url: string): Promise<McpSession> {
  return openMcp(
    {
      id: 'metrics',
      url,
      bearerToken: null,
      tools: [
        {
          name: 'query_range',
          range: { from: 'start', to: 'end', format: 'unix' },
          step: 'step',
          live: false,
          result: 'prometheus',
        },
        { name: 'query', instant: { at: 'time', format: 'unix' }, live: false, result: 'prometheus' },
        { name: 'pod_get', live: true, result: 'json' },
      ],
    },
    new AbortController().signal,
  );
}

export function testEnv(layer: ModelLayer, tools: Tool[], replay: boolean): ResearchEnv {
  return {
    layer,
    metrics: layer.opts.metrics,
    language: 'zh',
    limits: { ...DEFAULT_LIMITS, deadlineMs: 20 * 60_000, concludeReserveMs: 60_000 },
    tools,
    query: null,
    replay,
    now: () => Date.now(),
  };
}

export class MemorySink implements RunSink {
  readonly steps: Array<{ state: ResearchState; startedAt: string; finishedAt: string | null }> = [];
  readonly llm: LlmCallRecord[] = [];
  readonly tools: ToolCallRecord[] = [];

  async step(state: ResearchState, startedAt: string, finishedAt: string | null): Promise<void> {
    this.steps.push({ state, startedAt, finishedAt });
  }

  async llmCall(r: LlmCallRecord): Promise<void> {
    this.llm.push(r);
  }

  async toolCall(r: ToolCallRecord): Promise<void> {
    this.tools.push(r);
  }
}
