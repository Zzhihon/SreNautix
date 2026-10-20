// 用各角色自己的配置解析代码校验 chart 渲染出的 server、worker、mcp 配置（由 deploy/helm/check-role-configs.sh 调用）。
//   node --conditions=@srenautix/source --import tsx deploy/helm/configcheck/check.ts <目录>
// 目录下有 server.json、worker.json、mcp.json（config.yaml 由 yq 转成 JSON）；任何一个不能通过解析都以非零状态退出。
// 另有 gateway-policy.json 时（chart 生成的 gateway 策略，含按 remediation 补上的 gitops 一节），按契约
// gateway/v1/gateway-policy.schema.json 校验：gateway 加载策略失败时整体转为只提议，这里在渲染阶段发现。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractAjv, validatorFor } from '../../../packages/contract/src/validate.ts';
import { parseServerConfig } from '../../../apps/srenautix/src/config/server.ts';
import { workerConfigSchema } from '../../../apps/srenautix/src/research/config.ts';
import { parseMcpConfig } from '../../../apps/srenautix/src/roles/mcp.ts';

const dir = process.argv[2];
if (!dir) {
  throw new Error('用法：check.ts <渲染出的配置目录>');
}
const load = (role: string): unknown => JSON.parse(readFileSync(join(dir, `${role}.json`), 'utf8'));

parseServerConfig(load('server'));
console.log('server：通过');
workerConfigSchema.parse(load('worker'));
console.log('worker：通过');
parseMcpConfig(load('mcp'));
console.log('mcp：通过');
if (existsSync(join(dir, 'gateway-policy.json'))) {
  const validate = validatorFor('gateway/v1/gateway-policy.schema.json');
  if (!validate(load('gateway-policy'))) {
    throw new Error(`gateway 策略不符合契约：${contractAjv().errorsText(validate.errors)}`);
  }
  console.log('gateway 策略：通过');
}
