import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 工作区内的包直接使用源码（package.json exports 的 @srenautix/source 条件）；测试在 Node 环境运行，取 ssr 的解析条件
  resolve: {
    conditions: ['@srenautix/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@srenautix/source'],
      externalConditions: ['@srenautix/source'],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
