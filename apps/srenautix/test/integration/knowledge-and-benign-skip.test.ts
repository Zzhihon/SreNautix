import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Incident } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeRoutes } from '../../src/api/routes-knowledge.js';
import { Auth } from '../../src/identity/auth.js';
import { Bindings } from '../../src/identity/bindings.js';
import { CallerRegistry } from '../../src/identity/callers.js';
import { SESSION_COOKIE, Sessions } from '../../src/identity/sessions.js';
import { upsertAlert } from '../../src/ingest/store.js';
import { createApp } from '../../src/kernel/http.js';
import { ServerMetrics } from '../../src/kernel/metrics.js';
import { readAudit } from '../../src/kernel/store/audit.js';
import { migrateExpand } from '../../src/kernel/store/migrate.js';
import { tx } from '../../src/kernel/store/pool.js';
import { LearnedKnowledgeService } from '../../src/knowledge/service.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { Scheduler } from '../../src/scheduler/admission.js';
import { PackRuntime } from '../../src/stage-a/packs.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident as baseIncident } from '../support/scenario.js';

const CLUSTER = 'east';
const PUBLIC = 'https://console.test';
const ORIGIN = { origin: PUBLIC };

let db: TestDb;
let app: FastifyInstance;
let dir: string;
let feedback: FeedbackService;
let knowledge: LearnedKnowledgeService;
let metrics: ServerMetrics;
let adminSession: { cookie: string; csrf: string };
let responderSession: { cookie: string; csrf: string };
let viewerSession: { cookie: string; csrf: string };

async function makeSession(
  sessions: Sessions,
  id: string,
  groups: string[],
): Promise<{ cookie: string; csrf: string }> {
  const s = await sessions.create(
    {
      principal: { id, display_name: id, groups },
      provider: 'oidc',
      auth_time: new Date(),
      mfa: true,
      external_ids: {},
    },
    false,
  );
  return { cookie: `${SESSION_COOKIE}=${s.id}`, csrf: s.session.csrfToken };
}

