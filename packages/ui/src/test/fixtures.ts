// 组件测试的样例数据。每个样例都先用契约的 JSON Schema 校验（assertValid），保证测试里的数据
// 与中心 API 返回的结构一致；OpenAPI 组件（ProposalDetail、ResearchRun）中嵌入的契约对象同样逐个校验。

import { assertValid } from '@srenautix/contract';
import type {
  Condition,
  EvidenceResult,
  Feedback,
  Incident,
  Proposal,
  ProposalDetail,
  ResearchOutput,
  ResearchRun,
} from '../contract';

const T0 = '2026-10-19T06:18:00Z';
const SHA = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;

export function evidence(
  over: Partial<EvidenceResult> & Pick<EvidenceResult, 'ref' | 'display_state'>,
): EvidenceResult {
  const verdict = over.display_state === 'capability_missing' ? 'undeterminable' : over.display_state;
  const base: EvidenceResult = {
    card_id: 'postgres/memory/working-set',
    title: { 'zh-CN': '主库内存达到上限', en: 'Primary memory at limit' },
    entity: {
      cluster_id: 'prod',
      kind: 'Pod',
      namespace: 'db',
      name: 'pg-main-1',
      uid: '7c1e2c4a-0000-4000-8000-000000009a20',
    },
    window: { from: '2026-10-19T05:48:00Z', to: '2026-10-19T06:28:00Z' },
    reason: { kind: over.display_state === 'normal' ? 'all_clear' : 'rule', text: 'working_set / limit = 1.00' },
    value: '100%',
    threshold: 0.9,
    table: null,
    series: [
      {
        ref: 'mem',
        labels: { pod: 'pg-main-1' },
        points: [
          [1760854080, 0.62],
          [1760854140, 0.8],
          [1760854200, null],
          [1760854260, 1],
        ],
      },
    ],
    queries: [
      {
        name: 'mem',
        integration: 'prometheus',
        capability: 'metrics.query_range',
        query: 'max(container_memory_working_set_bytes{pod="pg-main-1"})',
        sample_count: 4,
        truncated: false,
        error: null,
        duration_ms: 120,
      },
    ],
    egress: 'redact',
    anomaly_started_at: '2026-10-19T06:17:52Z',
    evaluated_at: '2026-10-19T06:20:41Z',
    ...over,
    verdict,
  } as EvidenceResult;
  return assertValid<EvidenceResult>('schemas/evidence-result.schema.json', base);
}

export function incident(over: Partial<Incident> = {}): Incident {
  const base = {
    incident_id: '3f2b8c1e-5d6a-4b7c-8d9e-0a1b2c3d4e5f',
    cluster_id: 'prod',
    label: 'postgres.cluster:db/pg-main:2026-10-19T06:10:00Z',
    incident_version: 3,
    state: 'firing',
    severity: 'critical',
    first_firing_at: T0,
    ended_at: null,
    root: {
      component: 'postgres.cluster:db/pg-main',
      entity: null,
      ambiguous: false,
      margin: 0.29,
      silent_root: false,
    },
    candidates: [],
    members: [],
    components: ['postgres.cluster:db/pg-main', 'Deployment:app/gateway', 'StatefulSet:app/worker'],
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 41,
    created_at: T0,
    updated_at: '2026-10-19T06:24:10Z',
    ...over,
  };
  return assertValid<Incident>('schemas/incident.schema.json', base);
}

export function proposal(over: Partial<Proposal> = {}): Proposal {
  const base = {
    proposal_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    idempotency_key: SHA('a'),
    cluster_id: 'prod',
    incident_id: '3f2b8c1e-5d6a-4b7c-8d9e-0a1b2c3d4e5f',
    binding: { incident_version: 3, root_component: 'postgres.cluster:db/pg-main', evidence_fingerprint: SHA('b') },
    source: 'rule',
    research_run_id: null,
    rule_id: 'workload/stuck-init',
    caller_id: null,
    action: 'pod_restart',
    level: 'reversible_recreatable',
    tier: 'L',
    auto_eligible: false,
    params: { pod: 'worker-1' },
    params_hash: SHA('c'),
    canon_version: 'jcs-sha256-v1',
    target: {
      cluster_id: 'prod',
      kind: 'Pod',
      namespace: 'app',
      name: 'worker-1',
      uid: '11111111-2222-4333-8444-555555555555',
      display: 'app/worker-1',
    },
    hypothesis_id: null,
    evidence_refs: ['card:1'],
    expected_effect: 'worker-1 就绪',
    state: 'awaiting_approval',
    policy_checks: [{ name: 'namespace_allowed', passed: true, detail: 'app 在允许范围内' }],
    approval: null,
    execution: null,
    ttl_expires_at: '2026-10-19T06:32:00Z',
    first_delivered_at: '2026-10-19T06:21:00Z',
    created_at: '2026-10-19T06:21:00Z',
    updated_at: '2026-10-19T06:21:00Z',
    ...over,
  };
  return assertValid<Proposal>('schemas/proposal.schema.json', base);
}

export function proposalDetail(p: Proposal, over: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    proposal: p,
    target_state: { exists: true, uid: p.target.uid, resource_version: '81234', summary: 'Init:0/1 8m' },
    prechecks: [
      { name: 'controller_ready', passed: true, detail: 'StatefulSet 就绪 1/2' },
      { name: 'pdb_headroom', passed: true, detail: 'PDB 余量 1' },
    ],
    prechecked_at: '2026-10-19T06:21:05Z',
    blast_radius: { summary: '1 个 Pod', objects: ['Pod app/worker-1'], within_limit: true },
    conflict_domain: 'workload:app/worker',
    queue_position: null,
    verify: { condition: 'worker-1 Ready', window: '10m' },
    undo: { kind: 'controller_rebuild', description: '控制器自动重建' },
    policy_rule: 'standard/l-tier-recreatable',
    model_rationale: 'worker-1 的 init 容器在等待迁移锁，重启后会重新获取。',
    ...over,
  };
}

