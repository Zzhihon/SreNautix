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
      {
        // 对真实模型服务运行并录制夹具；需要 SRENAUTIX_LIVE_LLM_BASE_URL，只由 pnpm test:live 运行
        extends: true,
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: 1_800_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
