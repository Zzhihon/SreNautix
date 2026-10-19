import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { BROWSERS_PATH } from './scripts/browsers-path';

// 浏览器装在仓库根目录的 .scratch/ms-playwright（scripts/browsers.ts）；用绝对路径，与工作目录无关
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

// 库构建：只输出本包的代码，依赖全部外置，由宿主（控制台、Grafana 插件）打包。
// 组件测试在真实的 Chromium 里运行（vitest 浏览器模式），uPlot 等依赖 canvas 的组件按真实行为渲染。
const external = [
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^@tanstack\//,
  /^@srenautix\//,
  /^@xyflow\//,
  /^@grafana\//,
  'elkjs',
  /^elkjs\//,
  'intl-messageformat',
  'lucide-react',
  'radix-ui',
  /^uplot($|\/)/,
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['@srenautix/source'],
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly', generateScopedName: 'sn-[name]-[local]-[hash:base64:5]' },
  },
  build: {
    lib: {
      entry: { index: 'src/index.ts', grafana: 'src/theme/grafana.ts' },
      formats: ['es'],
      cssFileName: 'ui',
    },
    rolldownOptions: { external },
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    attachmentsDir: '../../.scratch/vitest-attachments/ui',
    browser: {
      enabled: true,
      headless: true,
      screenshotDirectory: '../../.scratch/vitest-screenshots/ui',
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