export function feedback(over: Partial<Feedback> = {}): Feedback {
  const base = {
    feedback_id: '0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a',
    incident_id: '3f2b8c1e-5d6a-4b7c-8d9e-0a1b2c3d4e5f',
    incident_version: 3,
    research_run_id: null,
    verdict: 'confirmed',
    root_component: 'postgres.cluster:db/pg-main',
    disposition_verdict: 'confirmed',
    disposition: 'act',
    mechanism: null,
    reason: null,
    principal_id: 'oncall-a',
    channel: 'console',
    linked: true,
    implicit: null,
    stale: false,
    created_at: '2026-10-19T06:30:00Z',
    ...over,
  };
  return assertValid<Feedback>('schemas/feedback.schema.json', base);
}

export function condition(over: Partial<Condition> & Pick<Condition, 'type'>): Condition {
  const base = {
    status: 'true',
    role: 'server',
    cluster_id: 'prod',
    subject: null,
    reason: 'test',
    message: '最近 6 分钟没有收到任何告警',
    since: '2026-10-19T06:02:00Z',
    ...over,
  };
  return assertValid<Condition>('schemas/condition.schema.json', base);
}

export function researchOutput(): ResearchOutput {
  const out = {
    disposition: 'act',
    conclusion: {
      level: 'evidence_consistent',
      hypothesis_id: 'h1',
      root_component: 'postgres.cluster:db/pg-main',
      undetermined_reason: null,
      consistency: {
        entity_in_scope: true,
        onset_precedes_symptom: true,
        no_contrary_normal: true,
        competitor_tested: true,
      },
    },
    hypotheses: [
      {
        id: 'h1',
        parent_id: null,
        root_component: 'postgres.cluster:db/pg-main',
        mechanism: '主库内存超限被 OOMKill',
        supporting: ['card:1'],
        refuting: [],
        status: 'supported',
      },
      {
        id: 'h2',
        parent_id: null,
        root_component: 'Deployment:app/control',
        mechanism: '发布引入错误',
        supporting: [],
        refuting: ['card:3'],
        status: 'refuted',
      },
      {
        id: 'h3',
        parent_id: 'h1',
        root_component: 'Node:node-1',
        mechanism: '节点内存压力',
        supporting: [],
        refuting: [],
        status: 'inconclusive',
      },
    ],
    next_checks: [
      {
        hypothesis_id: 'h2',
        type: 'query',
        template: 'workload/error-rate-after-rollout',
        args: {},
        refutes_if: '发布后错误率不高于基线',
        purpose: '检查发布后的错误率',
        result_ref: 'card:3',
        outcome: 'refutes',
      },
    ],
    situation: '主库 OOM 后切换',
    summary: 'pg-main-1 因内存超限被 OOMKill，CNPG 切换到 pg-main-2。',
    recommendations: [],
    proposals: [],
    validation_notes: ['删除了无效引用 card:9'],
  };
  return assertValid<ResearchOutput>('schemas/research-output.schema.json', out);
}

export function researchRun(over: Partial<ResearchRun> = {}): ResearchRun {
  return {
    run_id: '6c5d4e3f-2a1b-4c0d-8e9f-a0b1c2d3e4f5',
    incident_id: '3f2b8c1e-5d6a-4b7c-8d9e-0a1b2c3d4e5f',
    incident_version: 3,
    reason: 'new_incident',
    state: 'completed',
    disposition: 'act',
    conclusion_level: 'evidence_consistent',
    root_component: 'postgres.cluster:db/pg-main',
    summary: 'pg-main-1 因内存超限被 OOMKill。',
    started_at: '2026-10-19T06:20:41Z',
    finished_at: '2026-10-19T06:22:10Z',
    stop_reason: 'leader_supported',
    steps: [
      { state: 'queued', started_at: '2026-10-19T06:20:41Z', finished_at: '2026-10-19T06:20:47Z' },
      { state: 'hypothesize', started_at: '2026-10-19T06:20:47Z', finished_at: '2026-10-19T06:21:18Z' },
      { state: 'discriminate', started_at: '2026-10-19T06:21:18Z', finished_at: '2026-10-19T06:21:33Z' },
      { state: 'conclude', started_at: '2026-10-19T06:21:33Z', finished_at: '2026-10-19T06:22:10Z' },
    ],
    evidence: [],
    output: researchOutput(),
    llm_calls: [
      {
        seq: 1,
        phase: 'hypothesize',
        route_id: 'route-b',
        model: 'model-b',
        prompt_hash: SHA('d'),
        outcome: 'succeeded',
        repair_step: null,
        usage: { input_tokens: 21480, cached_input_tokens: 0, output_tokens: 2310, reasoning_tokens: 0 },
        cost: 0.21,
        duration_ms: 31200,
        redaction_hits: 2,
        at: '2026-10-19T06:20:47Z',
      },
    ],
    tool_calls: [
      {
        seq: 1,
        at: '2026-10-19T06:21:18Z',
        tool: 'metrics.query_range',
        arguments: {},
        window: { from: '2026-10-19T06:06:00Z', to: '2026-10-19T06:20:00Z' },
        limit_applied: 300,
        result_size: 120,
        truncated: false,
        duration_ms: 1400,
        error: null,
        result_ref: 'card:3',
      },
    ],
    budget: { estimated_input_tokens: 20000, input_tokens: 21480, output_tokens: 2310, cost: 0.21, currency: 'CNY' },
    error: null,
    ...over,
  };
}
