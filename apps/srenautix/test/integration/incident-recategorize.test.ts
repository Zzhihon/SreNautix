import type { AlertCatalogEntry, AlertClassification, Incident, IncidentCategory } from '@srenautix/contract';
import { AlertCatalog, DEFAULT_RCA_PARAMS, labelsFingerprint, type CategoryRule } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncidentEngine } from '../../src/incident/engine.js';
import { recategorizeIncidents, startRecategorize } from '../../src/incident/recategorize.js';
import { IngestService } from '../../src/ingest/service.js';
import type { RawAlert } from '../../src/ingest/normalize.js';
import { ServerMetrics } from '../../src/kernel/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/kernel/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 类别解析输入变化后的重新分类经真实 PG（ADR 0183 §4）：指纹不变不重算；目录补上类别后 unclassified 成员按完整标签或
// 告警名重算，已有类别的成员不动，事件版本与 updated_at 不变，alert_state 的分类同时回写；分批执行，中途停下时不记录指纹；
// 后台检查等到是主实例才执行。

const PROD = 'shop-prod';
const BATCH_CLUSTER = 'shop-batch';
const MIN = 60_000;
const T = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
/** 直接写入的历史事件在三天前结束，不在事件引擎的回看窗口里 */
const OLD = T - 3 * 24 * 60 * MIN;
const metrics = new ServerMetrics('server', false);

const CRASH: AlertCatalogEntry = {
  id: 'pod-crash-looping',
  alertname: 'KubePodCrashLooping',
  role: 'cause',
  category: 'availability',
  entity: { kind: 'Pod', name_labels: ['pod'] },
};
const BACKLOG: AlertCatalogEntry = {
  id: 'queue-backlog',
  alertname: 'ShopQueueBacklog',
  role: 'symptom',
  category: 'performance',
  entity: { kind: 'Deployment', name_labels: ['deployment'] },
};
const PAYMENTS: CategoryRule = { labels: { team: ['payments'] }, exclude_labels: {}, category: 'provider' };

/** 部署方补类别之前：目录里没有 ShopQueueBacklog，没有规则 */
const before = new AlertCatalog([{ pack: 'shop', entries: [CRASH] }]);
/** 补上之后：目录条目声明了 ShopQueueBacklog 的类别，规则给 team=payments 的告警 */
const after = new AlertCatalog([{ pack: 'shop', entries: [CRASH, BACKLOG] }], { categoryRules: [PAYMENTS] });

let db: TestDb;
let ingest: IngestService;
let engine: IncidentEngine;

function raw(labels: Record<string, string>, startsAt: number): RawAlert {
  return {
    source: 'alertmanager',
    labels,
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    startsAt: new Date(startsAt),
    endsAt: null,
    generatorUrl: null,
    fingerprint: labelsFingerprint(labels),
    alertname: labels.alertname!,
    alertmanagerSeenAt: new Date(startsAt),
  };
}

/** 直接写入一个已经有类别的事件（本版本写下的行），成员的 alert_id 不在 alert_state 里 */
async function seed(
  cluster: string,
  n: number,
  members: Array<{ alertname: string; category: IncidentCategory }>,
): Promise<string> {
  const id = `5c0a7e10-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(OLD - n * MIN).toISOString();
  const root = 'Deployment:shop/api';
  const categories = [...new Set(members.map((m) => m.category))].sort();
  const body = {
    incident_id: id,
    cluster_id: cluster,
    label: `${root}:${at.slice(0, 15)}0:00Z~${n}`,
    incident_version: 3,
    state: 'resolved',
    severity: 'warning',
    first_firing_at: at,
    ended_at: at,
    root: { component: root, entity: null, ambiguous: false, margin: null, silent_root: false },
    candidates: [],
    members: members.map((m, i) => ({
      alert_id: `${String(n).padStart(8, '0')}${String(i).padStart(8, '0')}@${Math.floor((OLD - n * MIN) / 1000)}`,
      alertname: m.alertname,
      role: 'symptom',
      component: root,
      severity: 'warning',
      category: m.category,
      status: 'resolved',
      starts_at: at,
      ends_at: at,
      joined_version: 1,
      left_version: null,
    })),
    components: [root],
    categories,
    primary_category: members[0]!.category,
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 1,
    created_at: at,
    updated_at: at,
  } as unknown as Incident;
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at,
       root_component, body, categories, primary_category, updated_at)
     VALUES ($1, $2, $3, 3, 'resolved', 'warning', $4, $4, $5, $6, $7, $8, $4)`,
    [id, cluster, body.label, at, root, JSON.stringify(body), categories, body.primary_category],
  );
  return id;
}

