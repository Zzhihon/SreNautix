import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 浏览器模式下没有全局 afterEach 钩子，testing-library 不会自动卸载，这里显式卸载每个用例渲染的树
afterEach(() => {
  cleanup();
});
