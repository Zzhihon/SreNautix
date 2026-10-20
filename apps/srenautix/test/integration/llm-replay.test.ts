import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECLARED_PROFILES } from '../../src/llm/dialect.js';
import { LlmReplay } from '../../src/llm/replay.js';
import { streamTurn } from '../../src/llm/stream.js';
import type { DialectProfile } from '../../src/llm/dialect.js';

// 录制回放的模型服务（srenautix llm-replay）：经 worker 的流式客户端（OpenAI SDK）调用，
// 按结构化输出名称与次数取录制，占位符按请求解析，缺录制 503，录制模式写出文件

const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `llm-replay-${process.pid}`);
const DIR = join(ROOT, 'recordings');
const PROFILE = { ...DECLARED_PROFILES['openai-responses'] } as unknown as DialectProfile;
const TIMEOUTS = { firstTokenMs: 5000, idleMs: 5000, totalMs: null };

let replay: LlmReplay;
let client: OpenAI;

// 提示中的证据卡（与 research/prompt.ts 的 cardView 相同的 JSON 形态）
const PROMPT = [
  '## 证据卡',
  '```json',
  JSON.stringify([
    { ref: 'card:3', card: 'workload/release/init-waiting', entity: 'Deployment:shop/checkout', verdict: 'abnormal' },
    { ref: 'card:5', card: 'workload/release/init-waiting', entity: 'Deployment:shop/api', verdict: 'abnormal' },
  ]),
  '```',
].join('\n');

const schema = (name: string) => ({
  type: 'json_schema' as const,
  name,
  strict: true,
  schema: {
    type: 'object',
    properties: {
      root_component: { type: 'string', enum: ['Deployment:shop/api', 'Job:shop/shop-migrate-r2'] },
      template: { type: 'string', enum: ['kube_workload_pods', 'kube_events'] },
    },
  },
});

async function turn(name: string): Promise<Record<string, unknown>> {
  const t = await streamTurn(
    client,
    'responses',
    {
      model: 'gpt-5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
      text: { format: schema(name) },
      stream: true,
      store: false,
    },
    PROFILE,
    TIMEOUTS,
    10_000,
    new AbortController().signal,
    'primary',
  );
  return JSON.parse(t.turn.text ?? 'null') as Record<string, unknown>;
}

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, 'hypothesize_output-1.json'),
    JSON.stringify({
      output: {
        hypotheses: [
          {
            id: 'h1',
            root_component: '{{component:^Job:shop/shop-migrate-}}',
            supporting: [
              '{{ref:workload/release/init-waiting@Deployment:shop/api}}',
              '{{ref:workload/release/init-waiting}}',
              '{{ref:workload/release/no-such-card}}',
            ],
          },
          { id: 'h2', root_component: '{{component:^StatefulSet:}}', supporting: [] },
        ],
        next_checks: [
          { hypothesis_id: 'h1', template: '{{enum:kube_workload_pods}}' },
          { hypothesis_id: 'h1', template: '{{enum:kube_logs}}' },
        ],
        situation: '{{component:^Nope}}',
      },
    }),
  );
  writeFileSync(join(DIR, 'conclude_output.json'), JSON.stringify({ output: { disposition: 'act' } }));
  replay = new LlmReplay({ dir: DIR });
  const port = await replay.listen('127.0.0.1', 0);
  client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x', maxRetries: 0 });
});

afterAll(async () => {
  await replay?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('llm-replay', () => {
  it('按输出名称与次数取录制，经流式客户端得到解析后的输出', async () => {
    expect(await turn('hypothesize_output')).toEqual({
      hypotheses: [{ id: 'h1', root_component: 'Job:shop/shop-migrate-r2', supporting: ['card:5', 'card:3'] }],
      next_checks: [{ hypothesis_id: 'h1', template: 'kube_workload_pods' }],
      situation: null,
    });
  });

  it('第二次没有编号录制也没有通用录制：503；有通用录制时任意次都用它', async () => {
    await expect(turn('hypothesize_output')).rejects.toMatchObject({ status: 503 });
    expect(await turn('conclude_output')).toEqual({ disposition: 'act' });
    expect(await turn('conclude_output')).toEqual({ disposition: 'act' });
    expect(replay.missing).toEqual(['hypothesize_output-2']);
    expect(replay.served).toEqual([
      'hypothesize_output-1:hypothesize_output-1.json',
      'conclude_output-1:conclude_output.json',
      'conclude_output-2:conclude_output.json',
    ]);
  });

  it('录制模式：以非流式转发到上游，写出 <名称>-<n>.json，录下的文件可以直接回放', async () => {
    const rec = join(ROOT, 'recorded');
    const upstream = new LlmReplay({ dir: DIR });
    const upPort = await upstream.listen('127.0.0.1', 0);
    const recorder = new LlmReplay({ dir: rec, record: { upstream: `http://127.0.0.1:${upPort}/v1`, apiKey: null } });
    const port = await recorder.listen('127.0.0.1', 0);
    const prev = client;
    client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x', maxRetries: 0 });
    try {
      expect(await turn('conclude_output')).toEqual({ disposition: 'act' });
      const file = JSON.parse(readFileSync(join(rec, 'conclude_output-1.json'), 'utf8')) as {
        status: number;
        body: { output: Array<{ content: Array<{ text: string }> }> };
      };
      expect(file.status).toBe(200);
      expect(JSON.parse(file.body.output[0]!.content[0]!.text)).toEqual({ disposition: 'act' });
      const again = new LlmReplay({ dir: rec });
      expect(
        (await again.respond('/v1/responses', JSON.stringify({ text: { format: schema('conclude_output') } }))).status,
      ).toBe(200);
    } finally {
      client = prev;
      await recorder.close();
      await upstream.close();
    }
  });
});
