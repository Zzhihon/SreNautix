import { defineConfig, devices } from '@playwright/test';

// 后端由 global-setup 启动（真实 server、PostgreSQL 与 envtest）；baseURL 在 global-setup 之后写入环境变量，
// 所以测试里通过 e2e/state.ts 读取控制台地址。登录一次后复用会话（server 拒绝同一个 TOTP 码被使用两次）。
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: '../../.scratch/console-e2e/results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    { name: 'login', testMatch: /login\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['login'],
      testMatch: /console\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: '../../.scratch/console-e2e/session.json' },
    },
    {
      name: 'mobile',
      dependencies: ['desktop'],
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'], storageState: '../../.scratch/console-e2e/session.json' },
    },
  ],
});
