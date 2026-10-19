import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@srenautix/source'],
  },
  // 测试在 SSR 环境中运行，工作区包的源码入口也要按这个条件解析
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
