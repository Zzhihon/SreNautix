import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Incident } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readCandidates } from '../../src/eval/candidates.js';
import { runEvalCli } from '../../src/eval/cli.js';
import { loadLabels } from '../../src/eval/labels.js';
import { upsertAlert } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { EvalCandidates } from '../../src/proposals/candidates.js';
import { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { tx } from '../../src/store/pool.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident as baseIncident } from '../support/scenario.js';

/**
 * 评测候选的导出与合并（ADR 0175）在真实 PostgreSQL 上：反馈与关闭生成候选，管理员确认或放弃；
 * `eval candidates export` 以只读会话读状态库，确认的候选写成完整标注，待确认的另列；`eval label merge` 合并进标注文件
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `eval-candidates-${process.pid}`);
const CLUSTER = 'test';

let db: TestDb;
let feedback: FeedbackService;
let candidates: EvalCandidates;
let stateFile = '';

/** 一个事件：两条成员告警写进 alert_state（带外部标签 prometheus），事件正文引用它们 */
async function newIncident(): Promise<Incident> {
  const id = randomUUID();
  const t = new Date(Date.parse(baseIncident().first_firing_at));
  const ids: string[] = [];
  for (const [alertname, labels] of [
    ['KubePersistentVolumeFillingUp', { namespace: 'shop', persistentvolumeclaim: 'data-postgres-0' }],
    ['ApiHighErrorRate', { namespace: 'shop', service: 'api' }],
  ] as const) {
    const u = await tx(db.server, (c) =>
      upsertAlert(
        c,
        CLUSTER,
        {
          source: 'alertmanager',
          labels: { alertname, ...labels, severity: 'critical', prometheus: 'monitoring/k8s' },
          annotations: {},
          severity: 'critical',
          status: 'firing',
          suppressed: 'none',
          startsAt: t,
          endsAt: null,
          generatorUrl: null,
          fingerprint: randomUUID().replace(/-/g, '').slice(0, 16),
          alertname,
          alertmanagerSeenAt: t,
        },
        {
          classification: { role: 'cause', source: 'default', confidence: 0.3, catalog_entry: null, chronic: false },
          entity: null,
          entityResolution: 'unresolved',
          component: null,
          chains: [],
        },
      ),
    );
    ids.push(u.alertId);
  }
  const base = baseIncident();
  const inc: Incident = {
    ...base,
    incident_id: id,
    label: `StatefulSet:shop/postgres:${id}`,
    state: 'resolved',
    ended_at: new Date(t.getTime() + 30 * 60_000).toISOString(),
    members: base.members.map((m, i) => ({ ...m, alert_id: ids[i]! })),
  };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, 'resolved', 'critical', $5, $6, $7)`,
    [id, CLUSTER, inc.label, inc.incident_version, t, inc.root.component, JSON.stringify(inc)],
  );
  return inc;
}

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const metrics = new ServerMetrics('server', false);
  feedback = new FeedbackService(db.server, metrics);
  candidates = new EvalCandidates(db.server);
  const pw = join(ROOT, 'pw');
  writeFileSync(pw, db.serverConfig.password);
  stateFile = join(ROOT, 'state.json');
  writeFileSync(
    stateFile,
    JSON.stringify({
      host: db.serverConfig.host,
      port: db.serverConfig.port,
      database: db.serverConfig.database,
      user: db.serverConfig.user,
      password_file: pw,
      ssl_mode: 'disable',
    }),
  );
});

afterAll(async () => {
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('eval candidates export 与 eval label merge', () => {
  it('确认的候选写成标注（窗口、分析时刻、成员告警、来源），待确认的另列，放弃的不导出；合并进标注文件并按 id 去重', async () => {
    const since = new Date(Date.now() - 60_000);
    // 1. 反馈原因码 known_issue → benign 候选，管理员确认
    const a = await newIncident();
    const fb = await feedback.create({ principalId: 'oidc:alice', channel: 'console', linked: true }, a, {
      research_run_id: null,
      verdict: null,
      root_component: null,
      disposition_verdict: 'rejected',
      disposition: 'ignore',
      mechanism: null,
      reason: '每周例行备份',
      reason_code: 'known_issue',
    });
    const [ca] = await candidates.list('pending', 10);
    expect(ca).toMatchObject({ incident_id: a.incident_id, source: 'feedback', source_ref: fb.feedback_id });
    await candidates.confirm('local:admin', ca!.candidate_id, {
      type: 'benign',
      roots: [],
      disposition: 'ignore',
      mechanism: null,
    });
    // 2. 关闭的 PR → 类型待定的候选，保持待确认
    const b = await newIncident();
    await tx(db.server, (c) =>
      feedback.recordClosure(c, {
        kind: 'pr_closed',
        incidentId: b.incident_id,
        researchRunId: null,
        closedBy: 'bob',
        reason: '修错了地方',
        url: 'https://github.example.test/acme/gitops/pull/5',
      }),
    );
    // 3. 放弃的候选不导出
    const c = await newIncident();
    await feedback.create({ principalId: 'oidc:alice', channel: 'console', linked: true }, c, {
      research_run_id: null,
      verdict: null,
      root_component: null,
      disposition_verdict: null,
      disposition: null,
      mechanism: null,
      reason: null,
      reason_code: 'false_positive',
    });
    const cc = (await candidates.list('pending', 10)).find((x) => x.incident_id === c.incident_id)!;
    await candidates.drop('local:admin', cc.candidate_id, '数据不全');

    const out = join(ROOT, 'candidates.yaml');
    await runEvalCli(['candidates', 'export', '--state', stateFile, '--since', since.toISOString(), '--out', out]);
    const f = readCandidates(out);
    expect(f.confirmed.map((x) => x.cluster_id)).toEqual([CLUSTER]);
    const label = f.confirmed[0]!.label;
    expect(label).toMatchObject({
      id: `candidate:${ca!.candidate_id}`,
      title: a.label,
      type: 'benign',
      roots: [],
      disposition: 'ignore',
      evidence: [{ kind: 'state', ref: `feedback:${fb.feedback_id}` }],
    });
    // 成员告警的身份标签（去掉告警名与外部标签 prometheus）
    expect([...label.fault_alerts].sort((x, y) => x.alertname.localeCompare(y.alertname))).toEqual([
      { alertname: 'ApiHighErrorRate', labels: { namespace: 'shop', service: 'api', severity: 'critical' } },
      {
        alertname: 'KubePersistentVolumeFillingUp',
        labels: { namespace: 'shop', persistentvolumeclaim: 'data-postgres-0', severity: 'critical' },
      },
    ]);
    expect(label.evidence[0]!.note).toContain('原因码 known_issue');
    expect(Date.parse(label.window.from)).toBeLessThan(Date.parse(a.first_firing_at));
    expect(Date.parse(label.window.to)).toBeGreaterThan(Date.parse(a.ended_at!));
    expect(f.pending).toEqual([
      expect.objectContaining({
        incident_id: b.incident_id,
        source: 'pr_closed',
        source_ref: 'https://github.example.test/acme/gitops/pull/5',
        suggested_type: null,
        reason: '修错了地方',
      }),
    ]);
    // 只读会话：导出没有写任何东西
    expect((await candidates.list('all', 10)).map((x) => x.state).sort()).toEqual(['confirmed', 'dropped', 'pending']);

    // 合并进部署方的标注文件：同一集群的新标注追加，再合并一次没有变化
    const labels = join(ROOT, 'labels.yaml');
    writeFileSync(
      labels,
      [
        '# 部署方本地维护',
        'version: 1',
        `cluster_id: ${CLUSTER}`,
        'labels:',
        '  - id: existing',
        '    title: 已有',
        '    type: benign',
        '    window: {from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z"}',
        '    as_of: "2026-09-01T10:00:00Z"',
        '    fault_alerts: [{alertname: A}]',
        '    disposition: ignore',
        '    evidence: [{kind: state, ref: x}]',
        '',
      ].join('\n'),
    );
    await runEvalCli(['label', 'merge', '--candidates', out, '--labels', labels]);
    const merged = loadLabels(labels);
    expect(merged.labels.map((l) => l.id)).toEqual(['existing', `candidate:${ca!.candidate_id}`]);
    expect(merged.labels[1]).toEqual(label);
    expect(readFileSync(labels, 'utf8')).toContain('# 部署方本地维护');
    const before = readFileSync(labels, 'utf8');
    await runEvalCli(['label', 'merge', '--candidates', out, '--labels', labels]);
    expect(readFileSync(labels, 'utf8')).toBe(before);
    expect((parse(before) as { labels: unknown[] }).labels).toHaveLength(2);
  });

  it('时间范围不合法时报错', async () => {
    await expect(
      runEvalCli(['candidates', 'export', '--state', stateFile, '--since', 'yesterday', '--out', join(ROOT, 'x.yaml')]),
    ).rejects.toThrow(/--since/);
  });
});
