import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alertId,
  fingerprint,
  fromAlertmanager,
  normalizeSeverity,
  parseAlertmanagerWebhook,
  parseGeneric,
  parseNightingale,
  PayloadError,
} from '../../src/ingest/normalize.js';

const fixture = (p: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures', p), 'utf8'));
const now = new Date('2026-10-20T00:00:00Z');

describe('指纹', () => {
  it('FNV-1a 64：空标签集为偏移基数，忽略 alertstate、alertgroup、__name__，与键的顺序无关', () => {
    expect(fingerprint({})).toBe('cbf29ce484222325');
    const a = fingerprint({
      alertname: 'X',
      severity: 'critical',
      alertstate: 'firing',
      alertgroup: 'g',
      __name__: 'ALERTS',
    });
    const b = fingerprint({ severity: 'critical', alertname: 'X' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ alertname: 'X', severity: 'warning' })).not.toBe(b);
  });

  it('键值之间用 0xff 分隔：{a:"bc"} 与 {ab:"c"} 不同', () => {
    expect(fingerprint({ a: 'bc' })).not.toBe(fingerprint({ ab: 'c' }));
  });
});

describe('Alertmanager webhook（录制自 Alertmanager 0.34.1）', () => {
  it('解析出触发中的告警，零值 endsAt 视为没有结束时间', () => {
    const [a] = parseAlertmanagerWebhook(
      fixture('alertmanager/webhook-v4-alertmanager-0.34.1.json'),
      'alertmanager',
      now,
    );
    expect(a).toMatchObject({
      alertname: 'DemoPodCrashLooping',
      severity: 'critical',
      status: 'firing',
      endsAt: null,
      suppressed: 'none',
      labels: { namespace: 'shop', pod: 'api-7d9f8-x2k4p' },
    });
    expect(alertId(a!.fingerprint, a!.startsAt)).toMatch(/^[0-9a-f]{16}@\d+$/);
  });

  it('API v2 的 suppressed 状态区分静默与抑制', () => {
    const base = {
      labels: { alertname: 'A' },
      annotations: {},
      startsAt: '2026-10-19T00:00:00Z',
      endsAt: '2026-10-21T00:00:00Z',
    };
    expect(
      fromAlertmanager(
        { ...base, status: { state: 'suppressed', silencedBy: ['s1'], inhibitedBy: [] } },
        'reconcile',
        now,
      ).suppressed,
    ).toBe('silenced');
    expect(
      fromAlertmanager(
        { ...base, status: { state: 'suppressed', silencedBy: [], inhibitedBy: ['x'] } },
        'reconcile',
        now,
      ).suppressed,
    ).toBe('inhibited');
    const ended = fromAlertmanager(
      { ...base, endsAt: '2026-10-19T12:00:00Z', status: { state: 'active' } },
      'reconcile',
      now,
    );
    expect(ended.status).toBe('resolved');
  });

  it('缺少 alertname 或 startsAt 时报错', () => {
    expect(() =>
      fromAlertmanager({ labels: {}, annotations: {}, startsAt: '2026-10-19T00:00:00Z' }, 'alertmanager', now),
    ).toThrow(PayloadError);
    expect(() =>
      fromAlertmanager({ labels: { alertname: 'A' }, annotations: {}, startsAt: 'x' }, 'alertmanager', now),
    ).toThrow(PayloadError);
  });
});

describe('Grafana 告警 webhook（官方文档示例）', () => {
  it('与 Alertmanager 格式兼容，带时区偏移的 startsAt 换算为 UTC', () => {
    const list = parseAlertmanagerWebhook(fixture('grafana/webhook-docs-example.json'), 'grafana', now);
    expect(list.map((a) => a.alertname)).toEqual(['High memory usage', 'High CPU usage']);
    expect(list[0]!.startsAt.toISOString()).toBe('2021-10-12T07:51:03.157Z');
    expect(list[0]!.severity).toBe('info');
  });
});

describe('夜莺回调', () => {
  it('rule_name 作为告警名，tags_map 作为标签，severity 2 为 warning，target_ident 补 instance', () => {
    const [a] = parseNightingale(fixture('nightingale/callback-event.json'), now);
    expect(a).toMatchObject({
      alertname: 'MySQL 连接数过高',
      severity: 'warning',
      status: 'firing',
      labels: { namespace: 'shop', instance: 'db-03:9104' },
    });
    expect(a!.startsAt.toISOString()).toBe(new Date(1792439940 * 1000).toISOString());
    const rec = parseNightingale(
      { ...(fixture('nightingale/callback-event.json') as object), is_recovered: true },
      now,
    )[0]!;
    expect(rec.status).toBe('resolved');
    expect(rec.endsAt?.toISOString()).toBe(new Date(1792440030 * 1000).toISOString());
  });
});

describe('通用 webhook', () => {
  it('按 JSONPath 映射', () => {
    const body = {
      events: [
        { name: 'DiskFull', state: 'ALERT', ts: 1792439940, tags: { host: 'n1', namespace: 'ops' }, level: 'P1' },
        { name: 'DiskFull', state: 'OK', ts: 1792439000, end: 1792439500, tags: { host: 'n2' }, level: 'P2' },
      ],
    };
    const list = parseGeneric(
      body,
      {
        alerts: '$.events[*]',
        alertname: '$.name',
        status: '$.state',
        firing_value: 'alert',
        starts_at: '$.ts',
        ends_at: '$.end',
        labels: '$.tags',
        severity: '$.level',
      },
      now,
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      alertname: 'DiskFull',
      status: 'firing',
      severity: 'critical',
      labels: { host: 'n1', namespace: 'ops' },
    });
    expect(list[1]).toMatchObject({ status: 'resolved', severity: 'warning' });
    expect(list[1]!.endsAt?.getTime()).toBe(1792439500 * 1000);
  });
});

describe('严重度', () => {
  it.each([
    ['critical', 'critical'],
    ['ERROR', 'critical'],
    ['warning', 'warning'],
    ['none', 'info'],
    [undefined, 'info'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeSeverity(raw)).toBe(want);
  });
});
