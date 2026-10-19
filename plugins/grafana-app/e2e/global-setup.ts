// 构建控制台与插件（前端与当前平台的后端），启动后端与 Grafana；返回的函数在测试结束后停止全部进程。
// OIDC 用户的控制台登录在 oidc.setup.ts（测试进程里才有 PLAYWRIGHT_BROWSERS_PATH 指向的浏览器）。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildServerDeps, REPO } from '../../../web/console/e2e/hub.ts';
import { startGrafanaStack } from './grafana.ts';

export default async function globalSetup(): Promise<() => Promise<void>> {
  buildServerDeps();
  const vite = resolve(REPO, 'node_modules/vite/bin/vite.js');
  execFileSync(process.execPath, [vite, 'build'], { cwd: resolve(REPO, 'web/console'), stdio: 'inherit' });
  const plugin = resolve(REPO, 'plugins/grafana-app');
  execFileSync(process.execPath, [vite, 'build'], { cwd: plugin, stdio: 'inherit' });
  const host = `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-backend.ts'], {
    cwd: plugin,
    stdio: 'inherit',
    env: { ...process.env, SRENAUTIX_PLUGIN_TARGETS: host },
  });
  const stack = await startGrafanaStack();
  return stack.stop;
}
