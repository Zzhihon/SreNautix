import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// 录制模型服务的真实响应，作为模型层测试的夹具（test/fixtures/llm/<provider>/）。
// 只在本地对自己启动的服务运行，例如 llama.cpp 的 llama-server：
//   pnpm tsx scripts/record-llm-fixtures.ts --base-url http://127.0.0.1:18431/v1 --model qwen3-1.7b --provider llamacpp-qwen3-1.7b
// 请求只含固定文本；不要对持有生产数据或生产密钥的服务运行。
// 这里直接用 fetch 保存原始 HTTP 响应体，不经过 SDK 的类型转换，夹具就是服务方实际返回的 JSON。

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'api-key-env': { type: 'string', default: '' },
  },
});
const base = values['base-url'];
const model = values.model;
const provider = values.provider;
if (!base || !model || !provider) {
  throw new Error('用法：--base-url <…/v1> --model <id> --provider <目录名> [--api-key-env <环境变量名>]');
}
const keyEnv = values['api-key-env'] as string;
const apiKey = keyEnv ? process.env[keyEnv] : undefined;
if (keyEnv && !apiKey) {
  throw new Error(`环境变量 ${keyEnv} 没有设置`);
}

const out = resolve(import.meta.dirname, '../test/fixtures/llm', provider);
mkdirSync(out, { recursive: true });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['component', 'verdict', 'refs'],
  properties: {
    component: { type: 'string', enum: ['Deployment:shop/api', 'StatefulSet:shop/postgres'] },
    verdict: { type: 'string', enum: ['abnormal', 'normal'] },
    refs: { type: 'array', items: { type: 'string', enum: ['card:1', 'card:2'] } },
  },
};
const TOOL = {
  name: 'metrics_query',
  description: 'Run an instant PromQL query.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
};
const PROMPT =
  'card:1 says the api Deployment error rate is 30% since 10:02. card:2 says postgres connections are at 100% since 10:00. Which component is the root cause? Answer in JSON.';

interface Case {
  name: string;
  path: '/responses' | '/chat/completions';
  body: Record<string, unknown>;
}

const cases: Case[] = [
  {
    name: 'responses-json-schema',
    path: '/responses',
    body: {
      model,
      input: PROMPT,
      max_output_tokens: 4096,
      store: false,
      text: { format: { type: 'json_schema', name: 'verdict', schema: SCHEMA, strict: true } },
    },
  },
  {
    name: 'responses-function-call',
    path: '/responses',
    body: {
      model,
      input: 'Check the current value of up{job="api"} with the tool.',
      max_output_tokens: 4096,
      store: false,
      tools: [{ type: 'function', ...TOOL, strict: false }],
      tool_choice: 'required',
    },
  },
  {
    name: 'responses-max-output',
    path: '/responses',
    body: { model, input: 'Explain how PostgreSQL WAL archiving works.', max_output_tokens: 32, store: false },
  },
  {
    name: 'chat-json-schema',
    path: '/chat/completions',
    body: {
      model,
      messages: [{ role: 'user', content: PROMPT }],
      max_completion_tokens: 4096,
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema: SCHEMA, strict: true } },
    },
  },
  {
    name: 'chat-json-object',
    path: '/chat/completions',
    body: {
      model,
      messages: [
        { role: 'system', content: `Output only JSON conforming to this schema: ${JSON.stringify(SCHEMA)}` },
        { role: 'user', content: PROMPT },
      ],
      max_completion_tokens: 4096,
      response_format: { type: 'json_object' },
    },
  },
  {
    name: 'chat-tool-call',
    path: '/chat/completions',
    body: {
      model,
      messages: [{ role: 'user', content: 'Check the current value of up{job="api"} with the tool.' }],
      max_completion_tokens: 4096,
      tools: [{ type: 'function', function: TOOL }],
      tool_choice: 'required',
    },
  },
  {
    name: 'chat-length',
    path: '/chat/completions',
    body: {
      model,
      messages: [{ role: 'user', content: 'Explain how PostgreSQL WAL archiving works.' }],
      max_completion_tokens: 32,
    },
  },
  {
    name: 'chat-chinese',
    path: '/chat/completions',
    body: {
      model,
      messages: [
        {
          role: 'user',
          content:
            '仓库里原有十七箱苹果，上午运走了五箱，下午又运进来八箱。请只回答现在仓库里有几箱苹果，用阿拉伯数字，不要写其他内容。',
        },
      ],
      max_completion_tokens: 2048,
      temperature: 0,
    },
  },
  {
    name: 'chat-bad-request',
    path: '/chat/completions',
    body: { model, messages: 'not-an-array' },
  },
];

for (const c of cases) {
  const res = await fetch(`${base.replace(/\/+$/, '')}${c.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(c.body),
  });
  const text = await res.text();
  const fixture = {
    provenance: { provider, model, base_url_kind: 'local', recorded_at: new Date().toISOString(), path: c.path },
    request: c.body,
    status: res.status,
    body: JSON.parse(text) as unknown,
  };
  writeFileSync(join(out, `${c.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`${c.name}: HTTP ${res.status}\n`);
}
