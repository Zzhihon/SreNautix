// dbstats/v1 一致性测试（契约 2.28.0，ADR 0146 §3.3、§6.5 的不变量 14）：在真实 PostgreSQL（预加载 pg_stat_statements）上
// 建一个业务库与只读角色，执行固定的工作负载，核对每个操作的结果结构与语义、两次采样、调用上限，以及
// 只读角色读不到业务表、额外授予 SELECT 之后集成降级为不可用。

import { validatorFor, type DbstatsRequest, type DbstatsSample } from '@srenautix/contract';
import { PostgresDbstatsAdapter } from '../dbstats/postgres.js';
import { normalizeStatement, statementFingerprint } from '../dbstats/normalize.js';
import { dbstatsRoleStatements, type TestPostgres } from '../testing/postgres.js';
import { Checks, expectEq, expectReject, type ConformanceReport } from './report.js';

export const CONFORMANCE_DATABASE = 'shop';
export const CONFORMANCE_ROLE = 'srenautix_stats';

/** 业务库：orders 表有主键与 customer_id 上的唯一索引之外的普通索引，status 上没有索引 */
const SETUP = [
  'CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, total numeric NOT NULL)',
  'CREATE INDEX orders_customer ON orders (customer_id)',
  'CREATE UNIQUE INDEX orders_status_id ON orders (status, id)',
  "INSERT INTO orders (customer_id, status, total) SELECT g % 100, CASE WHEN g % 10 = 0 THEN 'open' ELSE 'done' END, g FROM generate_series(1, 5000) g",
  'ANALYZE orders',
];

/** 带注释与常量的语句（total 上没有索引，顺序扫描）：规范化后常量换成 $n、注释去掉 */
const SLOW = "SELECT count(*) /* report */ FROM orders WHERE total > 100 AND status <> 'void' -- seq scan";

async function workload(pgsql: TestPostgres, n: number): Promise<void> {
  const c = await pgsql.connect(CONFORMANCE_DATABASE);
  try {
    for (let i = 0; i < n; i++) {
      await c.query(SLOW);
      await c.query('SELECT total FROM orders WHERE customer_id = $1', [i % 100]);
    }
  } finally {
    await c.end();
  }
}

