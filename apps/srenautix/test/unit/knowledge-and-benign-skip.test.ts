import type { EvalCase, EvalSnapshot } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/config/server.js';
import { replayCase } from '../../src/eval/leakage.js';
import type { RoleBinding } from '../../src/identity/bindings.js';
import { knowledgeTargets, knowledgeVisible } from '../../src/knowledge/service.js';
import { evaluateBenignPattern, type BenignHistoryRow } from '../../src/scheduler/admission.js';
import { incident, stageA, subgraph } from '../support/scenario.js';

function makeEvalPair(knowledge: EvalSnapshot['context']['knowledge']): { c: EvalCase; s: EvalSnapshot } {
  const inc = incident();
  const c: EvalCase = {
    case_id: 'case-1',
    version: 1,
    suite: 'unit',
    type: 'incident',
    cluster_id: 'test',
    incident_id: inc.incident_id,
    label: inc.label,
    started_at: '2026-10-15T10:00:00Z',
    as_of: '2026-10-15T10:30:00Z',
    pack_timing: 'pack_before_incident',
    truth: {
      root_components: ['StatefulSet:shop/postgres'],
      granularity: 'component',
      mechanism: 'disk full',
      disposition: 'act',
      forbid_evidence_consistent: false,
    },
    truth_source: { kind: 'human', principal: 'oidc:alice', ref: 'fb-1' },
    snapshot_id: '00000000-0000-4000-8000-000000000010',
    derived_from: null,
    leakage: {
      exclude_incident_ids: ['00000000-0000-4000-8000-0000000000aa'],
      learned_from_keys: ['known-key-1'],
      exclude_refs: [],
    },
    created_at: '2026-10-15T11:00:00Z',
    authored_by: null,
  };
  const s: EvalSnapshot = {
    snapshot_id: '00000000-0000-4000-8000-000000000010',
    case_id: 'case-1',
    format_version: 1,
    window: { from: '2026-10-15T09:00:00Z', to: '2026-10-15T10:30:00Z' },
    as_of: '2026-10-15T10:30:00Z',
    context: {
      incident: inc,
      stage_a: stageA(),
      subgraph: subgraph(),
      alerts: [],
      actions: [],
      runbooks: [],
      knowledge,
      cases: [],
      templates: [],
    },
    queries: {
      api_version: 'srenautix.io/query-snapshot/v1',
      snapshot_id: '00000000-0000-4000-8000-000000000010',
      recorded_at: '2026-10-15T10:30:00Z',
      clock_window: { from: '2026-10-15T09:00:00Z', to: '2026-10-15T10:30:00Z' },
      ids: { metrics: null, logs: null, traces: null },
      capabilities: [],
      metrics_dialects: [],
      label_profile: null,
      logs_profile: null,
      entries: [],
      cases: [],
    },
    created_at: '2026-10-15T10:30:00Z',
    source: { kind: 'promoted', ref: null, code_sha: null, pack_lock: null },
  };
  return { c, s };
}

