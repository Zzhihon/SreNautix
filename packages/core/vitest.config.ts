import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@srenautix/source'],
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
