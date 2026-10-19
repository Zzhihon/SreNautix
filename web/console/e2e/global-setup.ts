// Playwright 的全局准备：构建控制台，启动真实后端并写入种子数据；返回的函数在全部测试结束后停止后端。
// SRENAUTIX_E2E_REUSE_HUB=1 时复用 e2e/run-hub.ts 已经启动的后端（调试用，状态取自 state.json）。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, startHub, STATE_FILE } from './hub';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.SRENAUTIX_E2E_REUSE_HUB === '1') {
    if (!existsSync(STATE_FILE)) {
      throw new Error(`SRENAUTIX_E2E_REUSE_HUB=1 但没有 ${STATE_FILE}：先运行 e2e/run-hub.ts`);
    }
    return async () => undefined;
  }
  execFileSync(process.execPath, [resolve(REPO, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: resolve(REPO, 'web/console'),
    stdio: 'inherit',
  });
  const hub = await startHub();
  return hub.stop;
}
