// 把浏览器测试用的 Chromium 装进仓库根目录的 .scratch/ms-playwright。路径由本文件的位置算出绝对路径，
// 与 vite.config.ts 中设置的 PLAYWRIGHT_BROWSERS_PATH 相同，不依赖当前工作目录。已经装好时 playwright 直接返回。
//   tsx scripts/browsers.ts            只装 headless shell（组件测试）
//   tsx scripts/browsers.ts --full     装完整的 Chromium（e2e）

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BROWSERS_PATH } from './browsers-path';

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const args = process.argv.includes('--full') ? ['install', 'chromium'] : ['install', '--only-shell', 'chromium'];
execFileSync(process.execPath, [cli, ...args], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH },
});
