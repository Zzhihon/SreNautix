import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/commands.js';

// 运维子命令的选项按子命令解析：chart 的 db bootstrap Job 与文档里的 audit verify 都依赖这些选项被接受
describe('运维子命令的参数', () => {
  it('db bootstrap 接受 --admin-password-file，并读取 libpq 环境变量', async () => {
    const saved = { ...process.env };
    process.env.PGSSLMODE = 'verify-full';
    delete process.env.PGSSLROOTCERT;
    try {
      await expect(runCommand(['db', 'bootstrap', '--admin-password-file=/nonexistent/password'])).rejects.toThrow(
        /PGSSLROOTCERT/,
      );
    } finally {
      process.env = saved;
    }
  });

  it('db bootstrap 缺少 --admin-password-file 时报错', async () => {
    await expect(runCommand(['db', 'bootstrap'])).rejects.toThrow('db bootstrap 需要 --admin-password-file');
  });

  it('db wait 只接受 server、worker 两个 schema', async () => {
    await expect(runCommand(['db', 'wait'])).rejects.toThrow('db wait 需要 --schema=server|worker');
    await expect(runCommand(['db', 'wait', '--schema=public'])).rejects.toThrow('db wait 需要 --schema=server|worker');
  });

  it('db wait 接受 --password-file，并读取 libpq 环境变量', async () => {
    const saved = { ...process.env };
    process.env.PGSSLMODE = 'verify-full';
    delete process.env.PGSSLROOTCERT;
    try {
      await expect(
        runCommand(['db', 'wait', '--schema=worker', '--password-file=/nonexistent/password']),
      ).rejects.toThrow(/PGSSLROOTCERT/);
    } finally {
      process.env = saved;
    }
  });

  it('db migrate 读取 --config 指定的文件', async () => {
    await expect(runCommand(['db', 'migrate', '--config=/nonexistent/config.yaml'])).rejects.toThrow(
      /\/nonexistent\/config\.yaml/,
    );
  });

  it('子命令不接受其他子命令的选项', async () => {
    await expect(runCommand(['audit', 'verify', '--admin-password-file=x'])).rejects.toThrow(/Unknown option/);
  });

  it('未知子命令报错', async () => {
    await expect(runCommand(['db', 'drop'])).rejects.toThrow('未知的子命令：db drop');
  });
});
