import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Alert, ChangeEvent, Incident, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { DEFAULT_RCA_PARAMS } from '@srenautix/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { changesInWindow, ChangesService } from '../../src/changes/service.js';
import type { SqlAuditSourceConfig } from '../../src/changes/sql-audit.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { alertsById } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { incidentBook } from '../../src/research/incident.js';
import { incidentSegments } from '../../src/research/prompt.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { timeline } from '../../src/stage-a/report.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { researchCase } from '../support/scenario.js';

// SQL 审计表变更源（ADR 0151）经真实 PostgreSQL：
// - 业务库里的审计表开启 FORCE ROW LEVEL SECURITY，只读角色只能执行一个函数（属主是超级用户，SECURITY DEFINER，
//   按时间窗只返回导出目标的记录与需要的列；函数体是动态查询，不阻止业务的迁移删改审计表的列）；
// - 一次“停用导出”的审计记录同步成 runtime_config 变更，进入事件收敛与根因排序：发生在 gateway 症状之前 10 分钟，
//   根因候选由节点变为 gateway，变更出现在事件与阶段 A 时间线里；
// - 停用之后 1 分钟又启用（往返）、晚于症状的停用都不改变根因；往返出现之后，已经写入的停用变更被删除；
// - 角色另外能读取业务表时不读取，变更源状态记下原因。

const C = 'c1';
const GATEWAY = 'StatefulSet:shop/gateway';
const NODE = 'Node:node-a';
const metrics = new ServerMetrics('server', false);

let db: TestDb;
let biz: pg.Pool;
let bizName: string;
let role: string;
let pwFile: string;
let engine: IncidentEngine;
let kicks = 0;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

const topoNode = (key: string): TopologyNode => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { key, kind, namespace: ns, name: name!, uid: `uid-${key}`, labels: {}, component_type: null, hub: false };
};
const topoEdge = (from: string, to: string, relation: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: relation === 'runs_on' ? 'instance' : 'service',
  evidence: 't',
});

async function insertAlert(a: {
  alertname: string;
  role: 'cause' | 'symptom';
  severity: 'critical' | 'warning';
  component: string;
  startsAt: Date;
}): Promise<string> {
  const fp = randomUUID().replace(/-/g, '').slice(0, 16);
  const id = `${fp}@${Math.floor(a.startsAt.getTime() / 1000)}`;
  const [kind, rest] = a.component.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  await db.server.query(
    `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status,
       suppressed, starts_at, ends_at, classification, entity, entity_resolution, component, received_at, last_seen_at, updated_at)
     VALUES ($1, $2, $3, 'alertmanager', $4, $5, '{}', $6, 'firing', 'none', $7, NULL, $8, $9, 'labels', $10, now(), now(), now())`,
    [
      id,
      C,
      fp,
      a.alertname,
      JSON.stringify({ alertname: a.alertname, severity: a.severity }),
      a.severity,
      a.startsAt,
      JSON.stringify({ role: a.role, source: 'label', confidence: 1, catalog_entry: null, chronic: false }),
      JSON.stringify({ cluster_id: C, kind, namespace: ns, name, uid: null }),
      a.component,
    ],
  );
  return id;
}

/** 导出目标改动之后的样子：version 每次改动递增，视图里去掉 */
const target = (name: string, enabled: boolean, version: number) => ({ name, kind: 's3', enabled, version });

/** 业务库的审计表：resource_type 区分资源，payload 是变更之后的资源（含每次递增的 version） */
async function audit(
  id: number,
  at: Date,
  resource: string,
  action: string,
  payload: Record<string, unknown>,
  type = 'export_target',
): Promise<void> {
  await biz.query(
    `INSERT INTO public.admin_audit_log (id, occurred_at, resource_type, resource_id, action, actor_id, payload, ip_address)
     VALUES ($1, $2, $3, $4, $5, 'ops-1', $6, '203.0.113.7')`,
    [id, at, type, resource, action, JSON.stringify(payload)],
  );
}

