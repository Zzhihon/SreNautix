import type { EvidenceResult, Incident, RootCandidate, StageAReport } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { checkBody, openapiValidator } from './openapi-schemas.js';
import { latestStageA, resolveIncidentRef } from '../incident/read.js';
import { principalOf, type Auth } from '../identity/auth.js';
import type { Scheduler } from '../scheduler/admission.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import { HttpError, notFound } from './errors.js';

/**
 * 事件页「受控问答」的依赖。只复用已有的阶段 A / 阶段 B 数据与人工研判队列，
 * 不引入新的模型调用面：模型密钥只在 worker，server 不持有。
 */
export interface AskRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  scheduler: Scheduler;
}

/** 候选动作，来自已存在的提议（只返回 id 与描述，不创建提议、不执行）。 */
export interface CandidateAction {
  action_id: string;
  title: string;
  reason: string;
}

/** 一次阶段 B 运行（含 queued 状态）的结构化摘要。 */
export interface AskResearchRun {
  run_id: string;
  state: string;
  disposition: string | null;
  conclusion_level: string | null;
  root_component: string | null;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
}

/** 200 响应：对某条事件既有阶段 A 报告 + 阶段 B 研判结论 + 候选动作的受控解释。 */
export interface AskResponse {
  incident_id: string;
  incident_ref: string;
  incident_version: number;
  question: string;
  answered_at: string;
  stage_a: {
    report_id: string;
    disposition: string;
    disposition_reason: string;
    cards: EvidenceResult[];
    candidates: RootCandidate[];
    runbooks: string[];
    rendered_at: string;
  } | null;
  research: AskResearchRun | null;
  candidate_actions: CandidateAction[];
  /** 固定字面量，明确告知前端这是受控解释，不是自由回答 */
  limited: true;
}

const askBody = openapiValidator<{ question: string }>('openapi.yaml', 'AskRequest');

