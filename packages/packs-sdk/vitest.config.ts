import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@srenautix/source'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // pack test 的用例会启动真实的 Prometheus 与 VictoriaMetrics 进程
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
