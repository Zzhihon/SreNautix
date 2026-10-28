import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AlertCatalog, computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileFromReader, type ReaderAlertSnapshot } from '../../src/ingest/reconcile.js';
import { IngestService } from '../../src/ingest/service.js';
import { activeAlerts } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import type { ProposalService } from '../../src/proposals/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import type { EvidenceRun, EvidenceRunner, RuleProposer } from '../../src/stage-a/ports.js';
import { StageAService } from '../../src/stage-a/service.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident } from '../support/scenario.js';

/**
 * Watchdog、InfoInhibitor 与 severity=none 的告警不进入事件（core isIgnorable，DESIGN §5）。之前只有 core 的
 * normalizeAlert 调用它，server 的接入路径没有：Kind 的 alert-too-sensitive 多出一个只有 InfoInhibitor 的
 * Namespace:srenautix 事件，正确的事件也吸收了 InfoInhibitor 成员。webhook 接入、reader 对账、事件引擎的输入与
 * 阶段 A 都按同一条规则排除；修复之前已经入库的成员在重算时离开事件。
 */
const C = 'kind';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `ignorable-${process.pid}`);
const TOKEN = 'ingest-token-ignorable-0123456789';
const metrics = new ServerMetrics('server', false);
const NOW = Date.now();
const T0 = new Date(NOW - 10 * 60_000).toISOString();

let db: TestDb;
let ingest: IngestService;

