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
    include: ['test/**/*.test.ts'],
    // pack test 的用例会启动真实的 Prometheus、VictoriaMetrics 与 Loki 进程
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