async function seedIncident(o: {
  cluster?: string;
  severity?: 'critical' | 'warning' | 'info';
  root?: string;
  alertnames?: string[];
  alertLabels?: Record<string, Record<string, string>>;
}): Promise<Incident> {
  const id = randomUUID();
  const cluster = o.cluster ?? CLUSTER;
  const root = o.root ?? 'Deployment:shop/noisy';
  const severity = o.severity ?? 'warning';
  const alertnames = o.alertnames ?? ['NoisyWarningAlert'];
  const now = new Date();
  const members: Incident['members'] = [];
  for (const alertname of alertnames) {
    const extraLabels = o.alertLabels?.[alertname] ?? {};
    const u = await tx(db.server, (c) =>
      upsertAlert(
        c,
        cluster,
        {
          source: 'alertmanager',
          labels: { alertname, namespace: 'shop', severity, ...extraLabels },
          annotations: {},
          severity,
          status: 'firing',
          suppressed: 'none',
          startsAt: now,
          endsAt: null,
          generatorUrl: null,
          fingerprint: randomUUID().replace(/-/g, '').slice(0, 16),
          alertname,
          alertmanagerSeenAt: now,
        },
        {
          classification: { role: 'symptom', source: 'default', confidence: 0.5, catalog_entry: null, chronic: false },
          entity: null,
          entityResolution: 'unresolved',
          component: root,
          chains: [],
        },
      ),
    );
    members.push({
      alert_id: u.alertId,
      alertname,
      role: 'symptom',
      severity,
      status: 'firing',
      component: root,
      joined_version: 1,
      left_version: null,
      starts_at: now.toISOString(),
      ends_at: null,
      category: 'unclassified',
    });
  }
  const base = baseIncident();
  const inc: Incident = {
    ...base,
    incident_id: id,
    cluster_id: cluster,
    label: `${root}:${id}`,
    severity,
    state: 'firing',
    ended_at: null,
    root: { ...base.root, component: root },
    components: [root],
    candidates: [{ ...base.candidates[0]!, component: root, explains: members.map((m) => m.alert_id) }],
    members,
  };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, 1, 'firing', $4, $5, $6, $7)`,
    [id, cluster, inc.label, severity, now, root, JSON.stringify(inc)],
  );
  return inc;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  dir = resolve(import.meta.dirname, `../../../../.scratch/knowledge-int-${db.name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'roles.yaml'),
    [
      'bindings:',
      '  - subject: { kind: group, name: admins }',
      '    role: admin',
      '    scope: { clusters: ["*"], namespaces: ["*"], component_labels: {} }',
      '  - subject: { kind: group, name: responders }',
      '    role: responder',
      '    scope: { clusters: ["*"], namespaces: ["*"], component_labels: {} }',
      '  - subject: { kind: group, name: viewers }',
      '    role: viewer',
      '    scope: { clusters: ["*"], namespaces: ["*"], component_labels: {} }',
      '',
    ].join('\n'),
  );
  metrics = new ServerMetrics('server', false);
  const topology = new TopologyStore(db.server);
  feedback = new FeedbackService(db.server, metrics);
  knowledge = new LearnedKnowledgeService(db.server, topology);
  const packs = await PackRuntime.load({
    dirs: [resolve(import.meta.dirname, '../../../../packs')],
    only: ['postgres'],
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range']),
  });
  const sessions = new Sessions(db.server, { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 });
  const auth = new Auth(sessions, new CallerRegistry([]), Bindings.load(dir), PUBLIC);
  adminSession = await makeSession(sessions, 'oidc:admin', ['admins']);
  responderSession = await makeSession(sessions, 'oidc:alice', ['responders']);
  viewerSession = await makeSession(sessions, 'oidc:bob', ['viewers']);

  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerKnowledgeRoutes(app, { pool: db.server, auth, knowledge, packs, locale: 'zh-CN' });
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P0-2 在线反馈一键沉淀知识案例 + 检索 + 归档（真实 PostgreSQL）', () => {
  it('一键沉淀自动推导字段、幂等返回、支持筛选查询与 RAG 检索，管理员可软归档并记审计', async () => {
    const inc = await seedIncident({
      root: 'StatefulSet:shop/pg-main',
      alertnames: ['PgWalArchiveLag'],
      severity: 'warning',
    });
    await feedback.create({ principalId: 'oidc:alice', channel: 'console', linked: true }, inc, {
      research_run_id: null,
      verdict: null,
      root_component: null,
      disposition_verdict: 'rejected',
      disposition: 'ignore',
      mechanism: '每日全量备份窗口内短暂归档延迟，无业务影响',
      reason: '例行备份导致',
      reason_code: 'false_positive',
    });

    // viewer 无权沉淀
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${inc.incident_id}/knowledge`,
      headers: { cookie: viewerSession.cookie, ...ORIGIN, 'x-csrf-token': viewerSession.csrf },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);

    // responder 空请求体一键沉淀 -> 201，自动推导为 benign
    const created = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${inc.incident_id}/knowledge`,
      headers: { cookie: responderSession.cookie, ...ORIGIN, 'x-csrf-token': responderSession.csrf },
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    const item = created.json();
    expect(item).toMatchObject({
      origin: 'learned',
      cluster_id: CLUSTER,
      incident_id: inc.incident_id,
      kind: 'benign',
      components: ['StatefulSet:shop/pg-main'],
      alertnames: ['PgWalArchiveLag'],
      source: 'human',
      created_by: 'oidc:alice',
    });
    expect(item.text).toContain('每日全量备份窗口内短暂归档延迟');

    // 同一事件同一种类再次一键沉淀 -> 200 幂等返回同一条
    const again = await app.inject({
      method: 'POST',
      url: `/v1/incidents/${inc.incident_id}/knowledge`,
      headers: { cookie: responderSession.cookie, ...ORIGIN, 'x-csrf-token': responderSession.csrf },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().case_id).toBe(item.case_id);

    // GET /v1/knowledge：合并 learned 与 pack，支持 origin / kind / q 筛选
    const listedAll = await app.inject({
      method: 'GET',
      url: '/v1/knowledge?origin=all&limit=100',
      headers: { cookie: viewerSession.cookie },
    });
    expect(listedAll.statusCode).toBe(200);
    expect(listedAll.json().items.some((x: { case_id: string }) => x.case_id === item.case_id)).toBe(true);

    const listedBenign = await app.inject({
      method: 'GET',
      url: '/v1/knowledge?origin=learned&kind=benign&q=PgWalArchiveLag',
      headers: { cookie: viewerSession.cookie },
    });
    expect(listedBenign.statusCode).toBe(200);
    expect(listedBenign.json().items.map((x: { case_id: string }) => x.case_id)).toEqual([item.case_id]);

    // Stage B 检索：其他事件命中组件或告警名时召回，本事件自身不召回
    const retrievedOther = await knowledge.retrieveForResearch({
      clusterId: CLUSTER,
      incidentId: randomUUID(),
      componentKeys: ['StatefulSet:shop/pg-main'],
      componentTypes: [],
      alertnames: ['PgWalArchiveLag'],
    });
    expect(retrievedOther).toHaveLength(1);
    expect(retrievedOther[0]).toMatchObject({
      id: `learned/${item.case_id}`,
      learned_from: [inc.incident_id],
      source: 'human',
    });
    expect(retrievedOther[0]?.text).toContain('[benign]');

    const retrievedSelf = await knowledge.retrieveForResearch({
      clusterId: CLUSTER,
      incidentId: inc.incident_id,
      componentKeys: ['StatefulSet:shop/pg-main'],
      componentTypes: [],
      alertnames: ['PgWalArchiveLag'],
    });
    expect(retrievedSelf).toEqual([]);

    // responder 无权删除，admin 软归档 -> 204
    const delDenied = await app.inject({
      method: 'DELETE',
      url: `/v1/knowledge/${item.case_id}`,
      headers: { cookie: responderSession.cookie, ...ORIGIN, 'x-csrf-token': responderSession.csrf },
    });
    expect(delDenied.statusCode).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/knowledge/${item.case_id}`,
      headers: { cookie: adminSession.cookie, ...ORIGIN, 'x-csrf-token': adminSession.csrf },
    });
    expect(deleted.statusCode).toBe(204);

    // 归档后不再出现在检索与列表中
    const afterArchive = await knowledge.retrieveForResearch({
      clusterId: CLUSTER,
      incidentId: randomUUID(),
      componentKeys: ['StatefulSet:shop/pg-main'],
      componentTypes: [],
      alertnames: ['PgWalArchiveLag'],
    });
    expect(afterArchive).toEqual([]);

    // 治理审计链记录 knowledge.promoted 与 knowledge.archived
    const audits = await readAudit(db.server, 0, 1000);
    expect(
      audits.some(
        (a) => a.kind === 'knowledge.promoted' && (a.data as Record<string, unknown>).case_id === item.case_id,
      ),
    ).toBe(true);
    expect(
      audits.some(
        (a) => a.kind === 'knowledge.archived' && (a.data as Record<string, unknown>).case_id === item.case_id,
      ),
    ).toBe(true);
  });
});

describe('P0-2 自动良性模式跳过阶段 B（Scheduler.admit，真实 PostgreSQL）', () => {
  function makeScheduler() {
    return new Scheduler(
      db.server,
      {
        slots: 4,
        criticalReserved: 1,
        maxRunsPerIncident: 3,
        runWindowMs: 6 * 3600_000,
        stageTimeoutMs: 8 * 60_000,
        stormActiveAlerts: 200,
        stormNewIncidents: 20,
        stormWindowMs: 5 * 60_000,
        stormTopRoots: 3,
        maxRecoveries: 2,
        autoBenignSkip: { enabled: true, minConfirmations: 3, windowMs: 30 * 24 * 3600_000 },
        businessImpactAlerts: [{ labels: { layer: ['L0'] }, exclude_labels: {} }],
      },
      metrics,
    );
  }

  it('3 次人工确认 false_positive/not_actionable 后自动跳过，保留 manual/feedback/critical/业务影响/新增症状/planned_change 护栏', async () => {
    const scheduler = makeScheduler();
    const root = 'Deployment:shop/cache-warmer';
    const alert = 'CacheWarmupSlow';

    // 先写入 2 次良性反馈：未达到阈值 3，仍正常入队
    for (let i = 0; i < 2; i++) {
      const prior = await seedIncident({ root, alertnames: [alert] });
      await feedback.create({ principalId: 'oidc:alice', channel: 'console', linked: true }, prior, {
        research_run_id: null,
        verdict: null,
        root_component: null,
        disposition_verdict: 'rejected',
        disposition: 'ignore',
        mechanism: null,
        reason: '例行预热',
        reason_code: i === 0 ? 'false_positive' : 'not_actionable',
      });
    }
    const beforeThreshold = await seedIncident({ root, alertnames: [alert] });
    expect((await scheduler.admit(beforeThreshold, 'new_incident')).outcome).toBe('queued');

    // 第 3 次如果是 planned_change，不计入自动良性确认
    const planned = await seedIncident({ root, alertnames: [alert] });
    await feedback.create({ principalId: 'oidc:alice', channel: 'console', linked: true }, planned, {
      research_run_id: null,
      verdict: null,
      root_component: null,
      disposition_verdict: null,
      disposition: null,
      mechanism: null,
      reason: '维护窗口',
      reason_code: 'planned_change',
    });
    const stillQueued = await seedIncident({ root, alertnames: [alert] });
    expect((await scheduler.admit(stillQueued, 'new_incident')).outcome).toBe('queued');

    // 在 planned_change 之后连续给出 3 次真正的 false_positive / not_actionable
    for (const code of ['false_positive', 'not_actionable', 'false_positive'] as const) {
      const p = await seedIncident({ root, alertnames: [alert] });
      await feedback.create({ principalId: 'oidc:alice', channel: 'console', linked: true }, p, {
        research_run_id: null,
        verdict: null,
        root_component: null,
        disposition_verdict: 'rejected',
        disposition: 'ignore',
        mechanism: null,
        reason: '无害抖动',
        reason_code: code,
      });
    }

    // 1. 新的 warning 事件命中精确模式 -> benign_pattern（stage_a_only）
    const skipped = await seedIncident({ root, alertnames: [alert] });
    expect((await scheduler.admit(skipped, 'new_incident')).outcome).toBe('benign_pattern');
    // 2. 手动触发与反馈触发始终放行
    expect((await scheduler.admit(skipped, 'manual')).outcome).toBe('queued');
    const fbTrigger = await seedIncident({ root, alertnames: [alert] });
    expect((await scheduler.admit(fbTrigger, 'feedback')).outcome).toBe('queued');
    // 3. critical 事件永不自动跳过
    const crit = await seedIncident({ root, alertnames: [alert], severity: 'critical' });
    expect((await scheduler.admit(crit, 'new_incident')).outcome).toBe('queued');
    // 4. 命中 business_impact_alerts 时永不自动跳过
    const biz = await seedIncident({
      root,
      alertnames: [alert],
      alertLabels: { [alert]: { layer: 'L0' } },
    });
    expect((await scheduler.admit(biz, 'new_incident')).outcome).toBe('queued');
    // 5. 子集护栏：新增未在历史良性事件出现过的告警名时不跳过
    const extraSymptom = await seedIncident({ root, alertnames: [alert, 'Api5xxSpike'] });
    expect((await scheduler.admit(extraSymptom, 'new_incident')).outcome).toBe('queued');
    // 6. 精确组件键护栏：同 Kind 的不同组件不跳过
    const otherDeploy = await seedIncident({ root: 'Deployment:shop/checkout', alertnames: [alert] });
    expect((await scheduler.admit(otherDeploy, 'new_incident')).outcome).toBe('queued');
    // 7. recoverModelFailures 不会重跑 benign_pattern 跳过的事件
    scheduler.reportRoutes({
      workerId: 'w1',
      at: Date.now(),
      routes: [{ id: 'r1', enabled: true, reason: null, message: null }],
    });
    const recovered = await scheduler.recoverModelFailures(10);
    expect(recovered.some((r) => r.incidentId === skipped.incident_id)).toBe(false);
  });
});