const am = (labels: Record<string, string>) => ({
  labels,
  annotations: {},
  startsAt: T0,
  endsAt: '0001-01-01T00:00:00Z',
  generatorURL: '',
  fingerprint: '',
  status: 'firing',
});
const webhook = (alerts: unknown[]) => ({
  receiver: 'srenautix',
  status: 'firing',
  alerts,
  groupLabels: {},
  commonLabels: {},
  commonAnnotations: {},
  externalURL: 'http://alertmanager.example:9093',
  version: '4',
  groupKey: '{}',
  truncatedAlerts: 0,
});
const stored = async () =>
  (
    await db.server.query<{ alertname: string }>(
      'SELECT alertname FROM server.alert_state WHERE cluster_id = $1 ORDER BY alertname',
      [C],
    )
  ).rows.map((r) => r.alertname);

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'token'), TOKEN);
  ingest = new IngestService(
    db.server,
    [{ id: 'am', kind: 'alertmanager', token_file: join(ROOT, 'token') }],
    { clusterId: C, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    {
      catalog: new AlertCatalog([]),
      nodes: new TopologyStore(db.server),
      ksm: null,
      ruleExpr: () => undefined,
      chronic: () => false,
    },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('不进入事件的告警', () => {
  it('webhook：InfoInhibitor（只有 namespace 标签）、Watchdog 与 severity=none 不入库，其余照常', async () => {
    const r = await ingest.ingest(
      'am',
      webhook([
        am({ alertname: 'InfoInhibitor', namespace: 'srenautix', severity: 'none' }),
        am({ alertname: 'InfoInhibitor', namespace: 'shop' }),
        am({ alertname: 'Watchdog', severity: 'none' }),
        am({ alertname: 'ShopNoise', namespace: 'shop', severity: 'none' }),
        am({ alertname: 'ShopPodRestarted', namespace: 'shop', pod: 'api-1', severity: 'critical' }),
      ]),
    );
    expect(r).toMatchObject({ accepted: 1, dropped: 4 });
    expect(await stored()).toEqual(['ShopPodRestarted']);
  });

  it('reader 对账：同样排除', async () => {
    const snap: ReaderAlertSnapshot = {
      taken_at: new Date().toISOString(),
      alertmanager: {
        status: 'ok',
        truncated: false,
        items: [
          {
            ...am({ alertname: 'InfoInhibitor', namespace: 'monitoring' }),
            status: { state: 'active', silencedBy: [], inhibitedBy: [] },
          },
          {
            ...am({ alertname: 'ShopPodRestarted', namespace: 'shop', pod: 'api-1', severity: 'critical' }),
            status: { state: 'active', silencedBy: [], inhibitedBy: [] },
          },
        ],
      },
      rules: {
        status: 'ok',
        truncated: false,
        items: [{ labels: { alertname: 'InfoInhibitor', namespace: 'x' }, state: 'firing', active_at: T0 }],
      },
    };
    await reconcileFromReader(db.server, C, snap, ingest, metrics, 'srenautix_self', 'Watchdog');
    expect(await stored()).toEqual(['ShopPodRestarted']);
  });

  it('修复之前入库的 InfoInhibitor：事件引擎的输入排除它，既不单独成事件，也不加入已有的事件', async () => {
    for (const [i, ns] of ['srenautix', 'shop'].entries()) {
      await db.server.query(
        `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status, suppressed,
           starts_at, classification, entity_resolution, component, received_at, last_seen_at, updated_at)
         VALUES ($1, $2, $3, 'alertmanager', 'InfoInhibitor', $4, '{}', 'info', 'firing', 'none', $5,
           '{"role":"symptom","source":"default","confidence":0.3,"catalog_entry":null,"chronic":false}', 'unresolved', $6, now(), now(), now())`,
        [
          `00000000000000f${i}@1`,
          C,
          `00000000000000f${i}`,
          JSON.stringify({ alertname: 'InfoInhibitor', namespace: ns }),
          T0,
          `Namespace:${ns}`,
        ],
      );
    }
    expect((await stored()).filter((x) => x === 'InfoInhibitor')).toHaveLength(2);
    const alerts = await activeAlerts(db.server, C, 30 * 60_000);
    expect(alerts.map((a) => a.alertname)).toEqual(['ShopPodRestarted']);
    const t = await new TopologyStore(db.server).at(C, new Date());
    const incs = computeIncidents({
      alerts,
      changes: [],
      graph: new TopologyGraph(t.nodes, t.edges, t.version),
      params: DEFAULT_RCA_PARAMS,
      now: NOW,
    });
    expect(incs).toHaveLength(1);
    expect(incs[0]!.group.alerts.map((a) => a.alert.alertname)).toEqual(['ShopPodRestarted']);
  });

  it('重算阶段 A：已经是事件成员的 InfoInhibitor 不参与证据卡，并通知事件流水线重算', async () => {
    const seen: string[][] = [];
    const evidence: EvidenceRunner = {
      run: async (_inc, alerts): Promise<EvidenceRun> => {
        seen.push(alerts.map((a) => a.alertname));
        return { cards: [], chains: [], runbooks: [], rootComponentType: null };
      },
      rerun: async () => [],
    };
    const rules: RuleProposer = { evaluate: () => [], excluded: () => null, conclude: () => [] };
    const stageA = new StageAService(
      db.server,
      evidence,
      rules,
      {} as ProposalService,
      metrics,
      () => null,
      (cl, ids) => ingest.reresolve(cl, ids),
    );
    const restarted = (await activeAlerts(db.server, C, 0))[0]!;
    const base = incident();
    const inc = {
      ...base,
      cluster_id: C,
      members: [
        { ...base.members[0]!, alert_id: restarted.alert_id, alertname: 'ShopPodRestarted' },
        { ...base.members[1]!, alert_id: '00000000000000f1@1', alertname: 'InfoInhibitor' },
      ],
    };
    await db.server.query(
      `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
       VALUES ($1, $2, $3, $4, 'firing', $5, $6, $7, $8)`,
      [
        inc.incident_id,
        C,
        inc.label,
        inc.incident_version,
        inc.severity,
        inc.first_firing_at,
        inc.root.component,
        JSON.stringify(inc),
      ],
    );
    const listen = await db.server.connect();
    const notified: string[] = [];
    listen.on('notification', (n) => notified.push(n.payload ?? ''));
    await listen.query('LISTEN srenautix_ingest');
    await stageA.recompute(inc.incident_id, 'manual');
    await new Promise((r) => setTimeout(r, 200));
    await listen.query('UNLISTEN srenautix_ingest');
    listen.release();
    expect(seen).toEqual([['ShopPodRestarted']]);
    expect(notified).toContain(C);
  });
});