describe('P0-2 回放防泄漏（eval/leakage.ts）', () => {
  it('排除同事件来源、晚于/等于用例开始时间、以及缺少 learned_at 的人工沉淀知识条目', () => {
    const inc = incident();
    const { c, s } = makeEvalPair([
      {
        id: 'learned/past-ok',
        components: ['StatefulSet:shop/postgres'],
        text: '[incident] 历史有效案例',
        learned_from: ['00000000-0000-4000-8000-000000000099'],
        learned_at: '2026-10-01T00:00:00Z',
        source: 'human',
      },
      {
        id: 'learned/same-incident',
        components: ['StatefulSet:shop/postgres'],
        text: '[incident] 本事件自身',
        learned_from: [inc.incident_id],
        learned_at: '2026-10-01T00:00:00Z',
        source: 'human',
      },
      {
        id: 'learned/future-leak',
        components: ['StatefulSet:shop/postgres'],
        text: '[incident] 未来沉淀',
        learned_from: ['00000000-0000-4000-8000-000000000088'],
        learned_at: '2026-10-15T10:00:00Z',
        source: 'human',
      },
      {
        id: 'learned/missing-ts',
        components: ['StatefulSet:shop/postgres'],
        text: '[incident] 无时间戳人工条目',
        learned_from: ['manual/1'],
        learned_at: null,
        source: 'human',
      },
      {
        id: 'pack/static-no-ts',
        components: ['StatefulSet:shop/postgres'],
        text: '领域包静态通用知识',
        learned_from: [],
        learned_at: null,
        source: 'human',
      },
      {
        id: 'pack/future-ts',
        components: ['StatefulSet:shop/postgres'],
        text: '晚于用例时间的领域包知识',
        learned_from: [],
        learned_at: '2026-10-20T00:00:00Z',
        source: 'human',
      },
    ]);

    const { rc, excluded } = replayCase(c, s);
    expect(rc.knowledge.map((k) => k.id)).toEqual(['learned/past-ok', 'pack/static-no-ts']);
    expect(excluded.map((e) => e.ref).sort()).toEqual([
      'learned/future-leak',
      'learned/missing-ts',
      'learned/same-incident',
      'pack/future-ts',
    ]);
  });
});

describe('P0-2 自动良性模式判定（evaluateBenignPattern）', () => {
  const row = (
    id: string,
    code: BenignHistoryRow['reason_code'],
    at: string,
    alertnames: string[] = ['NoisyAlert'],
  ): BenignHistoryRow => ({
    incident_id: id,
    reason_code: code,
    created_at: new Date(at),
    members: alertnames.map((alertname) => ({ alertname })),
  });

  it('至少 3 个不同事件确认为 false_positive/not_actionable 且覆盖当前告警名子集时命中', () => {
    const rows = [
      row('i1', 'false_positive', '2026-11-01T00:00:00Z', ['NoisyAlert']),
      row('i2', 'not_actionable', '2026-11-02T00:00:00Z', ['NoisyAlert', 'CompanionAlert']),
      row('i3', 'false_positive', '2026-11-03T00:00:00Z', ['NoisyAlert']),
    ];
    expect(evaluateBenignPattern(rows, ['NoisyAlert'], 3)).toBe(true);
    expect(evaluateBenignPattern(rows.slice(0, 2), ['NoisyAlert'], 3)).toBe(false);
    // 子集护栏：新出现未在历史良性事件中见过的告警名时不跳过
    expect(evaluateBenignPattern(rows, ['NoisyAlert', 'NewSymptomAlert'], 3)).toBe(false);
  });

  it('planned_change 不计入自动良性跳过', () => {
    const rows = [
      row('i1', 'planned_change', '2026-11-01T00:00:00Z'),
      row('i2', 'planned_change', '2026-11-02T00:00:00Z'),
      row('i3', 'planned_change', '2026-11-03T00:00:00Z'),
      row('i4', 'false_positive', '2026-11-04T00:00:00Z'),
      row('i5', 'not_actionable', '2026-11-05T00:00:00Z'),
    ];
    expect(evaluateBenignPattern(rows, ['NoisyAlert'], 3)).toBe(false);
  });

  it('出现更新的非良性反馈后清零计数，直到其后再累计满 3 次良性确认', () => {
    const withLaterReal = [
      row('i1', 'false_positive', '2026-11-01T00:00:00Z'),
      row('i2', 'false_positive', '2026-11-02T00:00:00Z'),
      row('i3', 'not_actionable', '2026-11-03T00:00:00Z'),
      row('i4', null, '2026-11-04T00:00:00Z'),
      row('i5', 'false_positive', '2026-11-05T00:00:00Z'),
      row('i6', 'false_positive', '2026-11-06T00:00:00Z'),
    ];
    expect(evaluateBenignPattern(withLaterReal, ['NoisyAlert'], 3)).toBe(false);
    const recovered = [...withLaterReal, row('i7', 'not_actionable', '2026-11-07T00:00:00Z')];
    expect(evaluateBenignPattern(recovered, ['NoisyAlert'], 3)).toBe(true);
  });
});

