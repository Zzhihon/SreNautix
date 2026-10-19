import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 镜像入口 main.ts：子命令与角色参数的分派（真实进程，tsx 直接运行源码）。 */
const APP = resolve(import.meta.dirname, '../..');

function main(args: string[]) {
  const r = spawnSync(resolve(APP, 'node_modules/.bin/tsx'), ['src/main.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: '--conditions=@srenautix/source' },
  });
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
