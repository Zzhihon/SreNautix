// model/v1 一致性测试与方言探测（DESIGN §8.2、§8.3、§10.3）：对一条 OpenAI 兼容路由（chat_completions 或 responses）
// 发出最小的真实请求，检查协议形状与 usage，并测量方言档案：严格 json_schema、原生工具调用、推理通道、上下文长度、中文。
// 只检查协议与约束是否被遵守，不评价模型的回答质量。

import { validatorFor, type DialectProfile } from '@srenautix/contract';
import OpenAI from 'openai';
import { Checks, expectEq, type ConformanceReport } from './report.js';

export interface ModelRouteUnderTest {
  name: string;
  base_url: string;
  api: 'chat_completions' | 'responses';
  model: string;
  api_key: string;
  /** 路由声明的上下文长度；探测在其上下各发一次请求 */
  declared_context_tokens: number;
}

/** 可移植 schema 子集（DESIGN §8.2）：扁平、全部必填、additionalProperties:false、枚举、不用 oneOf */
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['disposition', 'confidence', 'summary'],
  properties: {
    disposition: { type: 'string', enum: ['act', 'ignore', 'escalate', 'undetermined'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
  },
} as const;

interface Usage {
  input: number;
  output: number;
}

interface Turn {
  text: string;
  usage: Usage;
  tool: { name: string; args: string } | null;
  reasoning: boolean;
}

class Route {
  private readonly client: OpenAI;
  constructor(readonly r: ModelRouteUnderTest) {
    this.client = new OpenAI({ baseURL: r.base_url, apiKey: r.api_key, maxRetries: 0, timeout: 120_000 });
  }

  async call(prompt: string, opts: { schema?: boolean; tool?: boolean; maxTokens?: number } = {}): Promise<Turn> {
    const tools = [
      {
        name: 'get_pod_restarts',
        description: 'Return the restart count of a pod',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['namespace', 'pod'],
          properties: { namespace: { type: 'string' }, pod: { type: 'string' } },
        },
      },
    ];
    if (this.r.api === 'chat_completions') {
      const res = await this.client.chat.completions.create({
        model: this.r.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        seed: 7,
        max_tokens: opts.maxTokens ?? 128,
        ...(opts.schema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA },
              },
            }
          : {}),
        ...(opts.tool
          ? {
              tools: tools.map((t) => ({ type: 'function' as const, function: { ...t, strict: true } })),
              tool_choice: 'required' as const,
            }
          : {}),
      });
      const m = res.choices[0]!.message as {
        content: string | null;
        tool_calls?: Array<{ function: { name: string; arguments: string } }>;
        reasoning_content?: string;
      };
      const call = m.tool_calls?.[0];
      return {
        text: m.content ?? '',
        usage: { input: res.usage?.prompt_tokens ?? -1, output: res.usage?.completion_tokens ?? -1 },
        tool: call ? { name: call.function.name, args: call.function.arguments } : null,
        reasoning: typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0,
      };
    }
    const res = await this.client.responses.create({
      model: this.r.model,
      input: prompt,
      temperature: 0,
      max_output_tokens: Math.max(16, opts.maxTokens ?? 128),
      ...(opts.schema
        ? { text: { format: { type: 'json_schema', name: 'verdict', strict: true, schema: VERDICT_SCHEMA } } }
        : {}),
      ...(opts.tool
        ? {
            tools: tools.map((t) => ({ type: 'function' as const, ...t, strict: true })),
            tool_choice: 'required' as const,
          }
        : {}),
    });
    const call = res.output.find((o) => o.type === 'function_call') as { name: string; arguments: string } | undefined;
    return {
      text: res.output_text ?? '',
      usage: { input: res.usage?.input_tokens ?? -1, output: res.usage?.output_tokens ?? -1 },
      tool: call ? { name: call.name, args: call.arguments } : null,
      reasoning: res.output.some((o) => o.type === 'reasoning'),
    };
  }
}

export interface ModelConformanceResult {
  report: ConformanceReport;
  profile: DialectProfile;
}

