import type { AlertCatalogEntry, AlertClassification, Incident, IncidentCategory } from '@srenautix/contract';
import { AlertCatalog, DEFAULT_RCA_PARAMS } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categoryOptions } from '../../src/alerts/category.js';
import type { ObjectHealth } from '../../src/detectors/health.js';
import { DEFAULT_EQUIVALENTS, findingAlert, type DetectorSettings } from '../../src/detectors/service.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { classificationInputsFingerprint, recategorizeIncidents } from '../../src/incident/recategorize.js';
import { IngestService } from '../../src/ingest/service.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 检测器合成告警的内置类别表进入类别解析输入（ADR 0183 §2.1、§4.1），经真实 PG：升级到带这张表的版本之后，
// 历史事件里 unclassified 的检测器成员按告警名（告警已清理）或完整标签（告警还在 alert_state）重新分类，
// 已有类别的成员不动。

const C = 'shop-prod';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
/** 直接写入的历史事件在三天前结束，不在事件引擎的回看窗口里 */
const OLD = NOW - 3 * 24 * 60 * MIN;
const metrics = new ServerMetrics('server', false);

const PDB_HEALTHY: AlertCatalogEntry = {
  id: 'kube-pdb-not-enough-healthy-pods',
  alertname: 'KubePdbNotEnoughHealthyPods',
  role: 'symptom',
  category: 'availability',
  entity: { kind: 'PodDisruptionBudget', name_labels: ['poddisruptionbudget'] },
};
const packs = [{ pack: 'kps', entries: [PDB_HEALTHY] }];
/** 之前的版本：没有内置类别表 */
const before = new AlertCatalog(packs);
/** 当前版本：server 的类别选项带检测器的内置类别表 */
const current = new AlertCatalog(packs, categoryOptions([], metrics));

const settings: DetectorSettings = {
  namespaces: ['*'],
  excludeNamespaces: [],
  thresholdsMs: { pdb_blocking: 10 * MIN, rollout_stalled: 15 * MIN },
  severity: 'warning',
  equivalentAlerts: DEFAULT_EQUIVALENTS,
};

let db: TestDb;
let ingest: IngestService;
let engine: IncidentEngine;

/** 直接写入一个历史事件，成员的 alert_id 不在 alert_state 里 */
async function seed(n: number, members: Array<{ alertname: string; category: IncidentCategory }>): Promise<string> {
  const id = `de7ec7a0-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(OLD - n * MIN).toISOString();
  const root = 'Deployment:shop/api';
  const categories = [...new Set(members.map((m) => m.category))].sort();
  const body = {
    incident_id: id,
    cluster_id: C,
    label: `${root}:${at.slice(0, 15)}0:00Z~${n}`,
    incident_version: 2,
    state: 'resolved',
    severity: 'warning',
    first_firing_at: at,
    ended_at: at,
    root: { component: root, entity: null, ambiguous: false, margin: null, silent_root: false },
    candidates: [],
    members: members.map((m, i) => ({
      alert_id: `${String(n).padStart(8, '0')}${String(i).padStart(8, '0')}@${Math.floor((OLD - n * MIN) / 1000)}`,
      alertname: m.alertname,
      role: 'cause',
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
     VALUES ($1, $2, $3, 2, 'resolved', 'warning', $4, $4, $5, $6, $7, $8, $4)`,
    [id, C, body.label, at, root, JSON.stringify(body), categories, body.primary_category],
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

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topology = new TopologyStore(db.server);
  // 接入按之前版本的目录分类：检测器告警写成 unclassified
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: C, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
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

describe('内置类别表变化后重新分类历史检测器成员（ADR 0183）', () => {
  it('升级后的第一次检查：unclassified 的检测器成员按内置类别表重算，已有类别的成员不动', async () => {
    const always = () => true;
    // 之前的版本取得主实例时记下的指纹
    const old = await recategorizeIncidents(db.server, before, { holder: 'server-a', active: always });
    expect(old).toMatchObject({ outcome: 'completed', incidents: 0 });
    expect(classificationInputsFingerprint(current)).not.toBe(old.fingerprint);

    // 告警已经清理掉的历史事件：按告警名查内置类别表
    const purged = await seed(1, [
      { alertname: 'SreNautixPdbBlockingEviction', category: 'unclassified' },
      { alertname: 'SreNautixRolloutStalled', category: 'unclassified' },
    ]);
    // 当时由 srenautix_category 标签给出类别的检测器成员保留
    const kept = await seed(2, [{ alertname: 'SreNautixPdbBlockingEviction', category: 'availability' }]);
    // 告警还在 alert_state 的事件：检测器合成、按之前版本的目录写成 unclassified
    const h: ObjectHealth = {
      key: 'Deployment:shop/worker',
      kind: 'Deployment',
      namespace: 'shop',
      name: 'worker',
      uid: 'uid-worker',
      state: 'rollout_stalled',
      since: new Date(NOW - 40 * MIN).toISOString(),
      reason: 'ProgressDeadlineExceeded',
      message: '',
      owner: null,
    };
    const alert = findingAlert(C, h, settings, NOW)!;
    await ingest.write(C, 'detector', 'detector', [alert], { detector: 1 });
    await engine.recompute(C);
    const live = (
      await db.server.query<{ incident_id: string }>(
        `SELECT incident_id FROM server.incidents WHERE cluster_id = $1 AND body->'members'->0->>'alertname' = 'SreNautixRolloutStalled'`,
        [C],
      )
    ).rows[0]!.incident_id;
    expect((await row(live)).categories).toEqual(['unclassified']);
    const keptBefore = await row(kept);
    const prior = { purged: await row(purged), live: await row(live) };

    const r = await recategorizeIncidents(db.server, current, { holder: 'server-b', active: always });
    expect(r).toMatchObject({ previous: old.fingerprint, outcome: 'completed', incidents: 2, alerts: 1 });

    const p = await row(purged);
    expect(memberCategories(p)).toEqual([
      ['SreNautixPdbBlockingEviction', 'platform'],
      ['SreNautixRolloutStalled', 'availability'],
    ]);
    expect(p.categories).toEqual(['availability', 'platform']);
    expect(p.body.categories).toEqual(['availability', 'platform']);
    const l = await row(live);
    expect(memberCategories(l)).toEqual([['SreNautixRolloutStalled', 'availability']]);
    expect([l.categories, l.primary_category]).toEqual([['availability'], 'availability']);
    expect(await row(kept)).toEqual(keptBefore);
    for (const [now, was] of [
      [p, prior.purged],
      [l, prior.live],
    ] as const) {
      expect([now.version, now.updated_at, now.body.incident_version]).toEqual([
        was.version,
        was.updated_at,
        was.body.incident_version,
      ]);
    }
    const stored = (
      await db.server.query<{ classification: AlertClassification }>(
        `SELECT classification FROM server.alert_state WHERE alertname = 'SreNautixRolloutStalled'`,
      )
    ).rows[0]!.classification;
    expect(stored).toMatchObject({ role: 'cause', category: 'availability', category_source: 'builtin' });

    // 同样的输入再次检查：不重算
    expect(await recategorizeIncidents(db.server, current, { holder: 'server-b', active: always })).toMatchObject({
      outcome: 'unchanged',
      incidents: 0,
    });
  });
});
