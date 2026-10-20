import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pgConfigFromEnv } from './config/database.js';
import { loadServerConfig } from './config/server.js';
import { hashPassword } from './identity/password.js';
import { logger } from './log.js';
import { serverTracks } from './roles/server-schema.js';
import { bootstrap, DEFAULT_DB_ROLES } from './store/bootstrap.js';
import { migrateContract, migrateExpand } from './store/migrate.js';
import { createPool } from './store/pool.js';

const DEFAULT_CONFIG = '/etc/srenautix/config.yaml';

/**
 * 运维子命令（每个子命令都接受 --config，默认 /etc/srenautix/config.yaml；未知选项报错）：
 *   db bootstrap --admin-password-file=<文件>   以 PGUSER（数据库管理员）建角色与 schema
 *   db migrate                                  以 server 库角色执行扩展迁移（Helm pre-upgrade 钩子）
 *   db contract                                 以 server 库角色执行收缩迁移（全部副本升级之后）
 *   admin hash-password                         从标准输入读口令，输出本地管理员口令哈希
 *   audit verify [--source=s3|pg]               校验治理审计链
 */
export async function runCommand(args: string[]): Promise<void> {
  const [group, cmd, ...rest] = args;
  const key = `${group} ${cmd}`;
  const config = { type: 'string', default: DEFAULT_CONFIG } as const;
  switch (key) {
    case 'db bootstrap': {
      const { values } = parseArgs({ args: rest, options: { config, 'admin-password-file': { type: 'string' } } });
      const file = values['admin-password-file'];
      if (!file) {
        throw new Error('db bootstrap 需要 --admin-password-file');
      }
      const cfg = pgConfigFromEnv(process.env, file);
      const pool = createPool(cfg, 'srenautix-bootstrap', 1);
      await bootstrap(pool, cfg.database, DEFAULT_DB_ROLES);
      await pool.end();
      logger.info('数据库角色与 schema 已就绪', { database: cfg.database });
      return;
    }
    case 'db migrate':
    case 'db contract': {
      const { values } = parseArgs({ args: rest, options: { config } });
      const c = loadServerConfig(values.config);
      const pool = createPool(pgConfigFromEnv(process.env, c.database.password_file), 'srenautix-migrate', 1);
      const done =
        cmd === 'migrate'
          ? await migrateExpand(pool, 'server', serverTracks)
          : await migrateContract(pool, 'server', serverTracks);
      await pool.end();
      logger.info(cmd === 'migrate' ? '扩展迁移完成' : '收缩迁移完成', { applied: done });
      return;
    }
    case 'admin hash-password': {
      parseArgs({ args: rest, options: { config } });
      const pw = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      process.stdout.write(`${await hashPassword(pw)}\n`);
      return;
    }
    case 'audit verify': {
      const { values } = parseArgs({ args: rest, options: { config, source: { type: 'string' } } });
      const { verifyCommand } = await import('./store/audit-verify.js');
      await verifyCommand(values.config, values.source === undefined ? [] : [`--source=${values.source}`]);
      return;
    }
    default:
      throw new Error(`未知的子命令：${args.join(' ')}`);
  }
}
