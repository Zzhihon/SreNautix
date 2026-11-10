import { describe, expect, it } from 'vitest';
import { composeMessage } from '../../src/notify/compose.js';
import { largeIncidentInput } from '../support/report-fixture.js';

// 消息头条以 [业务领域/服务] 开头（ADR 0193 §6）；没有主服务时头条不变

describe('消息头条的业务领域与服务', () => {
  it('有主服务时头条以 [业务领域/服务] 开头，其余不变', () => {
    const plain = composeMessage(largeIncidentInput()).message;
    const titled = composeMessage({
      ...largeIncidentInput(),
      service: { domain: '请求转发', service: '网关' },
    }).message;
    expect(plain.headline?.map((r) => r.text).join('')).not.toMatch(/^\[/);
    expect(titled.headline?.[0]?.text).toBe('[请求转发/网关] ');
    expect(titled.headline?.slice(1)).toEqual(plain.headline);
    expect(titled.sections).toEqual(plain.sections);
  });
});
