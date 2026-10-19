import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runModelConformance } from '../src/conformance/model.js';
import { startLlamaServer, type LlamaServer } from '../src/testing/llama.js';

let llama: LlamaServer;
beforeAll(async () => {
  llama = await startLlamaServer(4096);
});
afterAll(async () => {
  await llama.stop();
});

// llama-server b11742 的 /v1/responses 不执行 text.format 的 json_schema 约束，测得 strict_json_schema=false；
// /v1/chat/completions 用语法约束解码，两项都支持
const EXPECTED = {
  chat_completions: { strict_json_schema: true, native_tools: true },
  responses: { strict_json_schema: false, native_tools: true },
};

describe('一致性测试：model/v1（llama.cpp 上的 Qwen2.5-0.5B）', () => {
  for (const api of ['chat_completions', 'responses'] as const) {
    it(`${api} 方言`, async () => {
      const { report, profile } = await runModelConformance({
        name: `qwen-llama-${api}`,
        base_url: `${llama.url}/v1`,
        api,
        model: llama.model,
        api_key: 'not-used-by-llama-server',
        declared_context_tokens: llama.context,
      });
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(profile).toMatchObject({ ...EXPECTED[api], context_tokens: 4096, chinese: 'native' });
    });
  }
});
