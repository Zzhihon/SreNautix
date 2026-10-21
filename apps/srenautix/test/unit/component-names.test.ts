import { displayComponentName } from '@srenautix/core';
import { describe, expect, it } from 'vitest';
import { composeMessage } from '../../src/notify/compose.js';
import { incident, stageA } from '../support/scenario.js';

// 组件的可读名称（ADR 0101）：标题用名称，正文写"名称（组件键）"，没有名称时退回组件键；组件键本身不变

const PG = 'StatefulSet:shop/postgres';

describe('组件的可读名称', () => {
  it('displayComponentName：有名称时为"名称（组件键）"，否则为解码后的组件键', () => {
    expect(displayComponentName('provider:01a134f4', { 'provider:01a134f4': '智元 API' })).toBe(
      '智元 API（provider:01a134f4）',
    );
    expect(displayComponentName('ClusterRole:a%3Ab', {})).toBe('ClusterRole:a:b');
    expect(displayComponentName(PG, undefined)).toBe(PG);
  });

  it('通知：标题用名称，根因与候选写"名称（组件键）"；没有名称时与原来相同', () => {
    const base = {
      stageA: stageA(),
      alerts: [],
      research: null,
      researchPending: false,
      stageAOnlyReason: null,
      proposals: [],
      feedback: null,
      prefix: '',
      consoleUrl: 'https://srenautix.example',
      language: 'zh' as const,
    };
    const plain = JSON.stringify(composeMessage({ ...base, incident: incident() }).message);
    expect(plain).toContain(PG);
    expect(plain).not.toContain('主库');
    const named = JSON.stringify(
      composeMessage({ ...base, incident: { ...incident(), component_names: { [PG]: '订单主库' } } }).message,
    );
    expect(named).toContain(`订单主库（${PG}）`);
    const msg = composeMessage({ ...base, incident: { ...incident(), component_names: { [PG]: '订单主库' } } }).message;
    expect(msg.title).toContain('订单主库');
    expect(msg.title).not.toContain(PG);
  });
});
