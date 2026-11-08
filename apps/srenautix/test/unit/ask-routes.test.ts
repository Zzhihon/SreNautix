import type { EvidenceResult, RootCandidate, StageAReport } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerAskRoutes, type AskResponse } from '../../src/api/routes-ask.js';
import { HttpError } from '../../src/api/errors.js';
import type { Auth } from '../../src/identity/auth.js';
import type { Scheduler } from '../../src/scheduler/admission.js';
import { appendAudit } from '../../src/store/audit.js';
import { tx } from '../../src/store/pool.js';

// 事件页「受控问答」：复用既有阶段 A / 阶段 B 结论，不新调模型；问题文本当不可信数据

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
const REF = 'incident-2026-11-08';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const QUESTION = '这次事件最可能的根因是什么？';

vi.mock('../../src/incident/read.js', () => ({
  resolveIncidentRef: vi.fn(),
  latestStageA: vi.fn(),
  incidentVersion: vi.fn(),
}));

vi.mock('../../src/store/pool.js', () => ({
  tx: vi.fn(async (_pool: unknown, cb: (c: unknown) => Promise<unknown>) => cb({})),
}));

vi.mock('../../src/store/audit.js', () => ({
  appendAudit: vi.fn(async () => ({})),
}));

import { latestStageA, resolveIncidentRef } from '../../src/incident/read.js';

const resolveMock = vi.mocked(resolveIncidentRef);
const stageAMock = vi.mocked(latestStageA);
const txMock = vi.mocked(tx);
const auditMock = vi.mocked(appendAudit);

interface QueryCall {
  sql: string;
  params: unknown[];
}

let app: FastifyInstance;
let calls: QueryCall[];
let admit: ReturnType<typeof vi.fn>;
let authUser: ReturnType<typeof vi.fn>;

/** 按 SQL 里的关键片段返回对应的行；所有查询都必须是参数化的（$1 占位符）。 */
function poolFor(rows: Record<string, Record<string, unknown>[]>): pg.Pool {
  return {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (!sql.includes('$1')) {
        throw new Error(`查询没有参数化：${sql}`);
      }
      let key = 'other';
      if (sql.includes('FROM server.research_runs')) key = 'runs';
      else if (sql.includes('FROM server.research_queue')) key = 'queue';
      else if (sql.includes('FROM server.proposals')) key = 'proposals';
      return { rows: rows[key] ?? [], rowCount: (rows[key] ?? []).length } as never;
    },
    connect: async () => {
      throw new Error('本测试只用 pool.query，事务由 mock 的 tx 承担');
    },
  } as unknown as pg.Pool;
}

function stageA(): StageAReport {
  const cards = [{ ref: 'c1', card_id: 'pack/chain/card' } as unknown as EvidenceResult];
  const candidates = [{ component: 'Deployment:shop/api', score: 0.9 } as unknown as RootCandidate];
  return {
    report_id: '33333333-3333-4333-8333-333333333333',
    incident_id: INCIDENT_ID,
    incident_version: 3,
    disposition: 'default',
    disposition_reason: 'default',
    cards,
    candidates,
    runbooks: ['pack/runbook.md#anchor'],
    rendered_at: '2026-11-08T10:00:00.000Z',
    rule_proposals: [],
    evidence_fingerprint: 'sha256:abc',
    ambiguous: false,
    observability_blind: false,
    timeline: [],
    degraded: false,
  } as unknown as StageAReport;
}

const incidentRow = () => ({
  incident_id: INCIDENT_ID,
  cluster_id: 'c1',
  label: REF,
  version: 3,
  state: 'firing',
  severity: 'warning',
  body: { incident_id: INCIDENT_ID, incident_version: 3, cluster_id: 'c1', components: [], candidates: [] },
  updated_at: new Date('2026-11-08T10:00:00Z'),
});

async function setup(opts: {
  rows?: Record<string, Record<string, unknown>[]>;
  report?: StageAReport | null;
  incident?: unknown;
  permission?: boolean;
}): Promise<void> {
  calls = [];
  resolveMock.mockResolvedValue((opts.incident === undefined ? incidentRow() : opts.incident) as never);
  stageAMock.mockResolvedValue(opts.report === undefined ? null : opts.report);
  admit = vi.fn(async () => ({ outcome: 'queued', runId: RUN_ID }));
  authUser = vi.fn(async () => {
    if (opts.permission === false) {
      throw new HttpError(403, 'forbidden', '没有权限 research.request');
    }
    return { kind: 'user', subject: { id: 'alice' }, session: { principalId: 'alice' } };
  });
  const auth = { user: authUser } as unknown as Auth;
  const scheduler = { admit } as unknown as Scheduler;
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerAskRoutes(app, {
    pool: poolFor(opts.rows ?? {}),
    auth,
    scheduler,
  });
  await app.ready();
}

const post = (question: string = QUESTION) =>
  app.inject({
    method: 'POST',
    url: `/v1/incidents/${REF}/ask`,
    payload: { question },
  });

afterEach(async () => {
  await app?.close();
  vi.clearAllMocks();
});

