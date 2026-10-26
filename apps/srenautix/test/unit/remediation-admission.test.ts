import type { EvidenceResult, ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import {
  admissionFor,
  isRuntimeQuery,
  repositoryFact,
  resolveCards,
  runAdmission,
} from '../../src/remediation/admission.js';
import { correctCauseScope } from '../../src/research/validate.js';
import { stageACards } from '../support/scenario.js';

// 自愈 PR 的准入条件（ADR 0170）：根因范围的校正、按运行判断的三项条件、告警调优的良性依据、仓库事实

const API = 'Deployment:shop/api';

type Query = EvidenceResult['queries'][number];
const query = (capability: string, name = 'q'): Query => ({
  name,
  integration: 'prometheus',
  capability,
  query: 'x',
  sample_count: 1,
  truncated: false,
  error: null,
  duration_ms: 1,
});

/** 阶段 A 的卡：support/scenario 的 card:1（api 的 5xx 比例），查询能力按参数给出，编号可以改写 */
const stageCard = (capabilities: string[], ref = 'card:1'): EvidenceResult => ({
  ...stageACards()[0]!,
  ref,
  queries: capabilities.map((c) => query(c)),
});

/** 区分性检查产生的卡：check/h1/<n>，实体为 api */
const checkCard = (ref: string, n: number, q: Query[]): EvidenceResult => ({
  ...stageACards()[0]!,
  ref,
  card_id: `check/h1/${n}`,
  queries: q,
});

function output(o: {
  scope?: ResearchOutput['conclusion']['cause_scope'];
  support?: string[];
  modelJudged?: string[];
  alerts?: string[];
  detail?: boolean;
  disposition?: ResearchOutput['disposition'];
  basis?: ResearchOutput['ignore_basis'];
  checks?: EvidenceResult[];
  index?: Array<{ ref: string; target: string }>;
}): ResearchOutput {
  return {
    disposition: o.disposition ?? 'act',
    ...(o.basis ? { ignore_basis: o.basis } : {}),
    conclusion: {
      level: 'likely',
      hypothesis_id: 'h1',
      root_component: API,
      undetermined_reason: null,
      consistency: {
        entity_in_scope: true,
        onset_precedes_symptom: true,
        no_contrary_normal: true,
        competitor_tested: false,
      },
      ...(o.detail === false
        ? {}
        : {
            consistency_detail: {
              support_refs: o.support ?? ['card:1'],
              model_judged_refs: o.modelJudged ?? [],
              support_alerts: o.alerts ?? [],
              onset: null,
              symptom_onset_at: '2026-09-01T10:06:00.000Z',
              tolerance_seconds: 120,
              contrary_refs: [],
              tested_competitors: [],
              supported_competitors: [],
              chosen_by: 'model',
            },
          }),
      ...(o.scope ? { cause_scope: o.scope } : {}),
    },
    hypotheses: [],
    next_checks: [],
    situation: '',
    summary: '',
    recommendations: [],
    proposals: [],
    validation_notes: [],
    check_cards: o.checks ?? [],
    evidence_index: o.index ?? [{ ref: 'card:1', target: `workload/http/error_ratio@${API}` }],
  };
}

describe('根因范围的校正', () => {
  const facts = { external: ['Service:shop/payments-provider'], repository_owned: [API] };

  it('仓库负责的根因保留模型的取值，不写备注', () => {
    for (const model of ['local', 'configuration', 'downstream', 'infrastructure', 'unknown'] as const) {
      expect(correctCauseScope({ model, level: 'likely', root: API, facts })).toEqual({ scope: model, notes: [] });
    }
  });

  it('外部组件为根因时改为 upstream；结论 undetermined 或没有根因时为 unknown', () => {
    expect(
      correctCauseScope({ model: 'local', level: 'likely', root: 'Service:shop/payments-provider', facts }),
    ).toEqual({
      scope: 'upstream',
      notes: ['根因范围由 local 改为 upstream：研判根因 Service:shop/payments-provider 是领域包声明在集群之外的组件'],
    });
    expect(
      correctCauseScope({ model: 'upstream', level: 'likely', root: 'Service:shop/payments-provider', facts }).notes,
    ).toEqual([]);
    expect(correctCauseScope({ model: 'local', level: 'undetermined', root: API, facts })).toEqual({
      scope: 'unknown',
      notes: ['根因范围由 local 改为 unknown：结论为 undetermined'],
    });
    expect(correctCauseScope({ model: 'configuration', level: 'inconclusive', root: null, facts })).toEqual({
      scope: 'unknown',
      notes: ['根因范围由 configuration 改为 unknown：没有选中根因'],
    });
  });

  it('根因不由仓库负责时 local 与 configuration 改为 unknown，其余范围不变；没有处置依据时同样处理', () => {
    const root = 'Node:node-a';
    expect(correctCauseScope({ model: 'configuration', level: 'likely', root, facts })).toEqual({
      scope: 'unknown',
      notes: [
        '根因范围由 configuration 改为 unknown：研判根因 Node:node-a 不由 GitOps 仓库负责（不是仓库声明的组件，也不是管理它们的 GitOps 应用）',
      ],
    });
    expect(correctCauseScope({ model: 'infrastructure', level: 'likely', root, facts }).scope).toBe('infrastructure');
    expect(correctCauseScope({ model: 'local', level: 'likely', root: API, facts: null }).scope).toBe('unknown');
    // 契约 2.38.0 之前的依据没有 repository_owned
    expect(correctCauseScope({ model: 'local', level: 'likely', root: API, facts: { external: [] } }).scope).toBe(
      'unknown',
    );
  });
});

describe('运行时证据与卡的解析', () => {
  it('指标、日志、数据库统计与 kube_* 只读检查是运行时证据；变更、链路与其他工具不是', () => {
    for (const c of ['metrics.query', 'metrics.query_range', 'logs.match', 'logs.query', 'dbstats.statements_top']) {
      expect(isRuntimeQuery(query(c))).toBe(true);
    }
    expect(isRuntimeQuery(query('tool', 'kube_pod_status'))).toBe(true);
    expect(isRuntimeQuery(query('tool', 'kube_logs'))).toBe(true);
    for (const c of ['changes.list', 'traces.search', 'traces.service_graph']) {
      expect(isRuntimeQuery(query(c))).toBe(false);
    }
    expect(isRuntimeQuery(query('tool', 'github_commits'))).toBe(false);
  });

  it('阶段 A 的卡按 evidence_index 的 <卡片>@<实体> 解析，不按编号；检查卡按引用在 check_cards 中找；找不到时为 null', () => {
    const check = checkCard('card:6', 1, [query('tool', 'kube_events')]);
    const out = output({
      checks: [check],
      index: [
        { ref: 'card:1', target: `workload/http/error_ratio@${API}` },
        { ref: 'card:6', target: `check/h1/1@${API}` },
        { ref: 'card:7', target: `pvc/capacity/used_ratio@PersistentVolumeClaim:shop/gone` },
      ],
    });
    // 研判之后阶段 A 重算，同一张卡的编号变成 card:3
    const cards = [stageCard(['metrics.query'], 'card:3'), stageACards()[1]!];
    const r = resolveCards(out, cards, ['card:1', 'card:6', 'card:7', 'card:9']);
    expect(r.get('card:1')?.card_id).toBe('workload/http/error_ratio');
    expect(r.get('card:1')?.ref).toBe('card:3');
    expect(r.get('card:6')).toBe(check);
    expect(r.get('card:7')).toBeNull();
    expect(r.get('card:9')).toBeNull();
  });
});

describe('按运行判断的准入条件', () => {
  const cards = [stageCard(['metrics.query_range'])];

  it('根因范围为 local 或 configuration、支撑卡有指标查询时准入；告警调优要求 ignore', () => {
    for (const scope of ['local', 'configuration'] as const) {
      const a = runAdmission({ output: output({ scope }), disposition: 'act', stageACards: cards });
      expect(a.general).toBeNull();
      expect(a.alertRule).toEqual({ code: 'not_benign', reason: '处置为 act，告警调优只在处置为 ignore 时提出' });
      expect(admissionFor('config_resource', a)).toBeNull();
      expect(admissionFor('release_rollback', a)).toBeNull();
      expect(admissionFor('alert_rule', a)?.code).toBe('not_benign');
    }
  });

  it('cause_scope：其余范围、研判输出没有根因范围或没有输出时不准入', () => {
    for (const scope of ['downstream', 'upstream', 'infrastructure', 'unknown'] as const) {
      expect(runAdmission({ output: output({ scope }), disposition: 'act', stageACards: cards }).general).toEqual({
        code: 'cause_scope',
        reason: `根因范围为 ${scope}，只有 local 与 configuration（根因由 GitOps 仓库负责）开自愈 PR`,
      });
    }
    expect(runAdmission({ output: output({}), disposition: 'act', stageACards: cards }).general).toEqual({
      code: 'cause_scope',
      reason: '根因范围为 空（研判输出没有根因范围），只有 local 与 configuration（根因由 GitOps 仓库负责）开自愈 PR',
    });
    const none = runAdmission({ output: null, disposition: 'act', stageACards: cards });
    expect(none.general?.code).toBe('cause_scope');
    expect(none.alertRule?.code).toBe('not_benign');
  });

  it('topology_only：没有支撑卡，只有成员告警与变更，或没有选中假设的依据', () => {
    expect(
      runAdmission({
        output: output({ scope: 'local', support: [], alerts: ['alert:1', 'alert:2'] }),
        disposition: 'act',
        stageACards: cards,
      }).general,
    ).toEqual({ code: 'topology_only', reason: '结论没有支撑卡，只有 2 条成员告警与变更支撑' });
    expect(
      runAdmission({ output: output({ scope: 'local', support: [] }), disposition: 'act', stageACards: cards }).general,
    ).toEqual({ code: 'topology_only', reason: '结论没有支撑卡，只有拓扑关系与变更支撑' });
    expect(
      runAdmission({ output: output({ scope: 'local', detail: false }), disposition: 'act', stageACards: cards })
        .general?.code,
    ).toBe('topology_only');
  });

  it('no_runtime_evidence：支撑卡只有变更或链路查询、没有查询，或在研判运行的证据里找不到', () => {
    const changes = runAdmission({
      output: output({ scope: 'local', support: ['card:1', 'card:4'] }),
      disposition: 'act',
      stageACards: [stageCard(['changes.list', 'traces.search'])],
    }).general;
    expect(changes).toEqual({
      code: 'no_runtime_evidence',
      reason:
        '支撑卡 card:1（changes.list、traces.search）、card:4（研判运行的证据里找不到）都不是运行时证据（指标、日志、数据库统计或 Kubernetes 只读检查）',
    });
    expect(
      runAdmission({ output: output({ scope: 'local' }), disposition: 'act', stageACards: [stageCard([])] }).general,
    ).toEqual({
      code: 'no_runtime_evidence',
      reason: '支撑卡 card:1（没有查询）都不是运行时证据（指标、日志、数据库统计或 Kubernetes 只读检查）',
    });
  });

  it('小模型判定的 kube_* 只读检查卡（model_judged_refs）是运行时证据；其他工具不是', () => {
    const kube = checkCard('card:6', 1, [query('tool', 'kube_pod_status')]);
    const ok = output({
      scope: 'configuration',
      support: [],
      modelJudged: ['card:6'],
      checks: [kube],
      index: [{ ref: 'card:6', target: `check/h1/1@${API}` }],
    });
    expect(runAdmission({ output: ok, disposition: 'act', stageACards: [] }).general).toBeNull();
    const other = checkCard('card:6', 1, [query('tool', 'github_commits')]);
    expect(
      runAdmission({ output: { ...ok, check_cards: [other] }, disposition: 'act', stageACards: [] }).general?.code,
    ).toBe('no_runtime_evidence');
  });

  it('告警调优：处置为 ignore 且依据为阶段 A 的确定性 ignore、卡全部正常或影响卡全部正常时准入', () => {
    for (const basis of ['stage_a', 'evidence_normal', 'impact_normal'] as const) {
      const a = runAdmission({
        output: output({ scope: 'unknown', disposition: 'ignore', basis }),
        disposition: 'ignore',
        stageACards: cards,
      });
      expect(a.alertRule).toBeNull();
      expect(a.general?.code).toBe('cause_scope');
    }
    for (const basis of ['planned_retirement', 'external'] as const) {
      expect(
        runAdmission({ output: output({ disposition: 'ignore', basis }), disposition: 'ignore', stageACards: cards })
          .alertRule,
      ).toEqual({
        code: 'not_benign',
        reason: `ignore 的依据为 ${basis}，不说明系统状态正常；告警调优要求依据为阶段 A 的确定性 ignore、得出结论的卡全部正常或影响卡全部正常`,
      });
    }
    expect(
      runAdmission({ output: output({ disposition: 'ignore' }), disposition: 'ignore', stageACards: cards }).alertRule
        ?.reason,
    ).toContain('ignore 的依据为 空（研判输出没有依据）');
    // 研判记录的处置优先于输出里的处置
    expect(
      runAdmission({
        output: output({ disposition: 'ignore', basis: 'evidence_normal' }),
        disposition: 'escalate',
        stageACards: cards,
      }).alertRule?.code,
    ).toBe('not_benign');
  });
});

describe('仓库事实', () => {
  const file = (before: string) => ({ path: 'apps/shop/workloads.yaml', before, after: 'x' });

  it('文件在基线上存在、研判根因由仓库负责时成立', () => {
    expect(repositoryFact({ files: [file('a: 1\n')] }, API, true)).toBeNull();
  });

  it('计划新建文件、根因不由仓库负责或没有根因时不成立', () => {
    expect(
      repositoryFact({ files: [file('a: 1\n'), { path: 'new.yaml', before: '', after: 'b' }] }, API, true),
    ).toEqual({ code: 'no_repo_fact', reason: '计划修改的文件 new.yaml 在基线上不存在' });
    expect(repositoryFact({ files: [file('a: 1\n')] }, 'Node:node-a', false)).toEqual({
      code: 'no_repo_fact',
      reason: '研判根因 Node:node-a 不由 GitOps 仓库负责（不是仓库声明的组件，也不是管理它们的 GitOps 应用）',
    });
    expect(repositoryFact({ files: [file('a: 1\n')] }, null, false)).toEqual({
      code: 'no_repo_fact',
      reason: '研判没有选中根因',
    });
  });
});
