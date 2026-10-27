import type { EvalEnvironment } from '@srenautix/contract';

// 评分与成绩单测试中运行记录的环境指纹（ADR 0180）：只按 id 分行，内容固定
export const TEST_ENVIRONMENT: EvalEnvironment = {
  id: '0123456789abcdef',
  prompt_hash: `sha256:${'1'.repeat(64)}`,
  model_schema_hash: `sha256:${'2'.repeat(64)}`,
  tool_contract_hash: `sha256:${'3'.repeat(64)}`,
  model: 'm',
  dialect_profile: 'openai-chat',
  code_sha: 'test',
};
