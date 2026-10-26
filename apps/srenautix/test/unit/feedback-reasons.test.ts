import { SCHEMAS } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { formReason } from '../../src/notify/interactions.js';
import { t } from '../../src/notify/text.js';
import { candidateRule, checkConfirm } from '../../src/proposals/candidates.js';
import { FEEDBACK_REASON_CODES, isReasonCode } from '../../src/proposals/feedback.js';

// 反馈原因码（ADR 0174）与评测候选的生成规则（ADR 0175）

const schema = SCHEMAS['https://srenautix.io/contract/schemas/feedback.schema.json'] as unknown as {
  $defs: { ReasonCode: { enum: string[] } };
  properties: { implicit: { enum: Array<string | null> } };
};

describe('原因码', () => {
  it('与契约的 FeedbackReasonCode 一致，聊天渠道的两种语言都有文案', () => {
    expect([...FEEDBACK_REASON_CODES].sort()).toEqual([...schema.$defs.ReasonCode.enum].sort());
    for (const c of FEEDBACK_REASON_CODES) {
      expect(t.reason('zh', c)).not.toBe(c);
      expect(t.reason('en', c)).not.toBe(c);
    }
    expect(isReasonCode('wrong_fix')).toBe(true);
    expect(isReasonCode('bad_model')).toBe(false);
    expect(isReasonCode(null)).toBe(false);
  });

  it('隐式反馈增加关闭跟踪写入的两种', () => {
    expect(schema.properties.implicit.enum).toEqual(
      expect.arrayContaining(['pr_closed', 'issue_not_planned', 'rejected', null]),
    );
  });

  it('飞书表单：有原因选择时必须是登记的原因码；原因选择加入之前的卡片没有这一项，记为 null', () => {
    expect(formReason({ root: '-', reason_code: 'known_issue' })).toBe('known_issue');
    expect(formReason({ root: '-', reason_code: 'nonsense' })).toBeUndefined();
    expect(formReason({ root: '-', reason_code: '' })).toBeUndefined();
    expect(formReason({ root: '-' })).toBeNull();
  });
});

describe('评测候选的生成规则', () => {
  const rule = (reason_code: string | null, implicit: string | null = null) =>
    candidateRule({ reason_code, implicit } as Parameters<typeof candidateRule>[0]);

  it('事件本身不需要处理的原因码生成 benign 候选', () => {
    for (const c of [
      'false_positive',
      'not_actionable',
      'known_issue',
      'planned_change',
      'transient_self_resolved',
      'worse_than_baseline',
    ]) {
      expect(rule(c), c).toEqual({ source: 'feedback', suggested: 'benign' });
    }
  });

  it('修复方向错误与两种关闭生成候选，类型留给人确认', () => {
    expect(rule('wrong_fix')).toEqual({ source: 'feedback', suggested: null });
    expect(rule(null, 'pr_closed')).toEqual({ source: 'pr_closed', suggested: null });
    expect(rule(null, 'issue_not_planned')).toEqual({ source: 'issue_not_planned', suggested: null });
  });

  it('其余原因码、没有原因码的反馈与其他隐式反馈不生成', () => {
    for (const c of ['external_upstream', 'duplicate', 'poor_wording', 'other']) {
      expect(rule(c), c).toBeNull();
    }
    expect(rule(null)).toBeNull();
    for (const i of ['approved', 'rejected', 'undone', 'resolved_confirm']) {
      expect(rule(null, i), i).toBeNull();
    }
  });

  it('确认时的标准答案与标注文件的约束相同', () => {
    expect(() => checkConfirm({ type: 'incident', roots: [], disposition: 'act', mechanism: null })).toThrow(
      /至少一个根因/,
    );
    expect(() => checkConfirm({ type: 'benign', roots: [], disposition: 'act', mechanism: null })).toThrow(/ignore/);
    expect(() =>
      checkConfirm({ type: 'benign', roots: ['Deployment:shop/api'], disposition: 'ignore', mechanism: null }),
    ).toThrow(/ignore/);
    expect(() => checkConfirm({ type: 'abstain', roots: [], disposition: 'ignore', mechanism: null })).toThrow(
      /abstain/,
    );
    checkConfirm({ type: 'incident', roots: ['Deployment:shop/api'], disposition: null, mechanism: '发布' });
    checkConfirm({ type: 'benign', roots: [], disposition: 'ignore', mechanism: null });
    checkConfirm({ type: 'abstain', roots: [], disposition: null, mechanism: null });
  });
});
