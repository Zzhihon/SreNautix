import { randomUUID } from 'node:crypto';
import type { TopologyEvent, TopologyNode } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { Auth } from '../../src/identity/auth.js';
import { Bindings } from '../../src/identity/bindings.js';
import { CallerRegistry, tokenDigest } from '../../src/identity/callers.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { Sessions } from '../../src/identity/sessions.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { ReaderProtocol } from '../../src/topology/protocol.js';
import {
  expireReaderConditions,
  ReaderClock,
  ReaderRequestQueue,
  ReaderRequestTimeout,
  registerReaderRoutes,
  type AlertReconcileSnapshot,
} from '../../src/topology/reader-routes.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

const TOKEN = 'reader-token-prod-0123456789abcdef';
const OTHER = 'reader-token-dev-0123456789abcdef';
const H = (token = TOKEN, cluster = 'prod') => ({
  authorization: `Bearer ${token}`,
  'x-srenautix-cluster': cluster,
  'content-type': 'application/json',
});

let db: TestDb;
let app: FastifyInstance;
let store: TopologyStore;
let queue: ReaderRequestQueue;
const clock = new ReaderClock();
const snapshots: Array<{ cluster: string; s: AlertReconcileSnapshot }> = [];

const node = (name: string, labels: Record<string, string> = {}): TopologyNode => ({
  key: `Pod:shop/${name}`,
  kind: 'Pod',
  namespace: 'shop',
  name,
  uid: `uid-${name}`,
  labels,
  component_type: null,
  hub: false,
});

const event = (seq: number, op: TopologyEvent['op'], n: TopologyNode, at: string): TopologyEvent => ({
  event_id: randomUUID(),
  cluster_id: 'prod',
  seq,
  op,
  valid_from: at,
  valid_to: op.endsWith('_delete') ? at : null,
  source: 'informer',
  node: n,
  edge: null,
});

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack, topologyTrack]);
  store = new TopologyStore(db.server);
  const protocol = new ReaderProtocol();
  queue = new ReaderRequestQueue(db.server, protocol);
  const callers = new CallerRegistry([
    { id: 'reader-prod', kind: 'spoke', role: 'reader', cluster_id: 'prod', token_sha256: tokenDigest(TOKEN) },
    { id: 'gateway-dev', kind: 'spoke', role: 'gateway', cluster_id: 'dev', token_sha256: tokenDigest(OTHER) },
  ]);
  const auth = new Auth(
    new Sessions(db.server, { idleMs: 60_000, absoluteMs: 3_600_000 }),
    callers,
    new Bindings([], 'test'),
    'https://console.test',
  );
  app = await createApp({ bodyLimit: 8 << 20, trustProxy: false });
  registerReaderRoutes(app, {
    pool: db.server,
    auth,
    store,
    protocol,
    requests: queue,
    clock,
    onAlertSnapshot: async (cluster, s) => {
      snapshots.push({ cluster, s });
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('鉴权', () => {
  it('集群请求头与 token 不一致时 403，gateway 的 token 不能调用 reader 协议', async () => {
    const hello = { reader_id: 'reader-0', version: '0.1.0', boot_id: randomUUID() };
    const a = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/hello',
      headers: H(TOKEN, 'dev'),
      payload: hello,
    });
    expect(a.statusCode).toBe(403);
    expect(a.json()).toMatchObject({ code: 'cluster_mismatch' });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/hello',
      headers: H(OTHER, 'dev'),
      payload: hello,
    });
    expect(b.statusCode).toBe(403);
    const c = await app.inject({ method: 'POST', url: '/v1/spoke/reader/hello', headers: H('nope'), payload: hello });
    expect(c.statusCode).toBe(401);
  });

  it('请求体不符合协议时 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/hello',
      headers: H(),
      payload: { reader_id: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('bad_request');
  });
});

