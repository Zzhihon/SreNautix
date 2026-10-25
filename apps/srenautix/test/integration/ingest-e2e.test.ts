import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AlertCatalog } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { AlertmanagerAdditions, reconcileOnce } from '../../src/ingest/reconcile.js';
import { IngestService } from '../../src/ingest/service.js';
import { activeAlerts } from '../../src/ingest/store.js';
import { ingestTrack } from '../../src/ingest/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { startAlertmanager, startPrometheus, until, type Proc } from '../support/monitoring.js';

/**
 * 真实的 Prometheus → Alertmanager → webhook → server 接入链路，以及 60 秒对账（这里手动触发一轮）。
 * 第一次收到的 webhook 原文写入 .scratch/recorded/，用于更新 test/fixtures/alertmanager/ 下的录制夹具。
 */
const TOKEN = 'ingest-token-for-tests-0123456789';
const RULES = `groups:
  - name: demo
    rules:
      - alert: DemoPodCrashLooping
        expr: vector(1) > 0
        labels: {severity: critical, namespace: shop, pod: api-7d9f8-x2k4p}
        annotations: {summary: "api 重启", description: "容器 api 反复重启"}
      - alert: DemoErrorRatio
        expr: vector(0.2) > 0.05
        for: 2s
        labels: {severity: warning, namespace: shop, service: api}
        annotations: {summary: "错误率高"}
      - alert: Watchdog
        expr: vector(1)
        labels: {severity: none}
`;

let db: TestDb;
let app: FastifyInstance;
let am: Proc;
let prom: Proc;
let ingest: IngestService;
const metrics = new ServerMetrics('server', false);
const received: unknown[] = [];
const responses: string[] = [];

/** 链路上每一段看到的状态：Prometheus 的告警、Alertmanager 的告警、server 收到的 webhook 与两个进程的日志。 */
async function pipelineState(): Promise<string> {
  const get = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return `${r.status} ${(await r.text()).slice(0, 1500)}`;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  return [
    `Prometheus /api/v1/alerts：${await get(`${prom.url}/api/v1/alerts`)}`,
    `Prometheus /api/v1/alertmanagers：${await get(`${prom.url}/api/v1/alertmanagers`)}`,
    `Alertmanager /api/v2/alerts：${await get(`${am.url}/api/v2/alerts`)}`,
    `server 收到的 webhook：${received.length} 次，响应 ${responses.join('；') || '无'}`,
    prom.log(),
    am.log(),
  ].join('\n');
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, ingestTrack, topologyTrack]);
  const scratch = resolve(import.meta.dirname, '../../../../.scratch');
  const tokenFile = join(scratch, `ingest-token-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(tokenFile, TOKEN);
  const topo = new TopologyStore(db.server);
  ingest = new IngestService(
    db.server,
    [{ id: 'am', kind: 'alertmanager', token_file: tokenFile }],
    { clusterId: 'c1', selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: new AlertCatalog([]), nodes: topo, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  app = await createApp({ bodyLimit: 4 << 20, trustProxy: false });
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/ingest/')) {
      received.push(req.body);
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/v1/ingest/')) {
      responses.push(`${new Date().toISOString()} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
    }
  });
  ingest.registerRoutes(app);
  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  am = await startAlertmanager(`${addr}/v1/ingest/am`, TOKEN);
  prom = await startPrometheus(RULES, am.url);
});

afterAll(async () => {
  await prom?.stop();
  await am?.stop();
  await app?.close();
  await db?.close();
  rmSync(resolve(import.meta.dirname, '../../../../.scratch', `ingest-token-${process.pid}`), { force: true });
});