describe('POST /v1/incidents/:incident_ref/ask（受控问答）', () => {
  it('有阶段 A + 有阶段 B 运行 → 200，返回既有结论与 limited:true，不调 scheduler.admit', async () => {
    const report = stageA();
    await setup({
      report,
      rows: {
        runs: [
          {
            run_id: RUN_ID,
            state: 'completed',
            disposition: 'act',
            conclusion_level: 'high',
            root_component: 'Deployment:shop/api',
            summary: '根因是发布',
            started_at: new Date('2026-11-08T10:01:00Z'),
            finished_at: new Date('2026-11-08T10:05:00Z'),
          },
        ],
        proposals: [
          {
            proposal_id: '44444444-4444-4444-8444-444444444444',
            body: { action: 'rollout_undo', rule_id: 'pack/rule-1', expected_effect: '回退上一个版本' },
          },
        ],
      },
    });

    const r = await post();
    expect(r.statusCode).toBe(200);
    const out = r.json() as AskResponse;
    expect(out).toMatchObject({
      incident_id: INCIDENT_ID,
      incident_ref: REF,
      incident_version: 3,
      question: QUESTION,
      limited: true,
    });
    expect(out.answered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.stage_a).toMatchObject({
      report_id: report.report_id,
      disposition: 'default',
      disposition_reason: 'default',
      cards: report.cards,
      candidates: report.candidates,
      runbooks: ['pack/runbook.md#anchor'],
      rendered_at: '2026-11-08T10:00:00.000Z',
    });
    expect(out.research).toMatchObject({
      run_id: RUN_ID,
      state: 'completed',
      disposition: 'act',
      conclusion_level: 'high',
      root_component: 'Deployment:shop/api',
      summary: '根因是发布',
      started_at: '2026-11-08T10:01:00.000Z',
      finished_at: '2026-11-08T10:05:00.000Z',
    });
    expect(out.candidate_actions).toEqual([
      {
        action_id: '44444444-4444-4444-8444-444444444444',
        title: 'pack/rule-1',
        reason: '回退上一个版本',
      },
    ]);
    expect(admit).toHaveBeenCalledTimes(0);

    // 问题文本不拼进 SQL：只作为长度进审计，不进任何查询参数
    const bound = calls.flatMap((c) => c.params);
    expect(bound).not.toContain(QUESTION);
    // 所有查询按 incident_id 参数化
    for (const c of calls) {
      expect(c.params[0]).toBe(INCIDENT_ID);
    }
    // 审计写入，且不落问题原文
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditDetail = auditMock.mock.calls[0]![3] as Record<string, unknown>;
    expect(auditDetail).toMatchObject({
      incident_id: INCIDENT_ID,
      incident_version: 3,
      question_length: QUESTION.length,
      had_stage_a: true,
      research_run_id: RUN_ID,
    });
    expect(JSON.stringify(auditDetail)).not.toContain(QUESTION);
    expect(auditMock.mock.calls[0]![1]).toBe('incident.ask');
    expect(auditMock.mock.calls[0]![2]).toBe('alice');
  });

  it('两者都无 → 202，经 scheduler.admit(..., manual) 触发一次研判，不返回自由回答', async () => {
    await setup({ report: null });
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ run_id: RUN_ID, merged: false, limited: true });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![0]).toMatchObject({ incident_id: INCIDENT_ID });
    expect(admit.mock.calls[0]![1]).toBe('manual');
    // 触发分支也写审计，且不落问题原文
    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditDetail = auditMock.mock.calls[0]![3] as Record<string, unknown>;
    expect(auditDetail).toMatchObject({ had_stage_a: false, research_run_id: RUN_ID });
    expect(JSON.stringify(auditDetail)).not.toContain(QUESTION);
  });

  it('事件不存在 → 404，且不使用研判队列', async () => {
    await setup({ incident: null, report: null });
    const r = await post();
    expect(r.statusCode).toBe(404);
    expect(admit).toHaveBeenCalledTimes(0);
    expect(auditMock).toHaveBeenCalledTimes(0);
  });

  it('没有 research.request 权限 → 403', async () => {
    await setup({ permission: false, report: null });
    const r = await post();
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'forbidden' });
    expect(authUser.mock.calls[0]![1]).toBe('research.request');
    expect(admit).toHaveBeenCalledTimes(0);
    expect(resolveMock).toHaveBeenCalledTimes(0);
  });

  it('请求体不合法（缺 question / 超长 / 额外字段）→ 400，不写审计', async () => {
    await setup({ report: null });
    for (const payload of [{}, { question: '' }, { question: 'x'.repeat(2001) }, { question: 'q', extra: 1 }]) {
      const r = await app.inject({ method: 'POST', url: `/v1/incidents/${REF}/ask`, payload });
      expect(r.statusCode).toBe(400);
    }
    expect(auditMock).toHaveBeenCalledTimes(0);
    expect(admit).toHaveBeenCalledTimes(0);
  });

  it('capped → 429；没有 runId → 409（与 POST /research 一致）', async () => {
    await setup({ report: null });
    admit.mockResolvedValueOnce({ outcome: 'capped', runId: null });
    expect((await post()).statusCode).toBe(429);
    admit.mockResolvedValueOnce({ outcome: 'not_researched', runId: null });
    expect((await post()).statusCode).toBe(409);
  });

  it('最新阶段 B 是 queued 时也返回既有状态，不重新入队', async () => {
    await setup({
      report: stageA(),
      rows: {
        queue: [
          {
            run_id: RUN_ID,
            state: 'queued',
            enqueued_at: new Date('2026-11-08T10:10:00Z'),
            skip_reason: null,
          },
        ],
      },
    });
    const r = await post();
    expect(r.statusCode).toBe(200);
    const out = r.json() as AskResponse;
    expect(out.research).toMatchObject({
      run_id: RUN_ID,
      state: 'queued',
      started_at: '2026-11-08T10:10:00.000Z',
      finished_at: null,
    });
    expect(admit).toHaveBeenCalledTimes(0);
  });

  it('只有阶段 A、没有阶段 B：返回既有报告，不触发新研判', async () => {
    await setup({ report: stageA() });
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect((r.json() as AskResponse).research).toBeNull();
    expect(admit).toHaveBeenCalledTimes(0);
  });
});
