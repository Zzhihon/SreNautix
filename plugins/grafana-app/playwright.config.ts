import { defineConfig, devices } from '@playwright/test';
import { BROWSERS_PATH } from '../../packages/ui/scripts/browsers-path.ts';

process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: '../../.scratch/grafana-e2e/results',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure', locale: 'zh-CN' },
  projects: [
    { name: 'oidc', testMatch: /oidc\.setup\.ts/ },
    { name: 'grafana', dependencies: ['oidc'], testMatch: /plugin\.spec\.ts/ },
  ],
});
