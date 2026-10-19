import type pg from 'pg';

/**
 * 一条迁移。expand 只增加（新表、新列、放宽约束），N-1 版本的二进制可以在其上运行，进程启动时自动执行；
 * contract 删除或收紧，只在全部副本升级到引入它的版本之后，由 `srenautix db contract` 显式执行。
 */
export interface Migration {
  version: number;
  name: string;
  phase: 'expand' | 'contract';
  sql: string;
}

/**
 * 一个 schema 的迁移分为若干条轨道（track），每个模块一条，各自从版本 1 起编号；
 * 轨道按列出的顺序执行，后面的轨道可以引用前面轨道建的表。
 */
export interface Track {
  track: string;
  migrations: readonly Migration[];
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function checkTracks(schema: string, tracks: readonly Track[]): void {
  const names = tracks.map((t) => t.track);
  if (new Set(names).size !== names.length) {
    throw new MigrationError(`schema ${schema} 的迁移轨道名重复`);
  }
  for (const t of tracks) {
    if (!/^[a-z][a-z0-9_-]*$/.test(t.track)) {
      throw new MigrationError(`schema ${schema} 的轨道名不合法：${t.track}`);
    }
    t.migrations.forEach((m, i) => {
      if (m.version !== i + 1) {
        throw new MigrationError(`schema ${schema} 轨道 ${t.track} 的第 ${i + 1} 条迁移版本号为 ${m.version}`);
      }
      if (!m.name.trim()) {
        throw new MigrationError(`schema ${schema} 轨道 ${t.track} 的迁移 ${m.version} 没有名称`);
      }
    });
  }
}

interface Applied {
  track: string;
  version: number;
  name: string;
  phase: 'expand' | 'contract';
}

async function ensureTable(c: pg.PoolClient, schema: string): Promise<void> {
  await c.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
       track text NOT NULL,
       version integer NOT NULL,
       name text NOT NULL,
       phase text NOT NULL CHECK (phase IN ('expand', 'contract')),
       applied_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (track, version))`,
  );
}

async function applied(c: pg.PoolClient | pg.Pool, schema: string): Promise<Applied[]> {
  const r = await c.query<Applied>(
    `SELECT track, version, name, phase FROM ${schema}.schema_migrations ORDER BY track, version`,
  );
  return r.rows;
}

/**
 * 库里已执行、本二进制不认识的迁移只能是 expand（新版本的二进制已扩展 schema，本版本作为 N-1 继续运行）；
 * 出现不认识的 contract 迁移说明 schema 已收紧到本版本不兼容，立即失败。
 */
function checkCompatible(schema: string, tracks: readonly Track[], done: Applied[]): void {
  for (const a of done) {
    const k = tracks.find((t) => t.track === a.track)?.migrations.find((m) => m.version === a.version);
    if (!k) {
      if (a.phase === 'contract') {
        throw new MigrationError(
          `schema ${schema} 已执行本版本不认识的收缩迁移 ${a.track}/${a.version}（${a.name}），二进制版本过旧`,
        );
      }
      continue;
    }
    if (k.name !== a.name || k.phase !== a.phase) {
      throw new MigrationError(
        `schema ${schema} 迁移 ${a.track}/${a.version} 在库中为 ${a.name}/${a.phase}，本版本为 ${k.name}/${k.phase}`,
      );
    }
  }
}

async function run(
  pool: pg.Pool,
  schema: string,
  tracks: readonly Track[],
  phase: 'expand' | 'contract',
): Promise<string[]> {
  checkTracks(schema, tracks);
  const c = await pool.connect();
  const out: string[] = [];
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.migrate.${schema}`]);
    await ensureTable(c, schema);
    const done = await applied(c, schema);
    checkCompatible(schema, tracks, done);
    const key = (t: string, v: number) => `${t}/${v}`;
    const have = new Set(done.map((a) => key(a.track, a.version)));
    for (const t of tracks) {
      for (const m of t.migrations) {
        if (have.has(key(t.track, m.version))) {
          continue;
        }
        if (m.phase !== phase) {
          if (phase === 'contract') {
            throw new MigrationError(
              `schema ${schema} 的扩展迁移 ${t.track}/${m.version} 尚未执行，先启动新版本完成扩展迁移`,
            );
          }
          // 未执行的收缩迁移之后还有扩展迁移：必须先执行上一个版本的收缩迁移，才能升级到本版本
          const blocked = t.migrations.find(
            (x) => x.version > m.version && x.phase === 'expand' && !have.has(key(t.track, x.version)),
          );
          if (blocked) {
            throw new MigrationError(
              `schema ${schema} 的收缩迁移 ${t.track}/${m.version}（${m.name}）尚未执行，扩展迁移 ${blocked.version} 依赖它；先执行 srenautix db contract`,
            );
          }
          break;
        }
        await c.query(m.sql);
        await c.query(`INSERT INTO ${schema}.schema_migrations (track, version, name, phase) VALUES ($1, $2, $3, $4)`, [
          t.track,
          m.version,
          m.name,
          m.phase,
        ]);
        out.push(key(t.track, m.version));
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return out;
}

/** 进程启动时执行全部尚未执行的扩展迁移，返回执行过的 `<track>/<version>`。 */
export function migrateExpand(pool: pg.Pool, schema: string, tracks: readonly Track[]): Promise<string[]> {
  return run(pool, schema, tracks, 'expand');
}

/** `srenautix db contract`：执行收缩迁移。 */
export function migrateContract(pool: pg.Pool, schema: string, tracks: readonly Track[]): Promise<string[]> {
  return run(pool, schema, tracks, 'contract');
}

/** readyz：本版本的全部扩展迁移都已执行，且库中没有不兼容的收缩迁移。 */
export async function migrationsReady(pool: pg.Pool, schema: string, tracks: readonly Track[]): Promise<boolean> {
  const done = await applied(pool, schema);
  checkCompatible(schema, tracks, done);
  const have = new Set(done.map((a) => `${a.track}/${a.version}`));
  return tracks.every((t) =>
    t.migrations.filter((m) => m.phase === 'expand').every((m) => have.has(`${t.track}/${m.version}`)),
  );
}