/** 表统计是异步汇总的（PG 15 起每秒刷新一次，之前经统计收集进程）：等到 orders 的顺序扫描计数达到 n */
async function waitTableStats(pgsql: TestPostgres, n: number): Promise<void> {
  const c = await pgsql.connect(CONFORMANCE_DATABASE);
  try {
    for (let i = 0; i < 100; i++) {
      await c.query('SELECT pg_stat_clear_snapshot()');
      const r = await c.query<{ seq_scan: string }>(
        "SELECT seq_scan::text FROM pg_stat_user_tables WHERE relname = 'orders'",
      );
      if (Number(r.rows[0]?.seq_scan ?? 0) >= n) {
        return;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`10 秒内 orders 的顺序扫描计数没有达到 ${n}`);
  } finally {
    await c.end();
  }
}

export async function runDbstatsConformance(pgsql: TestPostgres): Promise<ConformanceReport> {
  const id = `postgres-${pgsql.major}`;
  const c = new Checks('dbstats/v1', id);
  const admin = await pgsql.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${CONFORMANCE_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${CONFORMANCE_DATABASE}`);
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [CONFORMANCE_ROLE])).rowCount) {
      for (const s of dbstatsRoleStatements(CONFORMANCE_ROLE, pgsql.password)) {
        await admin.query(s);
      }
    }
  } finally {
    await admin.end();
  }
  await pgsql.exec(CONFORMANCE_DATABASE, ['CREATE EXTENSION IF NOT EXISTS pg_stat_statements', ...SETUP]);
  await pgsql.exec(CONFORMANCE_DATABASE, ['SELECT pg_stat_statements_reset()']);
  await workload(pgsql, 20);
  await waitTableStats(pgsql, 20);

  const reports: unknown[] = [];
  const adapter = (opts: { hourly_limit?: number; text_hourly_limit?: number } = {}) =>
    new PostgresDbstatsAdapter({
      id,
      host: pgsql.host,
      port: pgsql.port,
      database: CONFORMANCE_DATABASE,
      user: CONFORMANCE_ROLE,
      password: pgsql.password,
      hourly_limit: opts.hourly_limit ?? 1000,
      text_hourly_limit: opts.text_hourly_limit ?? 1000,
      onPrivilegeReport: (r) => reports.push(r),
    });
  const a = adapter();
  const rowsValid = (def: string, s: DbstatsSample) => {
    const v = validatorFor(`integrations/dbstats/v1/dbstats.schema.json#/$defs/${def}`);
    for (const r of s.rows) {
      if (!v(r)) {
        throw new Error(`${def} 不符合契约：${JSON.stringify(v.errors)} ${JSON.stringify(r)}`);
      }
    }
    if (!validatorFor('integrations/dbstats/v1/dbstats.schema.json#/$defs/Sample')(s)) {
      throw new Error('Sample 不符合契约');
    }
  };
  const read = (req: DbstatsRequest) => a.read(req);

  try {
    await c.run('privileges', '只读角色：权限自检通过，没有缺少的成员关系，事务默认只读', async () => {
      const r = await a.checkPrivileges();
      expectEq('ok', r.ok, true);
      expectEq('readable_tables', r.readable_tables, []);
      expectEq('missing', r.missing, []);
      expectEq('read_only', r.read_only, true);
      return `角色 ${r.role}`;
    });

    await c.run('no-business-rows', '只读角色对业务表 SELECT 返回权限错误（不变量 14）', async () => {
      const pg = await import('pg');
      const client = new pg.default.Client({
        host: pgsql.host,
        port: pgsql.port,
        user: CONFORMANCE_ROLE,
        password: pgsql.password,
        database: CONFORMANCE_DATABASE,
      });
      await client.connect();
      try {
        await client.query('SELECT * FROM orders LIMIT 1');
        throw new Error('只读角色读到了业务表 orders');
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== '42501') {
          throw err;
        }
        return 'permission denied（42501）';
      } finally {
        await client.end();
      }
    });

    await c.run('statements-top', 'statements.top：结构、排序、按库与 queryid 过滤、截断', async () => {
      const s = await read({
        op: 'statements.top',
        args: { order_by: 'total_exec_time', limit: 50, database: CONFORMANCE_DATABASE },
      });
      rowsValid('StatementRow', s);
      const totals = s.rows.map((r) => Number(r.total_exec_time_ms));
      expectEq(
        '按 total_exec_time 降序',
        [...totals].sort((x, y) => y - x),
        totals,
      );
      const slow = s.rows.find((r) => Number(r.calls) === 20 && Number(r.rows) === 20);
      if (!slow || slow.database !== CONFORMANCE_DATABASE || slow.role !== 'postgres') {
        throw new Error(`没有找到执行 20 次的报表语句：${JSON.stringify(s.rows.slice(0, 5))}`);
      }
      const one = await read({
        op: 'statements.top',
        args: { order_by: 'calls', limit: 5, queryids: [String(slow.queryid)] },
      });
      expectEq(
        '按 queryid 过滤',
        one.rows.map((r) => r.queryid),
        [slow.queryid],
      );
      const other = await read({ op: 'statements.top', args: { order_by: 'calls', limit: 5, database: 'nope' } });
      expectEq('别的库没有语句', other.rows.length, 0);
      const top1 = await read({ op: 'statements.top', args: { order_by: 'calls', limit: 1 } });
      expectEq('limit 1 截断', [top1.rows.length, top1.truncated], [1, true]);
      return `${s.rows.length} 条语句，服务端 ${s.server_version}`;
    });

    await c.run('statements-text', 'statements.text：规范化（常量为 $n、去掉注释）与指纹', async () => {
      const top = await read({
        op: 'statements.top',
        args: { order_by: 'calls', limit: 50, database: CONFORMANCE_DATABASE },
      });
      const queryids = top.rows.map((r) => String(r.queryid)).slice(0, 10) as [string, ...string[]];
      const s = await read({ op: 'statements.text', args: { queryids } });
      rowsValid('StatementText', s);
      const report = s.rows.find((r) => typeof r.text === 'string' && r.text.includes('count(*)'));
      if (!report) {
        throw new Error(`没有报表语句的文本：${JSON.stringify(s.rows)}`);
      }
      const text = String(report.text);
      if (text.includes('/*') || text.includes('--') || text.includes("'open'") || !text.includes('$1')) {
        throw new Error(`规范化不完整：${text}`);
      }
      const expected = await statementFingerprint(SLOW);
      expectEq('指纹与带常量和注释的原句相同', report.fingerprint, expected);
      const n = await normalizeStatement(SLOW);
      expectEq('规范化结果与 normalizeStatement 相同', report.fingerprint, n.fingerprint);
      return text;
    });

    await c.run('tables-top', 'tables.top：表统计与 statio 合并，按顺序扫描排序', async () => {
      const s = await read({ op: 'tables.top', args: { order_by: 'seq_scan', limit: 10 } });
      rowsValid('TableRow', s);
      const orders = s.rows.find((r) => r.table === 'orders' && r.schema === 'public');
      if (!orders || Number(orders.seq_scan) < 20 || orders.hypertable !== false || orders.chunks !== 0) {
        throw new Error(`orders 的统计不对：${JSON.stringify(orders)}`);
      }
      const w = await read({ op: 'tables.top', args: { order_by: 'writes', limit: 1 } });
      expectEq('writes 排序取 orders', w.rows[0]?.table, 'orders');
      return `orders 顺序扫描 ${String(orders.seq_scan)} 次`;
    });

    await c.run('indexes-usage', 'indexes.usage：大小、唯一与主键标记，按表过滤', async () => {
      const s = await read({ op: 'indexes.usage', args: { table: 'public.orders', limit: 10 } });
      rowsValid('IndexRow', s);
      const byName = Object.fromEntries(s.rows.map((r) => [String(r.index), r]));
      expectEq('索引', Object.keys(byName).sort(), ['orders_customer', 'orders_pkey', 'orders_status_id']);
      expectEq('主键', [byName.orders_pkey!.primary, byName.orders_pkey!.unique], [true, true]);
      expectEq('唯一索引', [byName.orders_status_id!.unique, byName.orders_status_id!.primary], [true, false]);
      if (!(Number(byName.orders_customer!.idx_scan) >= 20) || !(Number(byName.orders_customer!.size_bytes) > 0)) {
        throw new Error(`orders_customer 的统计不对：${JSON.stringify(byName.orders_customer)}`);
      }
      const none = await read({ op: 'indexes.usage', args: { table: 'public.nope', limit: 10 } });
      expectEq('别的表没有索引', none.rows.length, 0);
      return `${s.rows.length} 个索引`;
    });

    await c.run('settings-get', 'settings.get：取值、context 与是否需要重启', async () => {
      const s = await read({ op: 'settings.get', args: { names: ['work_mem', 'shared_buffers', 'no_such_setting'] } });
      rowsValid('SettingRow', s);
      const by = Object.fromEntries(s.rows.map((r) => [String(r.name), r]));
      expectEq('只返回存在的参数', Object.keys(by).sort(), ['shared_buffers', 'work_mem']);
      expectEq('context', [by.work_mem!.context, by.shared_buffers!.context], ['user', 'postmaster']);
      // 角色级设置 work_mem = 4MB
      expectEq('work_mem', [by.work_mem!.setting, by.work_mem!.unit], ['4096', 'kB']);
      return 'work_mem 4096 kB';
    });

    await c.run('activity-locks', 'activity.summary 与 locks.summary：计数，不含语句文本', async () => {
      const act = await read({ op: 'activity.summary', args: {} });
      rowsValid('ActivityRow', act);
      const max = act.rows.find((r) => r.state === 'max_connections');
      expectEq('max_connections', max?.count, 40);
      const locks = await read({ op: 'locks.summary', args: {} });
      rowsValid('LockRow', locks);
      return `${act.rows.length} 个会话分组，${locks.rows.length} 个锁分组`;
    });

    await c.run('two-samples', '两次采样：计数器的差值等于两次采样之间的工作负载', async () => {
      const req: DbstatsRequest = {
        op: 'statements.top',
        args: { order_by: 'calls', limit: 50, database: CONFORMANCE_DATABASE },
      };
      const { previous, current } = await a.sampleTwice(req, 10, async () => workload(pgsql, 7));
      const key = (r: DbstatsSample['rows'][number]) => `${String(r.queryid)}/${String(r.role)}`;
      const before = new Map(previous.rows.map((r) => [key(r), Number(r.calls)]));
      const slow = current.rows.find((r) => before.get(key(r)) === 20);
      if (!slow) {
        throw new Error('第二次采样中没有报表语句');
      }
      expectEq('报表语句的调用增量', Number(slow.calls) - before.get(key(slow))!, 7);
      if (Date.parse(current.sampled_at) <= Date.parse(previous.sampled_at)) {
        throw new Error('第二次采样的时间不晚于第一次');
      }
      return '增量 7';
    });

    await c.run('limits', '每小时上限：超过时查询不发出，语句文本另有上限', async () => {
      const limited = adapter({ hourly_limit: 2, text_hourly_limit: 1 });
      try {
        await limited.read({ op: 'statements.text', args: { queryids: ['1'] } });
        await expectReject(
          '语句文本第二次',
          () => limited.read({ op: 'statements.text', args: { queryids: ['1'] } }),
          'DbstatsLimitExceeded',
        );
        await limited.read({ op: 'locks.summary', args: {} });
        await expectReject('第三次查询', () => limited.read({ op: 'locks.summary', args: {} }), 'DbstatsLimitExceeded');
        expectEq('计数', limited.queriesThisHour, 2);
        return '2 次后拒绝';
      } finally {
        await limited.close();
      }
    });

    await c.run('fixed-operations', '只接受契约中的操作与参数：原始 SQL 与注入的排序列被拒绝', async () => {
      await expectReject(
        '原始 SQL',
        () => a.read({ op: 'sql', args: { query: 'SELECT * FROM orders' } } as unknown as DbstatsRequest),
        'DatasourceError',
      );
      await expectReject(
        '注入的排序列',
        () =>
          a.read({
            op: 'tables.top',
            args: { order_by: 'seq_scan; DROP TABLE orders', limit: 1 },
          } as unknown as DbstatsRequest),
        'DatasourceError',
      );
      return '拒绝';
    });

    await c.run('over-privileged', '额外授予业务表 SELECT 之后集成降级为不可用（不变量 14）', async () => {
      await pgsql.exec(CONFORMANCE_DATABASE, [`GRANT SELECT ON orders TO ${CONFORMANCE_ROLE}`]);
      const b = adapter();
      try {
        await expectReject('授予之后的读取', () => b.read({ op: 'locks.summary', args: {} }), 'CapabilityUnavailable');
        const r = b.privileges!;
        expectEq('ok', r.ok, false);
        expectEq('readable_tables', r.readable_tables, ['public.orders']);
        expectEq('没有发出统计查询', b.queriesThisHour, 0);
        const v = await b.verify();
        expectEq(
          'verify 全部不可用',
          Object.values(v).every((x) => !x.ok),
          true,
        );
      } finally {
        await b.close();
        await pgsql.exec(CONFORMANCE_DATABASE, [`REVOKE SELECT ON orders FROM ${CONFORMANCE_ROLE}`]);
      }
      if (!reports.some((x) => (x as { ok: boolean }).ok === false)) {
        throw new Error('onPrivilegeReport 没有收到 ok 为 false 的报告');
      }
      return 'DatasourceOverPrivileged';
    });

    await c.run('verify', 'verify：权限正常时每项能力可用', async () => {
      const v = await a.verify();
      const bad = Object.entries(v).filter(([, x]) => !x.ok);
      expectEq('不可用的能力', bad, []);
      return `${Object.keys(v).length} 项能力`;
    });
  } finally {
    await a.close();
  }
  return c.report();
}
