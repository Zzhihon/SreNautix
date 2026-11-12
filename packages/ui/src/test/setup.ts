import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// 浏览器模式下没有全局 afterEach 钩子，testing-library 不会自动卸载，这里显式卸载每个用例渲染的树
afterEach(() => {
  cleanup();
});

// 图在 elkjs（约 1.5 MB）按需加载完之后才画出；CI 上冷加载会超过默认的 1 秒等待
configure({ asyncUtilTimeout: 5000 });