describe('接入链路', () => {
  it('Alertmanager 的 webhook 写入告警状态，Watchdog 只记录时间', async () => {
    const alerts = await until(
      '两条告警进入 alert_state',
      async () => {
        const a = await activeAlerts(db.server, 'c1', 0);
        return a.length >= 2 ? a : null;
      },
      30_000,
      pipelineState,
    );
    const names = alerts.map((a) => a.alertname).sort();
    expect(names).toEqual(['DemoErrorRatio', 'DemoPodCrashLooping']);
    const crash = alerts.find((a) => a.alertname === 'DemoPodCrashLooping');
    expect(crash).toMatchObject({
      severity: 'critical',
      status: 'firing',
      source: 'alertmanager',
      component: 'Namespace:shop',
    });
    expect(crash?.alert_id).toMatch(/^[0-9a-f]{16}@\d+$/);
    expect(ingest.lastWatchdogAt).not.toBeNull();
    const dir = resolve(import.meta.dirname, '../../../../.scratch/recorded');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'alertmanager-webhook.json'), JSON.stringify(received[0], null, 2));
  });

  it('错误的 token 被拒绝', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/ingest/am',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
  });

  it('对账从 Alertmanager API 补回丢失的告警，并结束告警源中已经没有的告警', async () => {
    await db.server.query("DELETE FROM server.alert_state WHERE alertname = 'DemoErrorRatio'");
    await db.server.query(
      `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status, suppressed,
         starts_at, classification, entity_resolution, received_at, last_seen_at, updated_at)
       VALUES ('00000000000000aa@1', 'c1', '00000000000000aa', 'alertmanager', 'GoneAlert', '{"alertname":"GoneAlert"}', '{}', 'warning', 'firing', 'none',
         now() - interval '1 hour', '{"role":"symptom","source":"default","confidence":0.3,"catalog_entry":null,"chronic":false}', 'unresolved', now(), now(), now())`,
    );
    const r = await reconcileOnce(
      db.server,
      'c1',
      { alertmanagerUrl: am.url, prometheusUrl: prom.url, bearerToken: null, timeoutMs: 5000 },
      ingest,
      metrics,
      'srenautix_self',
      'Watchdog',
    );
    expect(r.sources).toEqual(['alertmanager', 'prometheus']);
    expect(r.added).toBe(1);
    expect(r.resolved).toBe(1);
    const back = await activeAlerts(db.server, 'c1', 0);
    expect(back.map((a) => a.alertname).sort()).toEqual(['DemoErrorRatio', 'DemoPodCrashLooping']);
    expect(back.find((a) => a.alertname === 'DemoErrorRatio')?.source).toBe('reconcile');
    const gone = await db.server.query("SELECT status, ends_at FROM server.alert_state WHERE alertname = 'GoneAlert'");
    expect(gone.rows[0].status).toBe('resolved');
  });

  it('Alertmanager 新增告警的快速轮询：完整对账之前不轮询；只补写本地没有的触发中告警，不结束告警（ADR 0160）', async () => {
    const additions = new AlertmanagerAdditions(
      'c1',
      am.url,
      null,
      5000,
      ingest,
      metrics,
      'srenautix_self',
      'Watchdog',
    );
    const labels = { alertname: 'DemoFastAdded', severity: 'critical', namespace: 'shop' };
    const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 40_000).toISOString();
    const posted = await fetch(`${am.url}/api/v2/alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ labels, annotations: {}, startsAt }]),
    });
    expect(posted.ok).toBe(true);
    // 还没有完整对账的结果：不知道本地有哪些告警，不轮询
    expect(await additions.pollOnce()).toBe(0);
    // 本地有一条告警源里已经没有的告警：快速轮询不结束它
    await db.server.query(
      `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status, suppressed,
         starts_at, classification, entity_resolution, received_at, last_seen_at, updated_at)
       VALUES ('00000000000000bb@1', 'c1', '00000000000000bb', 'alertmanager', 'GoneAgain', '{"alertname":"GoneAgain"}', '{}', 'warning', 'firing', 'none',
         now() - interval '1 hour', '{"role":"symptom","source":"default","confidence":0.3,"catalog_entry":null,"chronic":false}', 'unresolved', now(), now(), now())`,
    );
    const firing = new Set(
      (await activeAlerts(db.server, 'c1', 0))
        .filter((a) => a.status === 'firing' && a.alertname !== 'DemoFastAdded')
        .map((a) => a.fingerprint),
    );
    additions.update(firing);
    const delays = async () =>
      (await metrics.ingestDelay.get()).values.find(
        (v) => v.metricName === 'srenautix_ingest_delay_seconds_count' && v.labels.path === 'fast',
      )?.value ?? 0;
    expect(await additions.pollOnce()).toBe(1);
    expect(await delays()).toBe(1);
    const added = (await activeAlerts(db.server, 'c1', 0)).find((a) => a.alertname === 'DemoFastAdded');
    expect(added).toMatchObject({ status: 'firing', severity: 'critical' });
    expect(Date.parse(added!.starts_at)).toBe(Date.parse(startsAt));
    // 补写过的告警下一轮不再写
    expect(await additions.pollOnce()).toBe(0);
    const gone = await db.server.query("SELECT status FROM server.alert_state WHERE alertname = 'GoneAgain'");
    expect(gone.rows[0].status).toBe('firing');
    // 失去主实例后不再知道本地有哪些告警，等下一轮完整对账
    additions.reset();
    expect(await additions.pollOnce()).toBe(0);
    await db.server.query("DELETE FROM server.alert_state WHERE alertname = 'GoneAgain'");
  });

  it('告警源推送恢复后告警结束', async () => {
    // 直接经 Alertmanager API 推送一个已结束的告警，Alertmanager 再以 webhook 发出 resolved
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const labels = { alertname: 'DemoShortLived', severity: 'warning', namespace: 'shop' };
    const post = (endsAt: string | undefined) =>
      fetch(`${am.url}/api/v2/alerts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ labels, annotations: {}, startsAt, ...(endsAt ? { endsAt } : {}) }]),
      });
    expect((await post(undefined)).ok).toBe(true);
    await until('DemoShortLived 触发', async () =>
      (await activeAlerts(db.server, 'c1', 0)).some((a) => a.alertname === 'DemoShortLived' && a.status === 'firing'),
    );
    expect((await post(new Date().toISOString())).ok).toBe(true);
    const done = await until('DemoShortLived 恢复', async () => {
      const r = await db.server.query(
        "SELECT status, ends_at FROM server.alert_state WHERE alertname = 'DemoShortLived'",
      );
      return r.rows[0]?.status === 'resolved' ? r.rows[0] : null;
    });
    expect(done.ends_at).toBeInstanceOf(Date);
  });
});
