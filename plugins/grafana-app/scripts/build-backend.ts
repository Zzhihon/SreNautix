// 构建插件后端：每个平台一个可执行文件 gpx_srenautix_console_app_<os>_<arch>，放进 dist/。
// 默认构建 linux/amd64、linux/arm64 与当前主机平台；SRENAUTIX_PLUGIN_TARGETS 可以覆盖，例如 "linux/amd64"。

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const host = `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
const targets = (process.env.SRENAUTIX_PLUGIN_TARGETS ?? `linux/amd64,linux/arm64,${host}`).split(',').filter(Boolean);

for (const target of new Set(targets)) {
  const [goos, goarch] = target.split('/');
  if (!goos || !goarch) {
    throw new Error(`SRENAUTIX_PLUGIN_TARGETS 中的平台格式不对：${target}`);
  }
  const out = resolve(root, 'dist', `gpx_srenautix_console_app_${goos}_${goarch}${goos === 'windows' ? '.exe' : ''}`);
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, './pkg'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
  });
  console.log(`已构建 ${out}`);
}
