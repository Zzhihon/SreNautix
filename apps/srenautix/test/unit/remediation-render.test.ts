import type { EvidenceResult, Proposal } from '@srenautix/contract';
import type { RemediationPlan } from '@srenautix/packs-sdk';
import { createPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { composeMessage } from '../../src/notify/compose.js';
import { prFromMessages } from '../../src/remediation/pulls.js';
import { branchOf, cardsOf, keyCards, prBody, validatePlan } from '../../src/remediation/render.js';
import { incident, stageA, stageACards } from '../support/scenario.js';

// 自愈 PR 的纯函数部分（ADR 0108）：补丁校验、PR 描述、卡片上下文、分支名与执行事件里的 PR

const BEFORE = 'groups:\n  - name: shop\n    rules:\n      - alert: A\n        labels: {severity: critical}\n';
const AFTER = BEFORE.replace('critical', 'warning');
const PATH = 'platform/rules/shop.yaml';
const LAYOUT = { alert_rules: { path: 'platform/rules/*.yaml', format: 'yaml' as const } };

function patchOf(path: string, before: string, after: string): string {
  // packs-sdk 的格式：diff --git 头加 a/、b/ 前缀
  const body = createPatch(path, before, after, '', '').split('\n').slice(2).join('\n');
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body.split('\n').slice(2).join('\n')}`;
}

const plan = (over: Partial<RemediationPlan> = {}): RemediationPlan => ({
  kind: 'plan',
  key: 'gitops/noisy-alert-relax',
  pack: 'gitops',
  id: 'noisy-alert-relax',
  category: 'alert_rule',
  repository: 'gitops',
  title: { 'zh-CN': '降低长期告警的严重度', en: 'Relax a chronic alert' },
  base: 'c'.repeat(40),
  files: [{ path: PATH, before: BEFORE, after: AFTER }],
  locations: [{ path: PATH, kind: null, name: null, locate: 'groups[*].rules[alert=A]' }],
  patch: patchOf(PATH, BEFORE, AFTER),
  change: { 'zh-CN': '告警 A 由 critical 改为 warning', en: 'A from critical to warning' },
  verify: { say: { 'zh-CN': '同步后 A 以 warning 触发', en: 'A fires as warning' }, cards: ['x/y/z'], within: '24h' },
  rollback: { say: { 'zh-CN': 'revert 这个 PR 的提交', en: 'Revert the commit' } },
  ...over,
});

describe('补丁校验', () => {
  it('路径在布局里、before 与基准一致、补丁应用后等于 after、after 能解析：没有问题', async () => {
    expect(await validatePlan(plan(), LAYOUT, async () => BEFORE)).toEqual([]);
  });

  it('基准内容已变、路径不在布局里、补丁与 after 不符、after 不能解析：逐项报告', async () => {
    expect(await validatePlan(plan(), LAYOUT, async () => `${BEFORE}# changed\n`)).toEqual([
      { path: PATH, message: expect.stringContaining('与基准提交') },
    ]);
    const other = 'apps/x.yaml';
    expect(
      await validatePlan(
        plan({ files: [{ path: other, before: BEFORE, after: AFTER }], patch: patchOf(other, BEFORE, AFTER) }),
        LAYOUT,
        async () => BEFORE,
      ),
    ).toEqual([{ path: other, message: '路径不在仓库布局的任何文件角色里' }]);
    expect(
      (
        await validatePlan(
          plan({ files: [{ path: PATH, before: BEFORE, after: `${AFTER}# x\n` }] }),
          LAYOUT,
          async () => BEFORE,
        )
      ).map((p) => p.message),
    ).toEqual(['补丁应用到基准内容后与计划的结果不一致']);
    const broken = `${AFTER}  bad: [\n`;
    expect(
      (
        await validatePlan(
          plan({ files: [{ path: PATH, before: BEFORE, after: broken }], patch: patchOf(PATH, BEFORE, broken) }),
          LAYOUT,
          async () => BEFORE,
        )
      ).map((p) => p.message),
    ).toEqual([expect.stringMatching(/^修改后的 YAML 不能解析/)]);
    expect((await validatePlan(plan({ patch: 'x'.repeat(70_000) }), LAYOUT, async () => BEFORE))[0]?.message).toMatch(
      /超过 gitops_pr 的上限/,
    );
  });
});

