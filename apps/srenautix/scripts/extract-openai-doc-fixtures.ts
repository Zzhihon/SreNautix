import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

// 从 OpenAI 官方 OpenAPI 描述（github.com/openai/openai-openapi 的 openapi.yaml）中取出接口文档里的响应示例，
// 保存为模型层测试的夹具（test/fixtures/llm/openai-docs/）。示例是服务方文档给出的真实响应形状。
//   pnpm tsx scripts/extract-openai-doc-fixtures.ts --spec <openapi.yaml 路径> --commit <仓库提交>

const { values } = parseArgs({ options: { spec: { type: 'string' }, commit: { type: 'string' } } });
if (!values.spec || !values.commit) {
  throw new Error('用法：--spec <openapi.yaml> --commit <openai-openapi 的提交>');
}
const doc = parse(readFileSync(values.spec, 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string; 'x-oaiMeta'?: { examples?: unknown } }>>;
};

interface Example {
  title: string;
  response?: string;
}

function examples(path: string, method: string): Example[] {
  const op = doc.paths[path]?.[method];
  const ex = op?.['x-oaiMeta']?.examples;
  if (!ex) {
    throw new Error(`${method.toUpperCase()} ${path} 没有示例`);
  }
  return (Array.isArray(ex) ? ex : [ex]) as Example[];
}

const out = resolve(import.meta.dirname, '../test/fixtures/llm/openai-docs');
mkdirSync(out, { recursive: true });

const wanted: Array<{ path: string; title: string; name: string }> = [
  { path: '/responses', title: 'Text input', name: 'responses-text' },
  { path: '/responses', title: 'Functions', name: 'responses-function-call' },
  { path: '/responses', title: 'Reasoning', name: 'responses-reasoning' },
  { path: '/chat/completions', title: 'Default', name: 'chat-default' },
  { path: '/chat/completions', title: 'Functions', name: 'chat-function-call' },
];

for (const w of wanted) {
  const ex = examples(w.path, 'post').find((e) => e.title === w.title);
  if (!ex?.response) {
    throw new Error(`${w.path} 没有标题为 ${w.title} 的响应示例`);
  }
  const body = JSON.parse(ex.response) as unknown;
  const fixture = {
    provenance: {
      provider: 'openai-docs',
      source: `openai/openai-openapi@${values.commit} openapi.yaml`,
      path: w.path,
      example: w.title,
    },
    status: 200,
    body,
  };
  writeFileSync(join(out, `${w.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`${w.name}\n`);
}
