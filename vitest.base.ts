// 各包 vitest 配置的公共部分：工作区内的包按 @srenautix/source 条件直接解析到源码，无需先构建
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const conditions = ['@srenautix/source', ...defaultServerConditions];

export const baseConfig = defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