interface ResearchRow {
  run_id: string;
  state: string;
  disposition: string | null;
  conclusion_level: string | null;
  root_component: string | null;
  summary: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface QueueRow {
  run_id: string;
  state: string;
  enqueued_at: Date;
  skip_reason: string | null;
}

interface ProposalRow {
  proposal_id: string;
  body: {
    action?: string;
    expected_effect?: string;
    rule_id?: string | null;
  };
}

const iso = (d: Date): string => d.toISOString();

/** 阶段 A 报告中要回显的字段；其余字段（时间线、指纹等）不是受控诊断的答复内容。 */
function stageAView(r: StageAReport): AskResponse['stage_a'] {
  return {
    report_id: r.report_id,
    disposition: r.disposition,
    disposition_reason: r.disposition_reason,
    cards: r.cards,
    candidates: r.candidates,
    runbooks: r.runbooks,
    rendered_at: r.rendered_at,
  };
}

/**
 * 候选动作只列「已存在」的提议，按状态过滤到当前有效的提议集合；顺序稳定，便于前端对照。
 * 只读 server.proposals，不写、不执行、不创建提议（propose_action_v1 / POST /v1/proposals 的边界）。
 */
const CANDIDATE_STATES = ['awaiting_approval', 'approved', 'held'] as const;

/**
 * 事件页「受控问答」（contract/openapi.yaml 的 askIncident）。问题文本一律当不可信数据：
 * 只回显与计长度，不拼进 SQL、不进提示词、不变成动作参数、不落审计。
 */
export function registerAskRoutes(app: FastifyInstance, d: AskRouteDeps): void {
  app.post('/v1/incidents/:incident_ref/ask', async (req, reply) => {
    const caller = await d.auth.user(req, 'research.request');
    const ref = (req.params as { incident_ref: string }).incident_ref;
    const { question } = checkBody(askBody, req.body);

    const inc = await resolveIncidentRef(d.pool, ref);
    if (!inc) {
      throw notFound('没有这个事件');
    }
    const stageA = await latestStageA(d.pool, inc.incident_id);

    // 最新一次阶段 B 运行：优先取 research_runs 里最近完成的；没有已落库的运行时，
    // 再看仍在队列（queued / leased / skipped）的运行，让 queued 状态也能被解释。
    const runs = await d.pool.query<ResearchRow>(
      `SELECT run_id, state, disposition, conclusion_level, root_component, summary, started_at, finished_at
         FROM server.research_runs WHERE incident_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [inc.incident_id],
    );
    const queued = await d.pool.query<QueueRow>(
      `SELECT run_id, state, enqueued_at, skip_reason FROM server.research_queue
         WHERE incident_id = $1 AND state IN ('queued', 'leased', 'skipped') ORDER BY enqueued_at DESC`,
      [inc.incident_id],
    );
    const done = runs.rows[0];
    // 已经落进 research_runs 的运行不再当「排队中」，与 GET /research 的 known 去重一致
    const pending = done ? queued.rows.find((q) => q.run_id !== done.run_id) : queued.rows[0];
    let research: AskResearchRun | null = null;
    if (done && (!pending || pending.enqueued_at <= done.started_at)) {
      research = {
        run_id: done.run_id,
        state: done.state,
        disposition: done.disposition,
        conclusion_level: done.conclusion_level,
        root_component: done.root_component,
        summary: done.summary,
        started_at: iso(done.started_at),
        finished_at: done.finished_at ? iso(done.finished_at) : null,
      };
    } else if (pending) {
      research = {
        run_id: pending.run_id,
        state: pending.state === 'skipped' ? 'stage_a_only' : pending.state,
        disposition: null,
        conclusion_level: null,
        root_component: null,
        summary: pending.skip_reason ? `跳过：${pending.skip_reason}` : null,
        started_at: iso(pending.enqueued_at),
        finished_at: pending.state === 'skipped' ? iso(pending.enqueued_at) : null,
      };
    }

    // 没有任何阶段 A 报告、也没有任何阶段 B 运行时，才复用既有人工研判队列触发一次。
    // capped / 无 runId 与 POST /research 一致（429 / 409）。
    if (!stageA && !research) {
      const r = await d.scheduler.admit(inc.body as Incident, 'manual');
      if (r.outcome === 'capped') {
        throw new HttpError(429, 'research_capped', '该事件 6 小时内的模型研判已达上限');
      }
      if (!r.runId) {
        throw new HttpError(409, r.outcome, `没有入队：${r.outcome}`);
      }
      await tx(d.pool, (c) =>
        appendAudit(c, 'incident.ask', principalOf(caller), {
          incident_id: inc.incident_id,
          incident_version: inc.version,
          question_length: question.length,
          had_stage_a: false,
          research_run_id: r.runId,
        }),
      );
      return reply.code(202).send({ run_id: r.runId, merged: r.outcome === 'duplicate', limited: true });
    }

    // 已有结论：直接返回既有结构化诊断，不触发新研判（避免重复消耗模型预算）。
    const proposals = await d.pool.query<ProposalRow>(
      `SELECT proposal_id, body FROM server.proposals
         WHERE incident_id = $1 AND state = ANY($2::text[]) ORDER BY created_at DESC`,
      [inc.incident_id, [...CANDIDATE_STATES]],
    );
    const candidate_actions: CandidateAction[] = proposals.rows.map((p) => ({
      action_id: p.proposal_id,
      title: p.body.rule_id ?? p.body.action ?? p.proposal_id,
      reason: p.body.expected_effect ?? '',
    }));

    await tx(d.pool, (c) =>
      appendAudit(c, 'incident.ask', principalOf(caller), {
        incident_id: inc.incident_id,
        incident_version: inc.version,
        question_length: question.length,
        had_stage_a: stageA !== null,
        research_run_id: research?.run_id ?? null,
      }),
    );

    const out: AskResponse = {
      incident_id: inc.incident_id,
      incident_ref: ref,
      incident_version: inc.version,
      question,
      answered_at: new Date().toISOString(),
      stage_a: stageA ? stageAView(stageA) : null,
      research,
      candidate_actions,
      limited: true,
    };
    return reply.code(200).send(out);
  });
}
