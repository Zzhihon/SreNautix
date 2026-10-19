import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import cssInjectedByJs from 'vite-plugin-css-injected-by-js';

// Grafana 用 SystemJS 的 AMD 扩展加载插件的 module.js，并把下面这些模块作为共享依赖注入。
// 共享依赖必须外置：插件与 Grafana 用同一份 React，否则 hooks 跨两份 React 运行时直接报错。
// react/jsx-runtime 从 Grafana 11.6.11、12.0.10、12.1.7、12.2.5 起共享（plugin.json 的
// grafanaDependency 与之对应）；更早的版本没有这个共享模块，加载 module.js 时 /react/jsx-runtime 404。
export const SHARED = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@grafana/data',
  '@grafana/runtime',
  '@grafana/ui',
  'rxjs',
] as const;

const PLUGIN_ID = 'srenautix-console-app';
const here = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as { version: string };

// Rolldown 没有 AMD 输出格式；UMD 的 CommonJS 分支在 Grafana 页面里会被选中（页面上有 exports 与 module），
// 随后 require 不存在。所以输出 CommonJS，再用 define 包起来：共享依赖作为 AMD 依赖注入，
// 包内的 require 只能取到这些已声明的依赖，取其他模块直接报错。
const AMD_BANNER = [
  `define(${JSON.stringify(['exports', ...SHARED])}, function (exports, ${SHARED.map((_, i) => `d${i}`).join(', ')}) {`,
  `var __shared = { ${SHARED.map((n, i) => `${JSON.stringify(n)}: d${i}`).join(', ')} };`,
  'var require = function (name) {',
  '  if (!Object.prototype.hasOwnProperty.call(__shared, name)) { throw new Error("module.js 依赖了未共享的模块 " + name); }',
  '  return __shared[name];',
  '};',
].join('\n');
const AMD_FOOTER = '});';

/** 把 plugin.json（填入插件 id、版本与日期）、LICENSE、README、logo 复制进 dist。 */
function pluginAssets(): Plugin {
  return {
    name: 'srenautix-plugin-assets',
    apply: 'build',
    closeBundle() {
      const dist = resolve(here, 'dist');
      mkdirSync(resolve(dist, 'img'), { recursive: true });
      const manifest = readFileSync(resolve(here, 'src/plugin.json'), 'utf8')
        .replaceAll('%PLUGIN_ID%', PLUGIN_ID)
        .replaceAll('%VERSION%', pkg.version)
        .replaceAll('%TODAY%', new Date().toISOString().slice(0, 10));
      writeFileSync(resolve(dist, 'plugin.json'), manifest);
      cpSync(resolve(here, 'src/img/logo.svg'), resolve(dist, 'img/logo.svg'));
      cpSync(resolve(here, 'README.md'), resolve(dist, 'README.md'));
      cpSync(resolve(here, 'LICENSE'), resolve(dist, 'LICENSE'));
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
    chunkSizeWarningLimit: 3000,
    lib: {
      entry: resolve(here, 'src/module.tsx'),
      formats: ['cjs'],
      fileName: () => 'module.js',
    },
    rolldownOptions: {
      external: [...SHARED],
      output: {
        banner: AMD_BANNER,
        footer: AMD_FOOTER,
        // 子模块（elkjs）内联进 module.js：SystemJS 不认识插件自己的动态分片地址
        inlineDynamicImports: true,
      },
    },
  },
});