describe('拓扑同步', () => {
  it('hello 返回已接受的序号与中心时间', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/hello',
      headers: H(),
      payload: { reader_id: 'reader-0', version: '0.1.0', boot_id: randomUUID() },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ topology_seq: 0, restored_at: null });
    expect(r.json().server_time).toMatch(/Z$/);
  });

  it('事件按序应用；重复推送不产生新变更；seq 不连续返回 409', async () => {
    const e1 = event(1, 'node_upsert', node('api-1'), '2026-10-20T01:00:00Z');
    const e2 = event(2, 'node_upsert', node('api-2'), '2026-10-20T01:00:05Z');
    const r = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/topology/events',
      headers: H(),
      payload: { events: [e2, e1] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ topology_seq: 2, complete: true });
    const v1 = await store.version('prod');
    const again = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/topology/events',
      headers: H(),
      payload: { events: [e1, e2] },
    });
    expect(again.json().topology_seq).toBe(2);
    expect(await store.version('prod')).toBe(v1);
    const gap = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/topology/events',
      headers: H(),
      payload: { events: [event(5, 'node_upsert', node('api-5'), '2026-10-20T01:01:00Z')] },
    });
    expect(gap.statusCode).toBe(409);
    expect(gap.json().code).toBe('topology_seq_gap');
    const del = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/topology/events',
      headers: H(),
      payload: { events: [event(3, 'node_delete', node('api-1'), '2026-10-20T01:02:00Z')] },
    });
    expect(del.json().topology_seq).toBe(3);
    const before = await store.at('prod', new Date('2026-10-20T01:01:00Z'));
    expect(before.nodes.map((n) => n.name).sort()).toEqual(['api-1', 'api-2']);
    const after = await store.at('prod', new Date('2026-10-20T01:03:00Z'));
    expect(after.nodes.map((n) => n.name)).toEqual(['api-2']);
  });

  it('快照分段到齐后一次应用：快照外的节点在 taken_at 关闭，内容相同的节点不产生新事件', async () => {
    const id = randomUUID();
    const taken = '2026-10-20T02:00:00Z';
    const part = (p: number, nodes: TopologyNode[]) => ({
      snapshot_id: id,
      seq: 10,
      taken_at: taken,
      part: p,
      parts: 2,
      nodes: nodes.map((n) => ({ node: n, valid_from: '2026-10-20T01:59:00Z' })),
      edges: [],
    });
    const v0 = await store.version('prod');
    const a = await app.inject({
      method: 'PUT',
      url: '/v1/spoke/reader/topology/snapshot',
      headers: H(),
      payload: part(1, [node('api-2')]),
    });
    expect(a.json()).toMatchObject({ complete: false, topology_seq: 3 });
    const b = await app.inject({
      method: 'PUT',
      url: '/v1/spoke/reader/topology/snapshot',
      headers: H(),
      payload: part(2, [node('api-3', { app: 'api' })]),
    });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ complete: true, topology_seq: 10 });
    // api-2 内容未变不产生事件；api-3 新增一条
    expect(await store.version('prod')).toBe(v0 + 1);
    const now = await store.at('prod', new Date('2026-10-20T02:00:01Z'));
    expect(now.nodes.map((n) => n.name).sort()).toEqual(['api-2', 'api-3']);
    const behind = await app.inject({
      method: 'PUT',
      url: '/v1/spoke/reader/topology/snapshot',
      headers: H(),
      payload: { ...part(1, []), snapshot_id: randomUUID(), seq: 4, parts: 1 },
    });
    expect(behind.statusCode).toBe(409);
    const later = await app.inject({
      method: 'PUT',
      url: '/v1/spoke/reader/topology/snapshot',
      headers: H(),
      payload: {
        ...part(1, [node('api-3', { app: 'api' })]),
        snapshot_id: randomUUID(),
        seq: 11,
        parts: 1,
        taken_at: '2026-10-20T02:10:00Z',
      },
    });
    expect(later.json()).toMatchObject({ complete: true, topology_seq: 11 });
    const gone = await store.at('prod', new Date('2026-10-20T02:10:01Z'));
    expect(gone.nodes.map((n) => n.name)).toEqual(['api-3']);
    expect(await store.find('prod', 'Pod', 'shop', 'api-2', new Date('2026-10-20T02:20:00Z'))).toMatchObject({
      tombstone: true,
    });
  });

  it('中心从备份恢复后，事件返回 409 resync_required，直到 reader 重新上传快照', async () => {
    await db.server.query("INSERT INTO server.system_state (key, value) VALUES ('restored_at', to_jsonb(now()))");
    const r = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/topology/events',
      headers: H(),
      payload: { events: [event(12, 'node_upsert', node('api-9'), '2026-10-20T03:00:00Z')] },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('resync_required');
    const s = await app.inject({
      method: 'PUT',
      url: '/v1/spoke/reader/topology/snapshot',
      headers: H(),
      payload: {
        snapshot_id: randomUUID(),
        seq: 11,
        taken_at: '2026-10-20T03:00:00Z',
        part: 1,
        parts: 1,
        nodes: [],
        edges: [],
      },
    });
    expect(s.json()).toMatchObject({ complete: true, topology_seq: 11 });
    expect(s.json().restored_at).toMatch(/Z$/);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/topology/events',
      headers: H(),
      payload: { events: [event(12, 'node_upsert', node('api-9'), '2026-10-20T03:00:00Z')] },
    });
    expect(ok.statusCode).toBe(200);
    await db.server.query("DELETE FROM server.system_state WHERE key = 'restored_at'");
  });
});

