import type pg from 'pg';

/** 每个角色一个数据库角色；server 与 worker 各自拥有一个 schema，mcp 没有 schema（DESIGN §2.1）。 */
export interface DbRoles {
  server: string;
  worker: string;
  mcp: string;
}

export const DEFAULT_DB_ROLES: DbRoles = {
  server: 'srenautix_server',
  worker: 'srenautix_worker',
  mcp: 'srenautix_mcp',
};

/** 角色属主的 schema 名。 */
export const SCHEMAS = { server: 'server', worker: 'worker' } as const;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(v: string): string {
  if (!IDENT.test(v)) {
    throw new Error(`不合法的数据库标识符：${v}`);
  }
  return v;
}

/**
 * 以数据库管理员身份执行的初始化 SQL：建角色（不设口令，口令由部署方式管理）、收回 PUBLIC 的默认权限、
 * 建两个 schema 并交给各自的角色。可以重复执行。
 */
export function bootstrapSql(database: string, roles: DbRoles): string {
  const db = ident(database);
  const r = { server: ident(roles.server), worker: ident(roles.worker), mcp: ident(roles.mcp) };
  const createRole = (name: string) =>
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END $$;`;
  return [
    createRole(r.server),
    createRole(r.worker),
    createRole(r.mcp),
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${db} TO ${r.server}, ${r.worker}, ${r.mcp};`,
    `REVOKE ALL ON SCHEMA public FROM PUBLIC;`,
    `CREATE SCHEMA IF NOT EXISTS ${SCHEMAS.server} AUTHORIZATION ${r.server};`,
    `CREATE SCHEMA IF NOT EXISTS ${SCHEMAS.worker} AUTHORIZATION ${r.worker};`,
    `ALTER SCHEMA ${SCHEMAS.server} OWNER TO ${r.server};`,
    `ALTER SCHEMA ${SCHEMAS.worker} OWNER TO ${r.worker};`,
    `REVOKE ALL ON SCHEMA ${SCHEMAS.server} FROM PUBLIC;`,
    `REVOKE ALL ON SCHEMA ${SCHEMAS.worker} FROM PUBLIC;`,
  ].join('\n');
}

export async function bootstrap(admin: pg.Pool, database: string, roles: DbRoles): Promise<void> {
  await admin.query(bootstrapSql(database, roles));
}

export interface IsolationViolation {
  role: string;
  schema: string;
}

/**
 * 每个角色对其他角色的 schema 没有 USAGE（DESIGN §2.1，CI 用 has_schema_privilege 检查）。
 * 返回违反隔离的 (角色, schema) 对，空数组表示隔离成立。
 */
export async function schemaIsolationViolations(pool: pg.Pool, roles: DbRoles): Promise<IsolationViolation[]> {
  const pairs: Array<[string, string]> = [
    [roles.server, SCHEMAS.worker],
    [roles.worker, SCHEMAS.server],
    [roles.mcp, SCHEMAS.server],
    [roles.mcp, SCHEMAS.worker],
  ];
  const out: IsolationViolation[] = [];
  for (const [role, schema] of pairs) {
    const r = await pool.query<{ ok: boolean }>("SELECT has_schema_privilege($1, $2, 'USAGE') AS ok", [role, schema]);
    if (r.rows[0]?.ok) {
      out.push({ role, schema });
    }
  }
  return out;
}
