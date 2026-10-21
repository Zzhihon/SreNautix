import type { ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { rootsAgree } from '../../src/incident/research-root.js';
import { composeMessage, type ResearchMirror } from '../../src/notify/compose.js';
import { incident, stageA } from '../support/scenario.js';

// 研判根因与发现根因不一致的标记（ADR 0104 §14）：按属主粒度比较，只标记，事件不拆分

const owners: Record<string, string> = {
  'Pod:shop/api-1-a': 'Deployment:shop/api',
  'ReplicaSet:shop/api-1': 'Deployment:shop/api',
  'Pod:shop/checkout-2-x': 'Deployment:shop/checkout',
};
const ownerOf = (k: string) => owners[k] ?? null;

describe('研判根因与发现根因', () => {
  it('相同的组件一致；Pod 与它所属的 Deployment、同一 Deployment 的 Pod 与 ReplicaSet 都算一致', () => {
    expect(rootsAgree('Deployment:shop/api', 'Deployment:shop/api', ownerOf)).toBe(true);
    expect(rootsAgree('Pod:shop/api-1-a', 'Deployment:shop/api', ownerOf)).toBe(true);
    expect(rootsAgree('Deployment:shop/api', 'Pod:shop/api-1-a', ownerOf)).toBe(true);
    expect(rootsAgree('ReplicaSet:shop/api-1', 'Pod:shop/api-1-a', ownerOf)).toBe(true);
  });

  it('指向不同组件时不一致', () => {
    expect(rootsAgree('Deployment:shop/api', 'Deployment:shop/checkout', ownerOf)).toBe(false);
    expect(rootsAgree('Pod:shop/checkout-2-x', 'Deployment:shop/api', ownerOf)).toBe(false);
    expect(rootsAgree('Deployment:shop/api', 'Application.argoproj.io:argocd/shop', ownerOf)).toBe(false);
  });

  it('通知：不一致时在研判结论旁写明，事件没有拆分；一致时不写', () => {
    const inc = incident();
    const research = (root: string): ResearchMirror => ({
      run_id: '00000000-0000-4000-8000-000000000001',
      state: 'completed',
      disposition: 'act',
      conclusion_level: 'likely',
      root_component: root,
      output: {
        disposition: 'act',
        conclusion: {
          level: 'likely',
          hypothesis_id: 'h1',
          root_component: root,
          undetermined_reason: null,
          consistency: {},
        },
        hypotheses: [],
        next_checks: [],
        situation: '',
        summary: '',
        recommendations: [],
        proposals: [],
        validation_notes: [],
      } as unknown as ResearchOutput,
      error: null,
    });
    const base = {
      incident: inc,
      stageA: stageA(),
      alerts: [],
      researchPending: false,
      stageAOnlyReason: null,
      proposals: [],
      feedback: null,
      prefix: '',
      consoleUrl: 'https://srenautix.example',
      language: 'zh' as const,
    };
    const other = 'Deployment:shop/checkout';
    const flagged = JSON.stringify(
      composeMessage({ ...base, research: research(other), researchRootMismatch: true }).message,
    );
    expect(flagged).toContain(`研判根因（${other}）与发现根因（${inc.root.component}）不一致，事件没有拆分`);
    const same = JSON.stringify(
      composeMessage({ ...base, research: research(inc.root.component!), researchRootMismatch: false }).message,
    );
    expect(same).not.toContain('不一致');
  });
});
