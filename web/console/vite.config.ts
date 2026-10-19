import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { BROWSERS_PATH } from '../../packages/ui/scripts/browsers-path';

// 浏览器装在仓库根目录的 .scratch/ms-playwright（packages/ui/scripts/browsers.ts）；用绝对路径，与工作目录无关
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

// 开发时把 /v1 转发到本地的 server；构建产物由 server 角色在控制台入口下提供（同源，cookie 与 CSRF 不跨域）。
const hub = process.env.SRENAUTIX_HUB_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['@srenautix/source'],
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  server: {
    port: 5173,
    proxy: { '/v1': { target: hub, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { '/v1': { target: hub, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    attachmentsDir: '../../.scratch/vitest-attachments/console',
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotDirectory: '../../.scratch/vitest-screenshots/console',
    },
  },
});
