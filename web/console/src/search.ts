// 路由的查询串解析与序列化。默认规则（TanStack Router 的 defaultParseSearch）把看起来像 JSON 的值转成数字、布尔与 null，
// 路由再把解析结果序列化回地址栏：告警标签值 "1.0" 会变成 "1"，"null" 会变成空值，标签集与指纹随之改变。
// 告警链接的标签参数（l.<标签名>，ADR 0154）因此按原文保留，其余参数沿用默认规则。

import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';

/** 告警标签参数的前缀，与中心的 lookupAlert 相同 */
export const LABEL_PARAM_PREFIX = 'l.';

const isLabel = (k: string) => k.startsWith(LABEL_PARAM_PREFIX);

export function parseSearch(searchStr: string): Record<string, unknown> {
  const rest = new URLSearchParams();
  const labels: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(searchStr)) {
    if (!isLabel(k)) {
      rest.append(k, v);
      continue;
    }
    // 同一个标签出现多次时全部保留，由中心拒绝
    const prev = labels[k];
    labels[k] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v];
  }
  return { ...defaultParseSearch(rest.toString()), ...labels };
}

export function stringifySearch(search: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(search).filter(([k]) => !isLabel(k)));
  const out = new URLSearchParams(defaultStringifySearch(rest));
  for (const [k, v] of Object.entries(search)) {
    if (isLabel(k) && v !== undefined) {
      for (const x of Array.isArray(v) ? v : [v]) {
        out.append(k, String(x));
      }
    }
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}