describe('告警对账与心跳', () => {
  it('告警快照原样交给接入层（含 error 与 truncated）', async () => {
    const snap: AlertReconcileSnapshot = {
      cluster_id: 'prod',
      taken_at: '2026-10-20T04:00:00Z',
      alertmanager: { status: 'error', error: 'connection refused', truncated: false, items: [] },
      rules: {
        status: 'ok',
        truncated: true,
        items: [{ labels: { alertname: 'X' }, state: 'firing', active_at: '2026-10-20T03:59:00Z' }],
      },
    };
    const r = await app.inject({ method: 'POST', url: '/v1/spoke/reader/alerts', headers: H(), payload: snap });
    expect(r.statusCode).toBe(200);
    expect(snapshots.at(-1)).toEqual({ cluster: 'prod', s: snap });
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/alerts',
      headers: H(),
      payload: { ...snap, cluster_id: 'dev' },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it('心跳记录状态与条件，apiserver 时钟随单调时长前进', async () => {
    const apiserver = '2030-01-01T00:00:00Z';
    const r = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/heartbeat',
      headers: H(),
      payload: {
        reader_id: 'reader-0',
        version: '0.1.0',
        boot_id: randomUUID(),
        topology_seq: 12,
        conditions: [
          { type: 'InformersFresh', status: 'True', reason: 'Synced', since: '2026-10-20T00:00:00Z' },
          {
            type: 'Datasource',
            status: 'False',
            reason: 'Unreachable',
            message: 'prometheus 超时',
            since: '2026-10-20T00:10:00Z',
          },
        ],
        clock: {
          apiserver_time: apiserver,
          offset_seconds: 0.4,
          uncertainty_seconds: 0.01,
          measured_at: '2026-10-20T04:00:00Z',
        },
        query_manifest: null,
      },
    });
    expect(r.statusCode).toBe(200);
    const c = await db.server.query(
      "SELECT type, status FROM server.conditions WHERE role = 'reader' AND cluster_id = 'prod' ORDER BY type",
    );
    expect(c.rows).toEqual([
      { type: 'Datasource', status: 'true' },
      { type: 'InformersFresh', status: 'false' },
    ]);
    await new Promise((res) => setTimeout(res, 50));
    const t = clock.apiserverNow('prod') as Date;
    expect(t.getTime()).toBeGreaterThanOrEqual(new Date(apiserver).getTime() + 40);
    expect(clock.offset('prod')).toEqual({ offsetSeconds: 0.4, uncertaintySeconds: 0.01 });
    expect(clock.apiserverNow('dev')).toBeNull();
  });
});