describe('PR 描述', () => {
  const cards = stageACards();
  const input = {
    lang: 'zh' as const,
    plan: plan(),
    incidentId: '7a1b2c3d-0000-4000-8000-000000000001',
    incidentLabel: 'StatefulSet:shop/postgres:2026-09-01T09:50:00Z',
    root: 'shop/postgres',
    run: { runId: '11111111-2222-4333-8444-555555555555', summary: 'PVC 写满', level: 'likely' },
    cards: keyCards(cards, new Set(['card:2'])),
    consoleUrl: 'https://srenautix.example.test/',
    refs: '#12',
  };

  it('六段固定标题与标记；支持结论的卡在前；Refs 在事件标记之前', () => {
    const b = prBody(input);
    const order = ['summary', 'evidence', 'change', 'verify', 'rollback', 'run'].map((m) =>
      b.indexOf(`<!-- srenautix:pr=${m} -->`),
    );
    expect(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
    expect(b).toContain('## 结论\n\nPVC 写满（可能）');
    expect(b).toContain('合并并同步后 24h 内核对：');
    expect(b).toContain('https://srenautix.example.test/runs/11111111-2222-4333-8444-555555555555');
    expect(b.indexOf('pvc/capacity/used_ratio')).toBeLessThan(b.indexOf('workload/http/error_ratio'));
    expect(b.trimEnd().endsWith('Refs #12\n<!-- srenautix:incident=7a1b2c3d-0000-4000-8000-000000000001 -->')).toBe(
      true,
    );
  });

  it('超过上限时先去掉证据卡，再截短改动说明', () => {
    const long = prBody({ ...input, plan: plan({ change: { 'zh-CN': '长'.repeat(5000) } }) }, 2500);
    expect(long.length).toBeLessThanOrEqual(2500);
    expect(long).toContain('没有证据卡');
    expect(long).toContain('<!-- srenautix:pr=rollback -->');
  });
});

describe('上下文与辅助', () => {
  it('同一张卡在多个实体上取最严重的结论', () => {
    const cs: EvidenceResult[] = stageACards();
    expect(cardsOf(cs)['workload/http/error_ratio']).toMatchObject({ verdict: 'abnormal', value: '31%' });
    expect(cardsOf(cs)['node/disk/pressure']).toMatchObject({ verdict: 'undeterminable', value: null });
    // 判定明细跟着选中的那一份结果（ADR 0139：发布进度卡按 missing 判断滚动是否停在半路）
    const rollout = (verdict: EvidenceResult['verdict'], missing: number): EvidenceResult => ({
      ...cs[0]!,
      card_id: 'workload/rollout/statefulset',
      verdict,
      observations: { missing, stale: 0, specChanges: 1 },
    });
    expect(cardsOf([rollout('normal', 0), rollout('abnormal', 2)])['workload/rollout/statefulset']).toMatchObject({
      verdict: 'abnormal',
      observations: { missing: 2 },
    });
    expect(cardsOf(cs)['node/disk/pressure']).not.toHaveProperty('observations');
    // 影响卡标记取自卡片定义：任何一份结果带 impact 即为影响卡（ADR 0139 的告警调优模板按它判断）
    const impact = (verdict: EvidenceResult['verdict'], flag: boolean): EvidenceResult => ({
      ...cs[0]!,
      card_id: 'cchp/edge/error-ratio',
      verdict,
      ...(flag ? { impact: true } : {}),
    });
    expect(cardsOf([impact('normal', true), impact('abnormal', false)])['cchp/edge/error-ratio']).toMatchObject({
      verdict: 'abnormal',
      impact: true,
    });
    expect(cardsOf(cs)['workload/http/error_ratio']).not.toHaveProperty('impact');
  });

  it('分支名与执行事件中的 PR', () => {
    expect(branchOf('7a1b2c3d-0000-4000-8000-000000000001', 'release_rollback', 'abcdef0123')).toBe(
      'srenautix/7a1b2c3d-release-rollback-abcdef',
    );
    expect(prFromMessages([null, 'pr_open: PR https://github.com/acme/gitops/pull/9 #9 state=open'])).toEqual({
      url: 'https://github.com/acme/gitops/pull/9',
      number: 9,
    });
    expect(prFromMessages(['checks_passed'])).toBeNull();
  });
});

describe('通知', () => {
  it('gitops_pr 提议开出 PR 后，修复段落带 PR 链接；消息带前缀（Telegram 渲染在标题前）', () => {
    const p = {
      proposal_id: '9d6f0a51-0000-4000-8000-000000000001',
      action: 'gitops_pr',
      state: 'dispatched',
      tier: 'L',
      level: 'reversible',
      target: { display: 'acme/gitops' },
      execution: { execution_id: 'e', phase: 'verified', queue_position: null, updated_at: '2026-09-01T10:10:00Z' },
      created_at: '2026-09-01T10:05:00Z',
    } as unknown as Proposal;
    const msg = composeMessage({
      incident: incident(),
      stageA: stageA(),
      alerts: [],
      research: null,
      researchPending: false,
      stageAOnlyReason: null,
      proposals: [p],
      pulls: new Map([[p.proposal_id, 'https://github.example.test/acme/gitops/pull/41']]),
      feedback: null,
      prefix: '[影子]',
      consoleUrl: 'https://srenautix.example',
      language: 'zh',
    }).message;
    expect(msg.prefix).toBe('[影子]');
    expect(JSON.stringify(msg)).toContain('PR：https://github.example.test/acme/gitops/pull/41');
  });
});