const source = (): SqlAuditSourceConfig => ({
  id: 'app-db',
  connection: {
    host: '127.0.0.1',
    port: inject('pgPort'),
    database: bizName,
    user: role,
    password_file: pwFile,
    ssl: false,
  },
  group_within: '2m',
  queries: [
    {
      id: 'export-targets',
      table: 'audit.export_target_changes',
      function: true,
      key: 'id',
      time: 'occurred_at',
      object: 'target_id',
      action: 'action',
      actor: 'actor_id',
      value: 'state',
      details: ['name'],
      components: [{ match: {}, targets: [GATEWAY] }],
    },
  ],
});

let changes: ChangesService;

async function incident(): Promise<Incident> {
  await engine.recompute(C);
  const r = await db.server.query<{ body: Incident }>(
    "SELECT body FROM server.incidents WHERE cluster_id = $1 AND state = 'firing' ORDER BY first_firing_at",
    [C],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!.body;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const port = inject('pgPort');
  const password = inject('pgPassword');
  const suffix = randomBytes(5).toString('hex');
  bizName = `biz_${suffix}`;
  role = `audit_reader_${suffix}`;
  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${bizName}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await admin.end();
  biz = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: bizName, max: 2 });
  for (const s of [
    `CREATE TABLE public.admin_audit_log (id bigint PRIMARY KEY, occurred_at timestamptz NOT NULL, resource_type text NOT NULL,
       resource_id text NOT NULL, action text NOT NULL, actor_id text, payload jsonb NOT NULL, ip_address text)`,
    'ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.admin_audit_log FORCE ROW LEVEL SECURITY',
    'CREATE TABLE public.orders (id int PRIMARY KEY, total numeric)',
    'CREATE SCHEMA audit',
    'REVOKE ALL ON SCHEMA audit FROM PUBLIC',
    `CREATE FUNCTION audit.export_target_changes(from_at timestamptz, to_at timestamptz)
       RETURNS TABLE (id bigint, occurred_at timestamptz, target_id text, action text, actor_id text, state jsonb, name text)
       LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
       BEGIN
         RETURN QUERY EXECUTE
           'SELECT id, occurred_at, resource_id, action, actor_id, payload - ''version'', payload ->> ''name''
              FROM public.admin_audit_log
             WHERE resource_type = ''export_target'' AND occurred_at >= $1 AND occurred_at <= $2'
           USING from_at, to_at;
       END $fn$`,
    'REVOKE ALL ON FUNCTION audit.export_target_changes(timestamptz, timestamptz) FROM PUBLIC',
    `GRANT USAGE ON SCHEMA audit TO ${role}`,
    `GRANT EXECUTE ON FUNCTION audit.export_target_changes(timestamptz, timestamptz) TO ${role}`,
  ]) {
    await biz.query(s);
  }
  const scratch = resolve(import.meta.dirname, '../../../../.scratch');
  mkdirSync(scratch, { recursive: true });
  pwFile = join(scratch, `sql-audit-pw-${process.pid}-${suffix}`);
  writeFileSync(pwFile, password, { mode: 0o600 });

  // gateway 的 Pod 运行在 node-a 上
  const topology = new TopologyStore(db.server);
  const at = minutesAgo(24 * 60);
  await topology.apply(C, [
    ...[GATEWAY, 'Pod:shop/gateway-0', NODE].map((k) => ({
      op: 'node_upsert' as const,
      at,
      source: 'informer' as const,
      node: topoNode(k),
    })),
    ...[topoEdge('Pod:shop/gateway-0', GATEWAY, 'owned_by'), topoEdge('Pod:shop/gateway-0', NODE, 'runs_on')].map(
      (e) => ({ op: 'edge_upsert' as const, at, source: 'informer' as const, edge: e }),
    ),
  ]);
  engine = new IncidentEngine({
    pool: db.server,
    topology,
    params: () => DEFAULT_RCA_PARAMS,
    changes: (clusterId, from, to) => changesInWindow(db.server, clusterId, from, to),
    probes: async () => [],
    stale: { markStale: async () => 0 },
    metrics,
    suppressedAlerts: async () => new Map<string, string>(),
  });
  // 15 分钟前 gateway 开始淘汰未导出的记录；12 分钟前 node-a 的磁盘告警（cause）开始
  await insertAlert({
    alertname: 'ArchiveEvictedUnexported',
    role: 'symptom',
    severity: 'critical',
    component: GATEWAY,
    startsAt: minutesAgo(15),
  });
  await insertAlert({
    alertname: 'NodeFilesystemAlmostFull',
    role: 'cause',
    severity: 'warning',
    component: NODE,
    startsAt: minutesAgo(12),
  });
  changes = new ChangesService(
    db.server,
    [],
    { github: null, defaultClusterId: C, sqlAudit: [source()] },
    24 * 3600_000,
    () => kicks++,
  );
}, 120_000);

