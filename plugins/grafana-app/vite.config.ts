import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import cssInjectedByJs from 'vite-plugin-css-injected-by-js';

// Grafana 用 SystemJS（带 AMD 扩展）加载插件的 module.js，并把下面这些模块作为共享依赖注入。
// 共享依赖必须外置：插件与 Grafana 用同一份 React，否则 hooks 跨两份 React 运行时直接报错。
// react/jsx-runtime 从 Grafana 11.6.11、12.0.10、12.1.7、12.2.5 起共享（plugin.json 的
// grafanaDependency 与之对应）；更早的版本没有这个共享模块，加载 module.js 时 /react/jsx-runtime 404。
export const SHARED = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@grafana/data',
  '@grafana/runtime',
  '@grafana/ui',
  '@emotion/css',
  '@emotion/react',
  'rxjs',
];

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

/** 把 plugin.json（填入版本与日期）、LICENSE、README、logo 复制进 dist。 */
function pluginAssets(): Plugin {
  return {
    name: 'srenautix-plugin-assets',
    apply: 'build',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      mkdirSync(resolve(dist, 'img'), { recursive: true });
      const manifest = readFileSync(resolve(__dirname, 'src/plugin.json'), 'utf8')
        .replaceAll('%VERSION%', pkg.version)
        .replaceAll('%TODAY%', new Date().toISOString().slice(0, 10));
      writeFileSync(resolve(dist, 'plugin.json'), manifest);
      cpSync(resolve(__dirname, 'src/img/logo.svg'), resolve(dist, 'img/logo.svg'));
      cpSync(resolve(__dirname, 'README.md'), resolve(dist, 'README.md'));
      cpSync(resolve(__dirname, 'LICENSE'), resolve(dist, 'LICENSE'));
    },
  };
}

export default defineConfig({
  plugins: [react(), cssInjectedByJs(), pluginAssets()],
  resolve: {
    conditions: ['@srenautix/source'],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly', generateScopedName: 'srn-[local]-[hash:base64:6]' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/module.tsx'),
      formats: ['umd'],
      name: 'SrenautixConsoleApp',
      fileName: () => 'module.js',
    },
    rolldownOptions: {
      external: SHARED,
      output: {
        // 子模块（elkjs）内联进 module.js：SystemJS 不认识插件自己的动态分片地址
        inlineDynamicImports: true,
      },
    },
  },
});
