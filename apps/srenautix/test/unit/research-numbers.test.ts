import type { ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { auditText, buildCorpus, unsupportedClaims } from '../../src/research/numbers.js';
import { auditModelText } from '../../src/research/validate.js';

// 模型文字的数值审计（ADR 0125）：证据里找不到的数值连同所在分句删除

const corpus = buildCorpus(
  ['峰值 96.5%', '5 个 Pod 在窗口内未就绪', 'gateway-0 OOMKilled', '1 个 init 容器运行超过 41 分钟'],
  [0.977, 0.9, 1471],
  ['2026-10-20T15:59:52.371Z', '2026-10-20T16:24:25.128Z'],
);

describe('数值审计', () => {
  it('证据里有的数值、百分比的比例形式、时刻都能核实', () => {
    expect(unsupportedClaims('内存峰值 96.5%，gateway-4 达到 97.7%，阈值 90%', corpus)).toEqual([]);
    expect(unsupportedClaims('15:59:52 发布，16:24 回退', corpus)).toEqual([]);
    expect(unsupportedClaims('5 个 Pod 未就绪，init 等待 41 分钟，同步超时 1471 秒', corpus)).toEqual([]);
  });

  it('标识符与命令中的数字不算数值断言', () => {
    expect(
      unsupportedClaims('重建 gateway-4；kubectl logs deploy/control --tail=50；canary-147f17829ea1；card:38', corpus),
    ).toEqual([]);
  });

  it('找不到的数值、时刻与小数都报告出来', () => {
    expect(unsupportedClaims('内存峰值 37–57%', corpus)).toEqual(['57%']);
    expect(unsupportedClaims('17:42 恢复', corpus)).toEqual(['17:42']);
    expect(unsupportedClaims('连接池上限 3.5 倍', corpus)).toEqual(['3.5 倍']);
    expect(unsupportedClaims('使用率 0.42', corpus)).toEqual(['0.42']);
  });

  it('删除含无法核实数值的分句，保留其余分句', () => {
    const r = auditText('canary 调低了内存 limit，内存峰值 37–57% 是旧版本的读数，Pod 被 OOMKilled。', corpus);
    expect(r.text).toBe('canary 调低了内存 limit，Pod 被 OOMKilled。');
    expect(r.removed).toEqual(['57%']);
    // 因果链中的一环与括号内的补充说明分别删除，其余环节保留
    const chain = auditText(
      '新版本常驻内存上升（内存峰值 37–57% 是旧 limit 下的读数）→ Pod 被 OOMKilled → 同步 9 分钟后超时 → PDB 阻塞驱逐',
      corpus,
    );
    expect(chain.text).toBe('新版本常驻内存上升→ Pod 被 OOMKilled → PDB 阻塞驱逐');
    expect(chain.removed).toEqual(['57%', '9 分钟']);
    const kept = auditText('gateway-4 未就绪，峰值 96.5%。', corpus);
    expect(kept).toEqual({ text: 'gateway-4 未就绪，峰值 96.5%。', removed: [] });
  });

  it('研判输出中四处模型文字都经过审计，删除写入说明；步骤都被删除的建议整条删除', () => {
    const out: ResearchOutput = {
      disposition: 'escalate',
      conclusion: {
        level: 'inconclusive',
        hypothesis_id: null,
        root_component: null,
        undetermined_reason: '缺少数据，错误率 12% 无法解释',
        consistency: {
          entity_in_scope: false,
          onset_precedes_symptom: false,
          no_contrary_normal: false,
          competitor_tested: false,
        },
      },
      hypotheses: [
        {
          id: 'h1',
          parent_id: null,
          root_component: 'StatefulSet:shop/gateway',
          mechanism: '内存峰值 96.5%，比基线高 3 倍',
          supporting: [],
          refuting: [],
          status: 'supported',
        },
      ],
      next_checks: [],
      situation: '',
      summary: '同步超时 1471 秒，持续 88 分钟',
      recommendations: [
        {
          id: 'r1',
          kind: 'mitigation',
          title: '扩容到 7 个副本',
          rationale: '',
          steps: ['调到 7 个副本'],
          owner: 'oncall',
          risk: 'low',
          risk_note: null,
          runbook_ref: null,
          action_id: null,
          hypothesis_id: 'h1',
          evidence_refs: [],
          generated_by: 'model',
        },
      ],
      proposals: [],
      validation_notes: [],
    };
    const r = auditModelText(out, corpus);
    expect(r.output.hypotheses[0]?.mechanism).toBe('内存峰值 96.5%');
    expect(r.output.summary).toBe('同步超时 1471 秒');
    expect(r.output.conclusion.undetermined_reason).toBe('缺少数据');
    expect(r.output.recommendations).toEqual([]);
    expect(r.notes).toEqual([
      '修复建议 r1 的第 1 步：删除无法核实的数值 7 个',
      '修复建议 r1：步骤都含无法核实的数值，已删除',
      '假设 h1 的机制：删除无法核实的数值 3 倍',
      '结论摘要：删除无法核实的数值 88 分钟',
      '无法判定的原因：删除无法核实的数值 12%',
    ]);
  });
});
