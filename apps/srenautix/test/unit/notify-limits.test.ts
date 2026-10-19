import { describe, expect, it } from 'vitest';
import { parseRootReply } from '../../src/notify/interactions.js';
import { ChannelLimiter, TokenBucket } from '../../src/notify/ratelimit.js';
import { decideStorm, STORM_WINDOW_MS } from '../../src/notify/storm.js';
import { publicHttpsUrl } from '../../src/notify/text.js';

describe('令牌桶与渠道限速', () => {
  it('容量用完后给出下一个令牌的时间，按时间补充', () => {
    const b = new TokenBucket(20, 60_000, 0);
    for (let i = 0; i < 20; i++) {
      expect(b.peek(0).ok).toBe(true);
      b.consume();
    }
    expect(b.peek(0)).toEqual({ ok: false, retryAt: 3_000 });
    expect(b.peek(3_000).ok).toBe(true);
  });

  it('飞书：群桶、应用分钟桶、应用秒桶同时满足才发送', () => {
    const l = new ChannelLimiter(
      { perChatPerMinute: 100, perAppPerMinute: 100, perAppPerSecond: 5, editGapMs: 1000 },
      0,
    );
    for (let i = 0; i < 5; i++) {
      expect(l.reserve(`oc_${i}`, 0).ok).toBe(true);
    }
    const r = l.reserve('oc_9', 0);
    expect(r.ok).toBe(false);
    expect(r.retryAt).toBe(200);
    expect(l.reserve('oc_9', 200).ok).toBe(true);
  });

  it('429 暂停整个渠道', () => {
    const l = new ChannelLimiter(
      { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 3000 },
      0,
    );
    l.pause(7_000);
    expect(l.reserve('-100', 1_000)).toEqual({ ok: false, retryAt: 7_000 });
    expect(l.paused(1_000)).toBe(7_000);
    expect(l.reserve('-100', 7_000).ok).toBe(true);
  });
});

describe('风暴判定', () => {
  const now = 10 * STORM_WINDOW_MS;
  it('5 分钟内累计 3 个事件消息开启风暴，已有风暴时并入', () => {
    expect(decideStorm(now, [], 0, false)).toBe('none');
    expect(decideStorm(now, [], 2, false)).toBe('none');
    expect(decideStorm(now, [now - 60_000], 2, false)).toBe('start');
    expect(decideStorm(now, [now - STORM_WINDOW_MS - 1, now - STORM_WINDOW_MS - 2], 2, false)).toBe('none');
    expect(decideStorm(now, [], 3, false)).toBe('start');
    expect(decideStorm(now, [], 1, true)).toBe('join');
  });
});

describe('真实根因回复的解析', () => {
  const choices = ['postgres.cluster:data/pg', 'Node:node-3', 'PersistentVolumeClaim:data/pgdata-pg-1'];
  it('完整组件键、名称、唯一前缀、不分大小写', () => {
    expect(parseRootReply('Node:node-3 磁盘满了', choices)).toEqual({
      kind: 'ok',
      component: 'Node:node-3',
      reason: '磁盘满了',
    });
    expect(parseRootReply('node-3，磁盘满了', choices)).toEqual({
      kind: 'ok',
      component: 'Node:node-3',
      reason: '磁盘满了',
    });
    expect(parseRootReply('PG', choices)).toEqual({ kind: 'ok', component: 'postgres.cluster:data/pg', reason: null });
    expect(parseRootReply('pgdata 卷满了', choices)).toEqual({
      kind: 'ok',
      component: 'PersistentVolumeClaim:data/pgdata-pg-1',
      reason: '卷满了',
    });
  });

  it('“-”与“跳过”表示不知道真实根因；无法识别与超长分别报告', () => {
    expect(parseRootReply('-', choices)).toEqual({ kind: 'ok', component: null, reason: null });
    expect(parseRootReply('跳过 不确定', choices)).toEqual({ kind: 'ok', component: null, reason: '不确定' });
    expect(parseRootReply('redis 慢', choices)).toEqual({ kind: 'unknown', word: 'redis' });
    expect(parseRootReply('no', choices)).toEqual({ kind: 'unknown', word: 'no' });
    expect(parseRootReply(`pg ${'长'.repeat(500)}`, choices)).toEqual({ kind: 'too_long' });
  });
});

describe('URL 按钮只用公网 https 地址', () => {
  it.each([
    ['https://console.example.com/incidents/1', true],
    ['http://console.example.com/', false],
    ['https://localhost:8080/', false],
    ['https://10.0.0.5/', false],
    ['https://192.168.1.2/', false],
    ['https://srenautix.srenautix.svc/', false],
    ['https://srenautix.srenautix.svc.cluster.local/', false],
    ['https://intranet/', false],
    [null, false],
  ])('%s → %s', (u, ok) => {
    expect(publicHttpsUrl(u)).toBe(ok);
  });
});
