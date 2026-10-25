import { describe, expect, it } from 'vitest';
import { parseSearch, stringifySearch } from './search';

describe('路由查询串', () => {
  it('告警标签参数按原文保留，序列化后与原地址一致', () => {
    const raw =
      '?cluster=c1&l.alertname=X&l.version=1.0&l.enabled=true&l.empty=null&l.quoted=%22a%22&l.path=%2Fv1%3Fa%3D1%26b%3D2&l.team=%E6%94%AF%E4%BB%98+%E7%BB%84';
    const parsed = parseSearch(raw);
    expect(parsed).toEqual({
      cluster: 'c1',
      'l.alertname': 'X',
      'l.version': '1.0',
      'l.enabled': 'true',
      'l.empty': 'null',
      'l.quoted': '"a"',
      'l.path': '/v1?a=1&b=2',
      'l.team': '支付 组',
    });
    expect(stringifySearch(parsed)).toBe(raw);
    expect(parseSearch(stringifySearch(parsed))).toEqual(parsed);
  });

  it('其他参数沿用默认规则：布尔与数字按 JSON 解析', () => {
    expect(parseSearch('?suppressed=true&limit=5&state=firing')).toEqual({
      suppressed: true,
      limit: 5,
      state: 'firing',
    });
    expect(stringifySearch({ suppressed: true, state: 'firing', cluster: undefined })).toBe(
      '?suppressed=true&state=firing',
    );
    expect(stringifySearch({})).toBe('');
  });

  it('重复的标签全部保留，交给中心拒绝', () => {
    const parsed = parseSearch('?l.alertname=X&l.alertname=Y');
    expect(parsed).toEqual({ 'l.alertname': ['X', 'Y'] });
    expect(stringifySearch(parsed)).toBe('?l.alertname=X&l.alertname=Y');
  });
});
