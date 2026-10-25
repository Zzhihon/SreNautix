import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/api/errors.js';
import { parseLookupQuery } from '../../src/console-bff/routes-alerts.js';
import { fingerprint, fromAlertmanager } from '../../src/ingest/normalize.js';

// 告警链接的查询串（ADR 0154）：l.<标签名>=<标签值>，标签值按原文读取
describe('告警链接的查询串', () => {
  it('&、/、=、?、空格（+ 与 %20）、非 ASCII 与像数字、布尔、null 的值原样往返', () => {
    const labels = {
      alertname: 'KubePodCrashLooping',
      path: '/v1/orders?a=1&b=2',
      team: '支付 组',
      note: 'x y',
      version: '1.0',
      enabled: 'true',
      empty: 'null',
      quoted: '"a"',
    };
    const encoded = new URLSearchParams(
      Object.entries(labels).map(([k, v]): [string, string] => [`l.${k}`, v]),
    ).toString();
    expect(parseLookupQuery(encoded)).toEqual({ labels, clusterId: null });
    // Go 的 url.QueryEscape（模板的 urlquery）把空格写成 +，html/template 写成 %20
    expect(parseLookupQuery('l.alertname=A&l.team=%E6%94%AF%E4%BB%98+%E7%BB%84&l.note=x%20y&cluster_id=c1')).toEqual({
      labels: { alertname: 'A', team: '支付 组', note: 'x y' },
      clusterId: 'c1',
    });
  });

  it('与接入相同的指纹：链接里的 alertgroup 与 external labels 不计入身份', () => {
    const { labels } = parseLookupQuery(
      'l.alertname=X&l.namespace=shop&l.alertgroup=shop-rules&l.prometheus=monitoring%2Fkps&l.prometheus_replica=prometheus-0',
    );
    const ingested = fromAlertmanager(
      {
        labels: { alertname: 'X', namespace: 'shop', alertgroup: 'other', prometheus: 'monitoring/kps' },
        annotations: {},
        startsAt: '2026-10-25T00:00:00Z',
        endsAt: '0001-01-01T00:00:00Z',
        status: 'firing',
      } as Parameters<typeof fromAlertmanager>[0],
      'alertmanager',
      new Date('2026-10-25T00:01:00Z'),
    );
    expect(fingerprint(labels)).toBe(ingested.fingerprint);
  });

  it('缺少 alertname、标签重复、不认识的参数、cluster_id 不合法时报 400', () => {
    for (const raw of [
      '',
      'l.namespace=shop',
      'l.alertname=',
      'l.alertname=X&l.alertname=Y',
      'l.alertname=X&state=firing',
      'l.alertname=X&l.=v',
      'l.alertname=X&cluster_id=Bad_Id',
      'l.alertname=X&cluster_id=c1&cluster_id=c2',
    ]) {
      expect(() => parseLookupQuery(raw), raw).toThrow(HttpError);
    }
  });
});
