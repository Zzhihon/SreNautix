import { createHash } from 'node:crypto';
import type { EvalEnvironment } from '@srenautix/contract';
import { modelSchema } from '../llm/schema.js';
import type { RouteRuntime } from '../llm/session.js';
import { PROMPTS, type Language } from '../prompts/index.js';
import type { Tool } from '../tools/box.js';

// 运行的环境指纹（ADR 0180）：提示词、模型输出 schema、工具契约、模型 id、方言档案与代码提交。成绩单按指纹分行，
// 指纹不同的成绩不直接比较。

const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

/** 一种语言的全部提示词模板（固定指令与各步骤的任务说明，按步骤名排序） */
export function promptSetHash(language: Language): string {
  const p = PROMPTS[language];
  const steps = Object.keys(p).sort() as Array<keyof typeof p>;
  return sha256(JSON.stringify(steps.map((k) => [k, p[k]])));
}

/** 研判使用的模型输出 schema（绑定动态枚举之前） */
export function modelSchemaHash(): string {
  return sha256(JSON.stringify([modelSchema('hypothesize'), modelSchema('conclude')]));
}

/**
 * 只读工具的契约：名称、来源、是否只读当前状态与参数 schema，按名称排序。工具描述不计入：回放快照的工具描述列出这个
 * 快照录制过的查询，随用例变化
 */
export function toolContractHash(tools: readonly Pick<Tool, 'name' | 'source' | 'live' | 'parameters'>[]): string {
  const rows = [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ name: t.name, source: t.source, live: t.live, parameters: t.parameters }));
  return sha256(JSON.stringify(rows));
}

/** 一条路由在一次评测中的环境指纹；id 是其余六项按固定顺序序列化后的 SHA-256 前 16 位十六进制 */
export function runEnvironment(
  route: Pick<RouteRuntime, 'route' | 'profile'>,
  language: Language,
  tools: readonly Pick<Tool, 'name' | 'source' | 'live' | 'parameters'>[],
  codeSha: string,
): EvalEnvironment {
  const parts = {
    prompt_hash: promptSetHash(language),
    model_schema_hash: modelSchemaHash(),
    tool_contract_hash: toolContractHash(tools),
    model: route.route.model,
    dialect_profile: route.profile.id,
    code_sha: codeSha,
  };
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        parts.prompt_hash,
        parts.model_schema_hash,
        parts.tool_contract_hash,
        parts.model,
        parts.dialect_profile,
        parts.code_sha,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  return { id, ...parts };
}