afterAll(async () => {
  await changes?.close();
  await biz?.end();
  rmSync(pwFile, { force: true });
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: inject('pgPort'),
    user: 'postgres',
    password: inject('pgPassword'),
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${bizName} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
  await db?.close();
});

describe('SQL 审计表变更源（ADR 0151）', () => {
  it('没有审计变更时，根因是先报 cause 的节点', async () => {
    const inc = await incident();
    expect(inc.root.component).toBe(NODE);
    expect(inc.changes).toEqual([]);
  });

  it('一次停用导出同步成 runtime_config 变更，进入事件与阶段 A 时间线，gateway 成为排在第一的根因候选', async () => {
    // 3 小时前建了两个导出目标；25 分钟前停用 archive-a（gateway 的症状在 10 分钟之后出现）；
    // archive-b 在 50 分钟前停用、49 分钟前启用（往返）；同一张审计表里其他资源的记录不在视图里
    await audit(1, minutesAgo(180), 'dst-a', 'export_target.create', target('archive-a', true, 1));
    await audit(2, minutesAgo(179), 'dst-b', 'export_target.create', target('archive-b', true, 1));
    await audit(3, minutesAgo(50), 'dst-b', 'export_target.update', target('archive-b', false, 2));
    await audit(4, minutesAgo(49), 'dst-b', 'export_target.update', target('archive-b', true, 3));
    await audit(5, minutesAgo(25), 'dst-a', 'export_target.update', target('archive-a', false, 2));
    await audit(6, minutesAgo(20), 'u-1', 'user.login', { name: 'someone' }, 'user');

    expect(await changes.syncOnce()).toEqual({ 'app-db': 3 });
    expect(kicks).toBe(1);
    const stored = await changesInWindow(db.server, C, minutesAgo(24 * 60), new Date());
    expect(stored.map((c) => [c.change_id, c.kind, c.targets])).toEqual([
      ['app-db:export-targets:1', 'runtime_config', [GATEWAY]],
      ['app-db:export-targets:2', 'runtime_config', [GATEWAY]],
      ['app-db:export-targets:5', 'runtime_config', [GATEWAY]],
    ]);
    const disable = stored[2] as ChangeEvent;
    expect(disable).toMatchObject({
      source: 'app-db',
      refs: ['export-targets/dst-a', 'export_target.update'],
      actor: 'ops-1',
      summary: 'export_target.update export-targets/dst-a；enabled: true → false；name=archive-a',
    });
    // 再同步一次没有变化
    expect(await changes.syncOnce()).toEqual({ 'app-db': 0 });

    const inc = await incident();
    expect(inc.changes.map((c) => c.change_id)).toEqual(['app-db:export-targets:5']);
    expect(inc.root.component).toBe(GATEWAY);
    expect(inc.candidates.map((c) => [c.component, c.source])).toEqual([
      [GATEWAY, 'change'],
      [NODE, 'alert'],
    ]);
    expect(inc.candidates[0]!.terms.recent_change).toBe(1);
    const alerts: Alert[] = await alertsById(
      db.server,
      inc.members.map((m) => m.alert_id),
    );
    const line = timeline(inc, alerts, []).find((x) => x.kind === 'change');
    expect(line).toEqual({
      at: disable.time,
      kind: 'change',
      text: 'app-db runtime_config export-targets/dst-a export_target.update；关联分级 high（依据：component_match）',
      ref: 'change:1',
    });
    // 研判上下文：这次停用作为首要假设列出
    const rc = researchCase({ incident: inc, relatedChanges: [] });
    const texts = incidentSegments(rc, incidentBook(rc), 200_000, null).map((s) => s.text);
    const primary = texts.find((t) => t.includes('## 运行时配置变更（首要假设'));
    expect(primary).toContain('"ref":"change:1"');
    expect(primary).toContain('enabled: true → false');
    expect(primary).toContain('第一个假设（h1）必须以这些变更为原因提出');
  });

  it('停用之后 1 分钟又启用：往返不算变更，已经写入的停用被删除，根因回到节点；晚于症状的停用不参与排序', async () => {
    await audit(7, minutesAgo(24), 'dst-a', 'export_target.update', target('archive-a', true, 3));
    expect(await changes.syncOnce()).toEqual({ 'app-db': 1 });
    const stored = await changesInWindow(db.server, C, minutesAgo(24 * 60), new Date());
    expect(stored.map((c) => c.change_id)).toEqual(['app-db:export-targets:1', 'app-db:export-targets:2']);
    let inc = await incident();
    expect(inc.changes).toEqual([]);
    expect(inc.root.component).toBe(NODE);

    // 2 分钟前再次停用：晚于 gateway 症状开始 13 分钟，超过容差（ADR 0142），解释不了已经开始的问题
    await audit(8, minutesAgo(2), 'dst-a', 'export_target.update', target('archive-a', false, 4));
    expect(await changes.syncOnce()).toEqual({ 'app-db': 1 });
    inc = await incident();
    expect(inc.root.component).toBe(NODE);
    expect(inc.candidates.map((c) => c.component)).not.toContain(GATEWAY);
  });

  it('角色另外能读取业务表时不读取审计记录，变更源状态写明原因', async () => {
    await biz.query(`GRANT SELECT ON public.orders TO ${role}`);
    try {
      const strict = new ChangesService(
        db.server,
        [],
        { github: null, defaultClusterId: C, sqlAudit: [source()] },
        24 * 3600_000,
        () => kicks++,
      );
      try {
        expect(await strict.syncOnce()).toEqual({ 'app-db': null });
        const [status] = await strict.statuses();
        expect(status!.lastError).toMatch(/能读取声明之外的业务关系 public\.orders/);
      } finally {
        await strict.close();
      }
    } finally {
      await biz.query(`REVOKE SELECT ON public.orders FROM ${role}`);
    }
    // 角色读不到审计表本身（只能执行函数）：直接查询被拒绝，写入被只读事务拒绝
    const direct = new pg.Client({
      host: '127.0.0.1',
      port: inject('pgPort'),
      user: role,
      password: inject('pgPassword'),
      database: bizName,
    });
    await direct.connect();
    try {
      await expect(direct.query('SELECT count(*) FROM public.admin_audit_log')).rejects.toThrow(/permission denied/);
      await expect(direct.query('INSERT INTO public.orders VALUES (1, 1)')).rejects.toThrow(/read-only transaction/);
    } finally {
      await direct.end();
    }
  });

  it('业务的迁移删改审计表的列不被函数阻止（视图会阻止）；之后读取失败只记在变更源状态里', async () => {
    await biz.query(
      'CREATE VIEW audit.blocking_view AS SELECT id, actor_id FROM public.admin_audit_log WHERE resource_type = $$x$$',
    );
    await expect(biz.query('ALTER TABLE public.admin_audit_log DROP COLUMN actor_id')).rejects.toThrow(/depend on it/);
    await biz.query('DROP VIEW audit.blocking_view');
    await biz.query('ALTER TABLE public.admin_audit_log DROP COLUMN actor_id');
    expect(await changes.syncOnce()).toEqual({ 'app-db': null });
    const [status] = await changes.statuses();
    expect(status!.lastError).toMatch(/actor_id/);
  });
});
