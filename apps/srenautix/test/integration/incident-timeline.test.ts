import { randomUUID } from 'node:crypto';
import type { Incident } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timelineOf } from '../../src/console-bff/routes-incidents.js';
import { resolveIncidentRef } from '../../src/incident/read.js';
import { writeReason } from '../../src/incident/reasons.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { Scheduler } from '../../src/scheduler/admission.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident as baseIncident } from '../support/scenario.js';

// 事件时间线的终态条目（ADR 0172）：每种新条目都带登记表中的原因码与级别，符合契约的 TimelineEntry。
// 研判的终态来自研判镜像与队列（租约过期由 server 认领时判定并写进镜像），不进入阶段 B 来自准入，
// 通知、事件 issue 与事件状态来自终态记录，自愈 PR 的原因码来自 remediation_attempts 的 code 列。

let db: TestDb;
let scheduler: Scheduler;
let ended = 0;
const metrics = new ServerMetrics('server', false);
const CLUSTER = 'tl';
const id = randomUUID();
const T = (s: number) => new Date(Date.parse('2026-10-27T01:00:00Z') + s * 1000);

const inc = (): Incident => ({
  ...baseIncident(),
  incident_id: id,
  cluster_id: CLUSTER,
  label: `Deployment:shop/api:${T(0).toISOString()}`,
  incident_version: 1,
  members: [],
  changes: [],
  aliases: [],
  split_from: null,
  created_at: T(0).toISOString(),
  updated_at: T(0).toISOString(),
});

