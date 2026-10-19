import type { PgConfig, PgSslMode } from '../store/pool.js';
import { ConfigError, readPemCert, readSecretFile } from './files.js';

export const DEFAULT_DB_PASSWORD_FILE = '/etc/srenautix/secrets/db/password';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) {
    throw new ConfigError(`缺少环境变量 ${name}`);
  }
  return v;
}

/**
 * 连接参数来自 libpq 的标准环境变量 PGHOST、PGPORT、PGDATABASE、PGUSER、PGSSLMODE、PGSSLROOTCERT；
 * 口令只从文件读取（每个角色挂载自己的库角色口令）。
 */
export function pgConfigFromEnv(env: Env, passwordFile: string): PgConfig {
  const sslMode = (env.PGSSLMODE?.trim() || 'verify-full') as PgSslMode;
  if (!['disable', 'require', 'verify-full'].includes(sslMode)) {
    throw new ConfigError(`PGSSLMODE 只能是 disable | require | verify-full：${sslMode}`);
  }
  const port = Number(env.PGPORT?.trim() || '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PGPORT 不合法：${env.PGPORT}`);
  }
  let caCert: string | null = null;
  if (sslMode === 'verify-full') {
    caCert = readPemCert('PGSSLROOTCERT', required(env, 'PGSSLROOTCERT'));
  }
  return {
    host: required(env, 'PGHOST'),
    port,
    database: required(env, 'PGDATABASE'),
    user: required(env, 'PGUSER'),
    password: readSecretFile('数据库口令', passwordFile),
    sslMode,
    caCert,
  };
}