describe('P0-2 server 配置项 scheduler.auto_benign_skip', () => {
  const minimal = (scheduler?: Record<string, unknown>) => ({
    cluster_id: 'c',
    profile: 'observe',
    public_url: 'https://sre.example.test',
    packs: { dirs: ['/packs'] },
    datasources: { prometheus: { url: 'http://prom:9090' } },
    callers: { tokens_file: '/tokens.yaml' },
    identity: { bindings_dir: '/bindings' },
    audit: { checkpoint_key_file: '/key' },
    notify: {},
    ...(scheduler ? { scheduler } : {}),
  });

  it('默认开启（min_confirmations=3, window=30d），支持关闭与自定义阈值', () => {
    expect(parseServerConfig(minimal()).scheduler.auto_benign_skip).toEqual({
      enabled: true,
      min_confirmations: 3,
      window: '30d',
    });
    expect(
      parseServerConfig(minimal({ auto_benign_skip: { enabled: false, min_confirmations: 5, window: '14d' } }))
        .scheduler.auto_benign_skip,
    ).toEqual({ enabled: false, min_confirmations: 5, window: '14d' });
    expect(() => parseServerConfig(minimal({ auto_benign_skip: { min_confirmations: 0 } }))).toThrow();
  });
});

describe('P0-2 知识列表作用域隔离（knowledgeTargets / knowledgeVisible）', () => {
  const scope = (clusters: string[], namespaces: string[]): RoleBinding[] => [
    {
      subject: { kind: 'group', name: 'g' },
      role: 'viewer',
      scope: { clusters, namespaces, component_labels: {} },
    },
  ];

  it('按集群与命名空间隔离，忽略纯类型名，对集群级与跨命名空间条目 fail-closed', () => {
    const eastShop = scope(['east'], ['shop']);
    const eastPay = scope(['east'], ['pay']);
    const eastAll = scope(['east'], ['*']);
    const westAll = scope(['west'], ['*']);

    // 组件包含类型名 + 带命名空间的组件键
    expect(knowledgeVisible(eastShop, 'east', ['postgres', 'StatefulSet:shop/pg-main'])).toBe(true);
    expect(knowledgeVisible(eastPay, 'east', ['postgres', 'StatefulSet:shop/pg-main'])).toBe(false);
    expect(knowledgeVisible(westAll, 'east', ['postgres', 'StatefulSet:shop/pg-main'])).toBe(false);

    // 仅传类型名但关联了事件根因组件时仍按事件命名空间授权
    expect(knowledgeVisible(eastShop, 'east', ['postgres'], 'StatefulSet:shop/pg-main')).toBe(true);
    expect(knowledgeVisible(eastPay, 'east', ['postgres'], 'StatefulSet:shop/pg-main')).toBe(false);

    // 集群级组件或无组件键：需要 namespaces: ['*']
    expect(knowledgeTargets('east', ['Node:node-a'])).toEqual([{ cluster: 'east', namespace: null, labels: {} }]);
    expect(knowledgeVisible(eastShop, 'east', ['Node:node-a'])).toBe(false);
    expect(knowledgeVisible(eastAll, 'east', ['Node:node-a'])).toBe(true);
    expect(knowledgeVisible(eastShop, 'east', ['postgres'], null)).toBe(false);
    expect(knowledgeVisible(eastAll, 'east', ['postgres'], null)).toBe(true);

    // 跨命名空间组件条目要求同时具备两个命名空间的读权限
    expect(knowledgeVisible(eastShop, 'east', ['Deployment:shop/api', 'Deployment:pay/checkout'])).toBe(false);
    expect(
      knowledgeVisible(scope(['east'], ['shop', 'pay']), 'east', ['Deployment:shop/api', 'Deployment:pay/checkout']),
    ).toBe(true);
  });
});