const counted = async (stage: string, code: string) =>
  (await metrics.terminalStates.get()).values.find((v) => v.labels.stage === stage && v.labels.code === code)?.value ??
  0;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const body = inc();
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 'firing', 'critical', $4, $5, $6, $4, $4)`,
    [id, CLUSTER, body.label, T(0), body.root.component, JSON.stringify(body)],
  );
  scheduler = new Scheduler(
    db.server,
    {
      slots: 4,
      criticalReserved: 1,
      maxRunsPerIncident: 3,
      runWindowMs: 6 * 3600_000,
      stageTimeoutMs: 120_000,
      stormActiveAlerts: 200,
      stormNewIncidents: 20,
      stormWindowMs: 5 * 60_000,
      stormTopRoots: 3,
      maxRecoveries: 2,
    },
    metrics,
  );
  scheduler.onEnded = () => {
    ended++;
  };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('事件时间线的终态条目（ADR 0172）', () => {
  it('租约过期次数超过上限：认领时记为失败，研判镜像为 failed（lease_expired），计数并通知消息同步', async () => {
    const run = randomUUID();
    await db.server.query(
      `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state, worker_id,
         attempts, lease_expires_at, deadline_at, enqueued_at)
       VALUES ($1, $2, 1, 'new_incident', 'critical', true, 'leased', 'w-1', 3, now() - interval '1 minute', now(), $3)`,
      [run, id, T(10)],
    );
    expect(await scheduler.claim('w-2')).toBeNull();
    const r = await db.server.query<{ state: string; error: { kind: string; message: string } }>(
      'SELECT state, error FROM server.research_runs WHERE run_id = $1',
      [run],
    );
    expect(r.rows[0]?.state).toBe('failed');
    expect(r.rows[0]?.error.kind).toBe('lease_expired');
    expect(await counted('research', 'lease_expired')).toBe(1);
    expect(ended).toBe(1);
  });

  it('不进入阶段 B 的版本写一条记录，同一版本只写一次', async () => {
    const info: Incident = { ...inc(), severity: 'info', incident_version: 2 };
    expect((await scheduler.admit(info, 'severity_raised')).outcome).toBe('not_researched');
    expect((await scheduler.admit(info, 'fingerprint_changed')).outcome).toBe('not_researched');
    expect(await counted('research', 'not_researched')).toBe(1);
  });

  it('每种条目带原因码与级别，符合契约', async () => {
    // 研判镜像：结论（停止原因）、失败与只出阶段 A
    const runs: Array<[string, string, string | null, unknown]> = [
      ['completed', 'leader_supported', null, { stop_reason: 'leader_supported' }],
      ['failed', 'invalid_output', '模型输出无效：缺少 conclusion', null],
      ['stage_a_only', 'breaker_open', null, null],
    ];
    for (const [i, [state, kind, message, output]] of runs.entries()) {
      await db.server.query(
        `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, conclusion_level, root_component,
           output, error, started_at, finished_at)
         VALUES ($1, $2, 1, 'new_incident', $3, $4, $5, $6, $7, $8, $8)`,
        [
          randomUUID(),
          id,
          state,
          state === 'completed' ? 'likely' : null,
          state === 'completed' ? 'Deployment:shop/api' : null,
          output === null ? null : JSON.stringify(output),
          state === 'completed' ? null : JSON.stringify({ kind, message: message ?? '' }),
          T(20 + i),
        ],
      );
    }
    // 队列：入队时跳过与被取代
    for (const [v, state, skip] of [
      [3, 'skipped', 'storm'],
      [4, 'superseded', null],
    ] as const) {
      await db.server.query(
        `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state, skip_reason,
           enqueued_at, finished_at)
         VALUES ($1, $2, $3, 'fingerprint_changed', 'critical', false, $4, $5, $6, $6)`,
        [randomUUID(), id, v, state, skip, T(30 + v)],
      );
    }
    // 自愈 PR：跳过带原因码，提出提议时没有原因码
    await db.server.query(
      `INSERT INTO server.remediation_attempts (run_id, key, incident_id, incident_version, outcome, code, reason, created_at)
       VALUES ($1, '-', $2, 1, 'skipped', 'no_template', '没有适用的修复模板', $3),
              ($4, 'gitops/scale-up', $2, 1, 'proposed', NULL, NULL, $5)`,
      [randomUUID(), id, T(40), randomUUID(), T(41)],
    );
    // 终态记录：通知、事件 issue、事件状态、阶段 A
    await writeReason(db.server, {
      incidentId: id,
      stage: 'notify',
      code: 'delivered',
      ref: 'telegram:-1001',
      at: T(50),
    });
    await writeReason(db.server, {
      incidentId: id,
      stage: 'notify',
      code: 'entities_too_long',
      detail: 'Bad Request: ENTITIES_TOO_LONG',
      ref: 'telegram:-1001',
      at: T(51),
    });
    await writeReason(db.server, { incidentId: id, stage: 'notify', code: 'withheld_external_digest', at: T(52) });
    await writeReason(db.server, { incidentId: id, stage: 'issue', code: 'rate_limit', detail: '达到上限', at: T(53) });
    await writeReason(db.server, { incidentId: id, stage: 'incident', code: 'resolved', at: T(54) });
    await writeReason(db.server, {
      incidentId: id,
      stage: 'incident',
      code: 'persist_failed',
      detail: 'error: injected',
      at: T(55),
    });
    await writeReason(db.server, {
      incidentId: id,
      incidentVersion: 1,
      stage: 'stage_a',
      code: 'stage_a_failed',
      detail: 'Error: 证据卡超过期限',
      at: T(56),
    });

    const row = await resolveIncidentRef(db.server, id);
    const entries = await timelineOf(db.server, row!);
    expect(responseErrors('/v1/incidents/{incident_ref}/timeline', 'get', 200, entries)).toBeNull();
    const coded = entries.filter((e) => e.code !== null || e.kind === 'remediation_attempt');
    // 租约过期与不进入阶段 B 在测试运行时写入，早于造的其余数据
    expect(coded.map((e) => [e.kind, e.code, e.level])).toEqual([
      ['research_ended', 'lease_expired', 'error'],
      ['research_ended', 'not_researched', 'info'],
      ['research_concluded', 'leader_supported', 'info'],
      ['research_ended', 'invalid_output', 'error'],
      ['research_ended', 'breaker_open', 'warning'],
      ['research_ended', 'storm', 'info'],
      ['research_ended', 'superseded', 'info'],
      ['remediation_attempt', 'no_template', 'info'],
      ['remediation_attempt', null, null],
      ['notify', 'delivered', 'info'],
      ['notify', 'entities_too_long', 'error'],
      ['notify', 'withheld_external_digest', 'info'],
      ['issue', 'rate_limit', 'warning'],
      ['incident_state', 'resolved', 'info'],
      ['incident_state', 'persist_failed', 'error'],
      ['stage_a_missing', 'stage_a_failed', 'error'],
    ]);
    const text = (code: string) => entries.find((e) => e.code === code)!.text;
    expect(text('lease_expired')).toBe(
      '研判失败：研判任务的租约多次过期，超过恢复次数上限（租约过期 3 次，超过恢复次数上限 2）',
    );
    expect(text('invalid_output')).toBe('研判失败：模型输出无效（模型输出无效：缺少 conclusion）');
    expect(text('breaker_open')).toBe('只出阶段 A：模型路由不可用（熔断，或全部被出站策略禁用）');
    expect(text('storm')).toBe('入队时跳过，只出阶段 A：告警风暴中，只研判排名靠前的根因');
    expect(text('leader_supported')).toContain('停止原因：第一的假设得到支持');
    expect(text('no_template')).toBe('自愈 PR：skipped：没有适用的修复模板');
    expect(text('entities_too_long')).toBe(
      '渠道拒绝：格式实体超过上限（telegram:-1001）：Bad Request: ENTITIES_TOO_LONG',
    );
    expect(text('withheld_external_digest')).toBe('不推送：根因是外部上游且没有业务影响，进入周期汇总');
    expect(text('not_researched')).toBe(
      '事件不进入阶段 B（严重度不在研判范围内、被抑制或已合并）：严重度为 info，只研判 critical 与 warning',
    );
    // 错误与渠道应答的原文按不可信文本显示
    expect(entries.find((e) => e.code === 'entities_too_long')!.untrusted).toBe(true);
    expect(entries.find((e) => e.code === 'delivered')!.untrusted).toBe(false);
  });
});
