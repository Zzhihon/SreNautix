// 用各角色自己的配置解析代码校验 chart 渲染出的 server、worker、mcp 配置（由 deploy/helm/check-role-configs.sh 调用）。
//   node --conditions=@srenautix/source --import tsx deploy/helm/configcheck/check.ts <目录>
// 目录下有 server.json、worker.json、mcp.json（config.yaml 由 yq 转成 JSON）；任何一个不能通过解析都以非零状态退出。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
