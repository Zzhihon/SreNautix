import { REASON_CODES, reasonText } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { STAGE_A_MAX_RETRIES, STAGE_A_RETRY_AFTER_MS } from '../../src/incident/pipeline.js';
import { ServerMetrics } from '../../src/metrics.js';
import { MAX_ENDED_EDITS } from '../../src/notify/engine.js';
import { STAGE_A_MISSING_NOTIFY_MS } from '../../src/notify/source.js';

// 终态原因码在 server 中的用法（ADR 0172、0173）

describe('srenautix_terminal_states_total', () => {
  it('登记表里的每个原因码启动时按登记的级别导出 0，第一次出现也能被 increase() 看到', async () => {
    const m = new ServerMetrics('server', false);
    const lines = (await m.registry.metrics()).split('\n');
    for (const e of REASON_CODES) {
      expect(lines).toContain(
        `srenautix_terminal_states_total{stage="${e.stage}",code="${e.code}",level="${e.level}"} 0`,
      );
    }
    m.terminal('stage_a', 'stage_a_missing');
    expect((await m.registry.metrics()).split('\n')).toContain(
      'srenautix_terminal_states_total{stage="stage_a",code="stage_a_missing",level="error"} 1',
    );
  });
});

describe('阶段 A 的期限与补跑次数（ADR 0173）', () => {
  it('补跑与先发不带证据卡的消息都在 60 秒的期限之后；补跑上限与登记表的说明一致', () => {
    expect(STAGE_A_RETRY_AFTER_MS).toBe(60_000);
    expect(STAGE_A_MISSING_NOTIFY_MS).toBe(60_000);
    expect(STAGE_A_MAX_RETRIES).toBe(3);
    expect(reasonText('stage_a', 'stage_a_missing', 'zh')).toContain(`补跑 ${STAGE_A_MAX_RETRIES} 次`);
    expect(reasonText('stage_a', 'stage_a_missing', 'en')).toContain(`${STAGE_A_MAX_RETRIES} retries`);
  });

  it('阶段 A 没有报告的两个原因码都是 error：由 SreNautixAbnormalTerminalStates 告警', () => {
    expect(REASON_CODES.filter((e) => e.stage === 'stage_a').map((e) => [e.code, e.level])).toEqual([
      ['stage_a_failed', 'error'],
      ['stage_a_missing', 'error'],
    ]);
  });
});

describe('通知的原因码（ADR 0173）', () => {
  it('不推送的决定是 info，放弃投递是 error，最后一次编辑是 warning', () => {
    const level = (g: string) => [...new Set(REASON_CODES.filter((e) => e.groups.includes(g)).map((e) => e.level))];
    expect(level('notify_withheld')).toEqual(['info']);
    expect(level('notify_abandon')).toEqual(['error']);
    expect(REASON_CODES.find((e) => e.stage === 'notify' && e.code === 'final_edit')?.level).toBe('warning');
    expect(MAX_ENDED_EDITS).toBe(5);
  });
});
