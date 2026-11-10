import { describe, expect, it } from 'vitest';
import { composeMessage } from '../../src/notify/compose.js';
import { largeIncidentInput } from '../support/report-fixture.js';

// 聊天消息上的认领（ADR 0195）：未恢复且没有处理人的事件带“我来处理”按钮；有处理人时现状段写处理人，不再带按钮

const situationText = (m: ReturnType<typeof composeMessage>['message']) =>
  m.sections
    .find((s) => s.kind === 'situation')!
    .blocks.flatMap((b) => ('runs' in b ? b.runs.map((r) => r.text) : []))
    .join('\n');

describe('消息上的认领', () => {
  it('未恢复、没有处理人：带“我来处理”按钮，回调按事件', () => {
    const input = largeIncidentInput();
    expect(input.incident.state).toBe('firing');
    const { message, targets } = composeMessage(input);
    const claim = message.buttons.filter((b) => b.kind === 'claim');
    expect(claim).toEqual([
      { kind: 'claim', label: '我来处理', callback: `cl:${input.incident.incident_id}`, url: null },
    ]);
    expect(targets.find((t) => t.kind === 'claim')).toMatchObject({ incidentId: input.incident.incident_id });
    expect(situationText(message)).not.toContain('处理人');
  });

  it('有处理人：现状段写处理人，不带按钮', () => {
    const { message } = composeMessage({ ...largeIncidentInput(), claim: { principal_id: 'oidc:alice' } });
    expect(message.buttons.some((b) => b.kind === 'claim')).toBe(false);
    expect(situationText(message)).toContain('处理人 · oidc:alice');
  });

  it('已恢复：只有恢复确认，没有认领按钮', () => {
    const input = largeIncidentInput();
    const { message } = composeMessage({ ...input, incident: { ...input.incident, state: 'resolved' } });
    expect(message.buttons.some((b) => b.kind === 'claim')).toBe(false);
    expect(message.buttons.some((b) => b.kind === 'resolved_confirm')).toBe(true);
  });

  it('英文消息的按钮与处理人', () => {
    const en = { ...largeIncidentInput(), language: 'en' as const };
    expect(composeMessage(en).message.buttons.find((b) => b.kind === 'claim')?.label).toBe("I'll take it");
    expect(situationText(composeMessage({ ...en, claim: { principal_id: 'oidc:bob' } }).message)).toContain(
      'Handled by · oidc:bob',
    );
  });
});