export async function runModelConformance(r: ModelRouteUnderTest, now = new Date()): Promise<ModelConformanceResult> {
  const c = new Checks('model/v1', r.name);
  const route = new Route(r);
  const measured = {
    strict_json_schema: false,
    native_tools: false,
    reasoning_channel: 'none' as DialectProfile['reasoning_channel'],
    chinese: 'poor' as DialectProfile['chinese'],
    context_tokens: 1024,
  };

  await c.run('basic', '基本调用返回文本与服务方 usage', async () => {
    const t = await route.call('Reply with the single word: ready');
    if (!t.text.trim()) {
      throw new Error('没有返回文本');
    }
    if (t.usage.input <= 0 || t.usage.output <= 0) {
      throw new Error(`usage 缺失：${JSON.stringify(t.usage)}（预算按服务方返回的 usage 计量）`);
    }
    measured.reasoning_channel = t.reasoning ? 'separate_field' : /<think>/.test(t.text) ? 'inline_tags' : 'none';
    return `输入 ${t.usage.input}、输出 ${t.usage.output} token`;
  });
  // 严格 json_schema 与原生工具调用是测量项：服务方不支持时记为 false（研判改走修复阶梯），协议层报错才算失败
  await c.run('json-schema', '严格 json_schema：支持时输出必须解析并符合可移植子集 schema', async () => {
    const t = await route.call(
      'A pod restarted 12 times in 10 minutes with OOMKilled. Give a disposition with a one-sentence summary.',
      {
        schema: true,
        maxTokens: 512,
      },
    );
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(t.text) as Record<string, unknown>;
    } catch {
      return `不支持：输出不是 JSON（${t.text.slice(0, 60)}）`;
    }
    expectEq('字段', Object.keys(v).sort(), ['confidence', 'disposition', 'summary']);
    if (!VERDICT_SCHEMA.properties.disposition.enum.includes(v['disposition'] as never)) {
      throw new Error(`输出了 JSON 但 disposition 不在枚举中：${String(v['disposition'])}`);
    }
    measured.strict_json_schema = true;
    return `支持：disposition=${String(v['disposition'])}`;
  });
  await c.run('tools', '原生工具调用：支持时 tool_choice=required 返回符合参数 schema 的调用', async () => {
    const t = await route.call('How many times did pod web-0 in namespace shop restart? Use the tool.', {
      tool: true,
      maxTokens: 256,
    });
    if (!t.tool) {
      return `不支持：没有返回工具调用（${t.text.slice(0, 60)}）`;
    }
    expectEq('工具名', t.tool.name, 'get_pod_restarts');
    const args = JSON.parse(t.tool.args) as Record<string, unknown>;
    expectEq('参数字段', Object.keys(args).sort(), ['namespace', 'pod']);
    measured.native_tools = true;
    return `支持：${t.tool.args}`;
  });
  await c.run('chinese', '中文输入与输出', async () => {
    const t = await route.call('用一句中文说明：Pod 处于 CrashLoopBackOff 是什么意思？');
    const cjk = (t.text.match(/[一-鿿]/g) ?? []).length;
    measured.chinese = cjk >= 8 ? 'native' : cjk > 0 ? 'adequate' : 'poor';
    if (!cjk) {
      throw new Error('回答中没有中文');
    }
    return `${cjk} 个汉字`;
  });
  await c.run('context', '上下文长度：声明长度以内成功，超出时服务方明确拒绝', async () => {
    // 每个 "word " 至少 1 个 token；按声明长度的 60% 与 150% 各构造一次输入
    const within = 'word '.repeat(Math.floor(r.declared_context_tokens * 0.6));
    const over = 'word '.repeat(Math.ceil(r.declared_context_tokens * 1.5));
    const ok = await route.call(`${within}\nHow many lines above? Answer briefly.`, { maxTokens: 8 });
    if (ok.usage.input < r.declared_context_tokens * 0.5) {
      throw new Error(`输入 token 计数 ${ok.usage.input} 与构造的长度不符`);
    }
    let rejected = false;
    try {
      await route.call(`${over}\nAnswer briefly.`, { maxTokens: 8 });
    } catch (err) {
      if (!(err instanceof OpenAI.APIError) || (err.status !== 400 && err.status !== 413)) {
        throw err;
      }
      rejected = true;
    }
    if (!rejected) {
      throw new Error('超出声明长度的输入没有被拒绝，声明的上下文长度偏小');
    }
    measured.context_tokens = r.declared_context_tokens;
    return `${r.declared_context_tokens} token`;
  });

  const profile: DialectProfile = {
    id: r.name,
    ...measured,
    tokenizer: 'byte_estimate',
    measured_at: now.toISOString(),
    provider_fingerprint: null,
  };
  const valid = validatorFor('integrations/model/v1/dialect-profile.schema.json#/$defs/DialectProfile');
  await c.run('profile', '测得的方言档案符合契约', () => {
    if (!valid(profile)) {
      throw new Error(JSON.stringify(valid.errors));
    }
    return JSON.stringify(measured);
  });
  return { report: c.report(), profile };
}