describe('读取请求', () => {
  const query = {
    datasource: 'prometheus',
    template_id: 'kubernetes-core/pod_restarts',
    content_hash: `sha256:${'a'.repeat(64)}`,
    params: { namespace: 'shop', pod: 'api-3' },
    time: '2026-10-20T04:00:00Z',
  };
  const result = (id: string) => ({
    request_id: id,
    kind: 'query',
    query: {
      status: 'ok',
      series: [{ labels: { pod: 'api-3' }, samples: [{ t: 1, v: '3' }] }],
      truncated: false,
      clamped: [],
      warnings: [],
      executed_at: '2026-10-20T04:00:01Z',
      duration_ms: 12,
    },
  });

  it('长轮询领取请求，回传结果后 request() 返回；重复回传按重复处理', async () => {
    const pending = queue.request('prod', 'query', query, 10_000);
    const pulled = await app.inject({ method: 'GET', url: '/v1/spoke/reader/requests?wait=5&max=5', headers: H() });
    expect(pulled.statusCode).toBe(200);
    const reqs = pulled.json().requests as Array<{ request_id: string; kind: string; query: unknown }>;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ kind: 'query', query });
    const id = (reqs[0] as { request_id: string }).request_id;
    const empty = await app.inject({ method: 'GET', url: '/v1/spoke/reader/requests?wait=0', headers: H() });
    expect(empty.json().requests).toEqual([]);
    const done = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/results',
      headers: H(),
      payload: { results: [result(id)] },
    });
    expect(done.json()).toEqual({ accepted: [id], duplicates: [] });
    expect(await pending).toMatchObject({ request_id: id, query: { status: 'ok' } });
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/spoke/reader/results',
      headers: H(),
      payload: { results: [result(id)] },
    });
    expect(dup.json()).toEqual({ accepted: [], duplicates: [id] });
  });

  it('等待中的长轮询在新请求写入时立即返回', async () => {
    const started = Date.now();
    const poll = app.inject({ method: 'GET', url: '/v1/spoke/reader/requests?wait=10', headers: H() });
    await new Promise((r) => setTimeout(r, 200));
    const id = await queue.enqueue(
      'prod',
      'resolve',
      { pod_ip: '10.0.0.7', at: '2026-10-20T04:00:00Z' },
      new Date(Date.now() + 60_000),
    );
    const r = await poll;
    expect(r.json().requests.map((x: { request_id: string }) => x.request_id)).toEqual([id]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('参数不符合协议时拒绝写入；过了 deadline 没有结果时 request() 失败，且请求不再下发', async () => {
    await expect(queue.enqueue('prod', 'query', { datasource: 'x' }, new Date(Date.now() + 1000))).rejects.toThrow(
      /参数不合法/,
    );
    await expect(queue.request('dev', 'query', query, 300)).rejects.toThrow(ReaderRequestTimeout);
    const r = await db.server.query(
      "SELECT count(*)::int AS n FROM server.reader_requests WHERE cluster_id = 'dev' AND deadline > now()",
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe('reader 离线时的状态条件', () => {
  const readerRows = async (cluster: string) =>
    (
      await db.admin.query<{ type: string; status: string; reason: string }>(
        "SELECT type, status, reason FROM server.conditions WHERE role = 'reader' AND cluster_id = $1 ORDER BY type",
        [cluster],
      )
    ).rows.map((r) => [r.type, r.status, r.reason]);
  const seed = async (cluster: string, ageS: number) => {
    await db.admin.query(
      `INSERT INTO server.reader_status (cluster_id, reader_id, version, boot_id, topology_seq, conditions, clock, received_at)
       VALUES ($1, 'r1', '0.1.0', gen_random_uuid(), 1, '[]', '{}', now() - make_interval(secs => $2))
       ON CONFLICT (cluster_id) DO UPDATE SET received_at = excluded.received_at`,
      [cluster, ageS],
    );
    for (const [type, status, reason] of [
      ['QueryManifest', 'true', 'NotMounted'],
      ['InformersFresh', 'false', 'Synced'],
      ['TunnelConnected', 'false', 'Connected'],
    ]) {
      await db.admin.query(
        `INSERT INTO server.conditions (role, cluster_id, type, subject, status, reason, message, since, updated_at)
         VALUES ('reader', $1, $2, '', $3, $4, '', now(), now())
         ON CONFLICT (role, cluster_id, type, subject) DO UPDATE SET status = excluded.status, reason = excluded.reason`,
        [cluster, type, status, reason],
      );
    }
  };

  it('心跳超时：清除 reader 之前上报的条件，只留"reader 离线"；心跳恢复后被新的条件覆盖', async () => {
    await seed('east', 10);
    expect(await expireReaderConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false })).toBe(0);
    expect(await readerRows('east')).toHaveLength(3);
    await seed('east', 300);
    await expireReaderConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false });
    expect(await readerRows('east')).toEqual([['TunnelConnected', 'true', 'ReaderOffline']]);
    // 再跑一轮不重复、不改动
    expect(await expireReaderConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false })).toBe(0);
    const msg = await db.admin.query<{ message: string }>(
      "SELECT message FROM server.conditions WHERE role = 'reader' AND cluster_id = 'east'",
    );
    expect(msg.rows[0]?.message).toMatch(/reader 已离线：自 .* 起没有心跳（超过 60 秒）/);
    // reader 恢复：心跳写入新的条件，覆盖离线
    await seed('east', 0);
    expect(await readerRows('east')).toEqual([
      ['InformersFresh', 'false', 'Synced'],
      ['QueryManifest', 'true', 'NotMounted'],
      ['TunnelConnected', 'false', 'Connected'],
    ]);
  });

  it('本集群的拓扑不经 reader（reader 已关闭）：reader 的条件全部清除，不显示离线', async () => {
    await seed('hub', 300);
    await expireReaderConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false });
    expect(await readerRows('hub')).toEqual([]);
    // 本集群使用 reader 时显示离线
    await seed('hub', 300);
    await expireReaderConditions(db.server, 60_000, { clusterId: 'hub', usesReader: true });
    expect(await readerRows('hub')).toEqual([['TunnelConnected', 'true', 'ReaderOffline']]);
  });
});
