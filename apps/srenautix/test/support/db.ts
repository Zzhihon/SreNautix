import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { inject } from 'vitest';
import { DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';
import { createPool, type PgConfig } from '../../src/store/pool.js';
import { createDatabase } from './pg-cluster.js';

export interface TestDb {
  name: string;
  /** server 库角色的连接池。 */
  server: pg.Pool;
  /** worker 库角色的连接池。 */
  worker: pg.Pool;
  /** 超级用户（只用于测试断言与造数据之外的检查）。 */
  admin: pg.Pool;
  serverConfig: PgConfig;
  close(): Promise<void>;
}

/** 为一个测试文件新建一个库，以三个库角色分别连接。 */
export async function newTestDb(): Promise<TestDb> {
  const port = inject('pgPort');
  const password = inject('pgPassword');
  const name = `t_${randomBytes(6).toString('hex')}`;
  await createDatabase(port, password, name);
  const cfg = (user: string): PgConfig => ({
    host: '127.0.0.1',
    port,
    database: name,
    user,
    password,
    sslMode: 'disable',
    caCert: null,
  });
  const server = createPool(cfg(DEFAULT_DB_ROLES.server), 'test-server', 10);
  const worker = createPool(cfg(DEFAULT_DB_ROLES.worker), 'test-worker', 4);
  const admin = createPool(cfg('postgres'), 'test-admin', 2);
  return {
    name,
    server,
    worker,
    admin,
    serverConfig: cfg(DEFAULT_DB_ROLES.server),
    async close() {
      await Promise.all([server.end(), worker.end(), admin.end()]);
    },
  };
}
