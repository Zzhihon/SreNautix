// 测试用的真实 OpenAI 兼容服务：llama.cpp 的 llama-server 加载 Qwen2.5-0.5B-Instruct（GGUF），
// 提供 /v1/chat/completions 与 /v1/responses。版本与 sha256 固定在 backends.json。

import { ensureBackend } from './backends.js';
import { startProcess, withFreePorts, type RunningProcess } from './process.js';

export interface LlamaServer extends RunningProcess {
  model: string;
  /** 加载时的上下文长度 */
  context: number;
}

export async function startLlamaServer(context = 4096): Promise<LlamaServer> {
  const [{ 'llama-server': bin }, { model }] = await Promise.all([
    ensureBackend('llama-server'),
    ensureBackend('qwen2.5-0.5b-instruct-gguf'),
  ]);
  const proc = await withFreePorts(1, ([port]) =>
    startProcess({
      name: 'llama-server',
      bin: bin!,
      args: [
        '--model',
        model!,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--ctx-size',
        String(context),
        '--parallel',
        '1',
        '--threads',
        '2',
        '--jinja',
        '--alias',
        'qwen2.5-0.5b-instruct',
        '--seed',
        '7',
      ],
      url: `http://127.0.0.1:${port}`,
      readyPath: '/health',
      timeoutMs: 180_000,
    }),
  );
  return { ...proc, model: 'qwen2.5-0.5b-instruct', context };
}
