import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 镜像入口 main.ts：子命令与角色参数的分派（真实进程，当前 node 以 tsx 加载器直接运行源码）。
 * tsx 是本包的 devDependency，经 --import 按本包的依赖解析，不依赖 node_modules/.bin 中的脚本。
 */
const APP = resolve(import.meta.dirname, '../..');

function main(args: string[]) {
  const r = spawnSync(process.execPath, ['--conditions=@srenautix/source', '--import', 'tsx', 'src/main.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    timeout: 60_000,
  });
  // 进程没能启动或被超时杀掉时直接给出原因，避免只看到 status 为 null
  expect(r.error, `子进程没有正常运行：${r.error?.message}`).toBeUndefined();
  expect(r.signal, `子进程被信号 ${r.signal} 终止\n${r.stderr}`).toBeNull();
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('main.ts', () => {
  it('eval 子命令的参数交给评测命令，不经过角色参数的严格解析', () => {
    // --cases 不是角色参数；交给评测命令后因为缺少 --config 报错
    const r = main(['eval', '--cases', '/nonexistent']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('--config');
    expect(r.out).not.toContain("Unknown option '--cases'");
  });

  it('角色参数仍然严格解析', () => {
    const r = main(['--role=nope']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('--role 必须是');
    expect(main(['--cases', 'x']).out).toContain("Unknown option '--cases'");
  });
});