type Row = { categories: string[]; primary_category: string; version: number; updated_at: Date; body: Incident };

async function row(id: string): Promise<Row> {
  return (
    await db.server.query<Row>(
      'SELECT categories, primary_category, version, updated_at, body FROM server.incidents WHERE incident_id = $1',
      [id],
    )
  ).rows[0]!;
}

const memberCategories = (r: Row) => r.body.members.map((m) => [m.alertname, m.category]);

async function runs(): Promise<Array<{ fingerprint: string; holder: string; incidents: number; alerts: number }>> {
  return (
    await db.server.query<{ fingerprint: string; holder: string; incidents: number; alerts: number }>(
      'SELECT fingerprint, holder, incidents, alerts FROM server.incident_recategorizations ORDER BY id',
    )
  ).rows;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topology = new TopologyStore(db.server);
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: PROD, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: before, nodes: topology, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  engine = new IncidentEngine({
    pool: db.server,
    topology,
    params: () => DEFAULT_RCA_PARAMS,
    changes: async () => [],
    probes: async () => [],
    stale: { markStale: async () => 0 },
    metrics,
    suppressedAlerts: async () => new Map<string, string>(),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('类别解析输入变化后的重新分类（ADR 0183）', () => {
  const ids: Record<string, string> = {};
  const always = () => true;

  it('指纹与上次记录相同时不重新分类；包名与条目的其余字段不影响指纹', async () => {
    ids.backlog = await seed(PROD, 1, [{ alertname: 'ShopQueueBacklog', category: 'unclassified' }]);
    const first = await recategorizeIncidents(db.server, before, { holder: 'server-a', active: always });
    expect(first).toMatchObject({ previous: null, outcome: 'completed', incidents: 0, alerts: 0 });
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const renamed = new AlertCatalog([
      { pack: 'shop-v2', entries: [{ ...CRASH, id: 'crash', title: { 'zh-CN': '容器反复重启' } }] },
    ]);
    expect(await recategorizeIncidents(db.server, renamed, { holder: 'server-b', active: always })).toEqual({
      fingerprint: first.fingerprint,
      previous: first.fingerprint,
      outcome: 'unchanged',
      incidents: 0,
      alerts: 0,
    });
    expect(await runs()).toEqual([{ fingerprint: first.fingerprint, holder: 'server-a', incidents: 0, alerts: 0 }]);
    expect(memberCategories(await row(ids.backlog))).toEqual([['ShopQueueBacklog', 'unclassified']]);
  });

  it('目录补上类别后重算 unclassified 成员：按完整标签或告警名，已有类别的成员不动，版本与 updated_at 不变', async () => {
    // 当时由标签覆盖为 provider 的成员与已经分类的成员保留
    ids.kept = await seed(PROD, 2, [
      { alertname: 'ShopQueueBacklog', category: 'provider' },
      { alertname: 'KubePodCrashLooping', category: 'availability' },
    ]);
    ids.partial = await seed(PROD, 3, [
      { alertname: 'UnknownAlert', category: 'unclassified' },
      { alertname: 'ShopQueueBacklog', category: 'unclassified' },
    ]);
    // 事件引擎按补类别之前的目录写下的事件，告警还在 alert_state：重算用完整标签，team=payments 命中规则
    await ingest.write(
      PROD,
      'alertmanager',
      'alertmanager',
      [raw({ alertname: 'PaymentsGatewaySlow', namespace: 'shop', team: 'payments', severity: 'warning' }, T)],
      {},
    );
    await engine.recompute(PROD);
    ids.engine = (
      await db.server.query<{ incident_id: string }>(
        `SELECT incident_id FROM server.incidents WHERE cluster_id = $1 AND body->'members'->0->>'alertname' = 'PaymentsGatewaySlow'`,
        [PROD],
      )
    ).rows[0]!.incident_id;
    expect((await row(ids.engine)).categories).toEqual(['unclassified']);
    const kept = await row(ids.kept);
    const prior = new Map<string, Row>();
    for (const k of ['backlog', 'partial', 'engine']) {
      prior.set(k, await row(ids[k]!));
    }

    const r = await recategorizeIncidents(db.server, after, { holder: 'server-a', active: always });
    expect(r).toMatchObject({ outcome: 'completed', incidents: 3, alerts: 1 });
    expect(r.previous).not.toBe(r.fingerprint);

    expect(await row(ids.kept)).toEqual(kept);
    const backlog = await row(ids.backlog!);
    expect(memberCategories(backlog)).toEqual([['ShopQueueBacklog', 'performance']]);
    expect([backlog.categories, backlog.primary_category]).toEqual([['performance'], 'performance']);
    expect([backlog.body.categories, backlog.body.primary_category]).toEqual([['performance'], 'performance']);
    // 没有目录条目、也不命中规则的成员仍是 unclassified
    const partial = await row(ids.partial);
    expect(memberCategories(partial)).toEqual([
      ['UnknownAlert', 'unclassified'],
      ['ShopQueueBacklog', 'performance'],
    ]);
    expect(partial.categories).toEqual(['performance', 'unclassified']);
    const eng = await row(ids.engine);
    expect(memberCategories(eng)).toEqual([['PaymentsGatewaySlow', 'provider']]);
    expect(eng.categories).toEqual(['provider']);
    for (const k of ['backlog', 'partial', 'engine']) {
      const p = prior.get(k)!;
      const now = await row(ids[k]!);
      expect([now.version, now.updated_at, now.body.incident_version, now.body.updated_at]).toEqual([
        p.version,
        p.updated_at,
        p.body.incident_version,
        p.body.updated_at,
      ]);
    }
    // alert_state 的分类只改类别的两个键，事件引擎之后重算时求出同样的类别
    const stored = (
      await db.server.query<{ classification: AlertClassification }>(
        `SELECT classification FROM server.alert_state WHERE alertname = 'PaymentsGatewaySlow'`,
      )
    ).rows[0]!.classification;
    expect(stored).toMatchObject({ role: 'symptom', category: 'provider', category_source: 'rule' });
    await engine.recompute(PROD);
    expect((await row(ids.engine)).categories).toEqual(['provider']);

    expect(await recategorizeIncidents(db.server, after, { holder: 'server-a', active: always })).toMatchObject({
      outcome: 'unchanged',
      incidents: 0,
    });
    expect((await runs()).map((x) => [x.fingerprint, x.incidents, x.alerts])).toEqual([
      [r.previous, 0, 0],
      [r.fingerprint, 3, 1],
    ]);
  });

  it('分批执行：失去主实例时在批次之间停下、不记录指纹，再次执行时完成剩下的事件', async () => {
    const batchIds: string[] = [];
    for (let n = 10; n < 15; n++) {
      batchIds.push(await seed(BATCH_CLUSTER, n, [{ alertname: 'ShopQueueBacklog', category: 'unclassified' }]));
    }
    // 规则表变化，指纹随之变化
    const next = new AlertCatalog([{ pack: 'shop', entries: [CRASH, BACKLOG] }], {
      categoryRules: [PAYMENTS, { labels: { team: ['search'] }, exclude_labels: {}, category: 'platform' }],
    });
    const recorded = (await runs()).length;
    let checks = 0;
    const interrupted = await recategorizeIncidents(db.server, next, {
      holder: 'server-a',
      batch: 2,
      active: () => checks++ < 1,
    });
    expect(interrupted).toMatchObject({ outcome: 'interrupted', incidents: 2 });
    expect((await runs()).length).toBe(recorded);
    const classified = async () => {
      const out: IncidentCategory[] = [];
      for (const id of batchIds) {
        out.push((await row(id)).primary_category as IncidentCategory);
      }
      return out;
    };
    expect(await classified()).toEqual(['performance', 'performance', 'unclassified', 'unclassified', 'unclassified']);

    const done = await recategorizeIncidents(db.server, next, { holder: 'server-b', batch: 2, active: always });
    expect(done).toMatchObject({ outcome: 'completed', incidents: 3 });
    expect(await classified()).toEqual(Array(5).fill('performance'));
    expect((await runs()).at(-1)).toEqual({
      fingerprint: done.fingerprint,
      holder: 'server-b',
      incidents: 3,
      alerts: 0,
    });
  });

  it('后台检查等到是主实例才执行，完成后结束并计入指标', async () => {
    const next = new AlertCatalog([{ pack: 'shop', entries: [CRASH, BACKLOG] }]);
    const m = new ServerMetrics('server', false);
    let leading = false;
    let checks = 0;
    const leader = {
      isLeader: () => {
        checks++;
        return leading;
      },
      acquired: async () => undefined,
      stop: async () => undefined,
    };
    const running = startRecategorize({
      pool: db.server,
      catalog: next,
      leader,
      holder: 'server-c',
      metrics: m,
      signal: new AbortController().signal,
      retryMs: 20,
    });
    await expect.poll(() => checks).toBeGreaterThan(2);
    expect((await runs()).at(-1)!.holder).toBe('server-b');
    leading = true;
    await running;
    expect((await runs()).at(-1)).toMatchObject({ holder: 'server-c', incidents: 0 });
    expect((await m.recategorizeRuns.get()).values).toEqual([{ labels: { outcome: 'completed' }, value: 1 }]);
  });
});
