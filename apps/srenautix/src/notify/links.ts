import type { Alert, ChangeEvent, EvidenceResult } from '@srenautix/contract';
import { parseStoredKey } from '../topology/keys.js';

/**
 * 证据链接（ADR 0125）：控制台的卡片详情、数据源查询（Grafana Explore 或 vmui）、告警来源与变更来源。
 * 模板占位符：{query}（URL 编码的查询）、{query_json}（URL 编码的 JSON 字符串，带引号）、{from}、{to}（RFC 3339）、
 * {from_ms}、{to_ms}（unix 毫秒）、{range}（窗口长度，例如 40m）、{revision}。没有配置的链接不生成。
 */
export interface LinkSettings {
  consoleUrl: string;
  metricsExploreUrl: string | null;
  logsExploreUrl: string | null;
  alertmanagerUrl: string | null;
  argocdUrl: string | null;
  gitCommitUrl: string | null;
}

export const NO_LINKS: Omit<LinkSettings, 'consoleUrl'> = {
  metricsExploreUrl: null,
  logsExploreUrl: null,
  alertmanagerUrl: null,
  argocdUrl: null,
  gitCommitUrl: null,
};

const trim = (u: string) => u.replace(/\/+$/, '');

/** 只接受 http 与 https 的绝对地址 */
export function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

function rangeText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

const NO_VARS = { query: '', query_json: '', from: '', to: '', from_ms: '', to_ms: '', range: '', revision: '' };

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(query_json|query|from_ms|to_ms|from|to|range|revision)\}/g, (_, k: string) => vars[k]!);
}

/** 控制台的事件页；tab 为标签页，anchor 为页内锚点 */
export function consoleIncident(s: LinkSettings, incidentId: string, tab?: string, anchor?: string): string {
  return `${trim(s.consoleUrl)}/incidents/${incidentId}${tab ? `?tab=${tab}` : ''}${anchor ? `#${anchor}` : ''}`;
}

/** 控制台中证据卡的锚点（与控制台 evidenceAnchor 相同）：card:3 → card-3 */
export function cardAnchor(ref: string): string {
  return ref.replace(':', '-');
}

export function cardConsoleLink(s: LinkSettings, incidentId: string, ref: string): string {
  return consoleIncident(s, incidentId, 'evidence', cardAnchor(ref));
}

/** 卡片第一个指标或日志查询在数据源中的浏览链接；没有配置模板或没有查询时为 null */
export function cardQueryLink(s: LinkSettings, r: EvidenceResult): string | null {
  const q =
    r.queries.find((x) => x.capability.startsWith('metrics.') && x.query) ??
    r.queries.find((x) => x.capability.startsWith('logs.') && x.query);
  if (!q) {
    return null;
  }
  const template = q.capability.startsWith('metrics.') ? s.metricsExploreUrl : s.logsExploreUrl;
  if (!template) {
    return null;
  }
  const from = Date.parse(r.window.from);
  const to = Date.parse(r.window.to);
  return httpUrl(
    fill(template, {
      ...NO_VARS,
      query: encodeURIComponent(q.query),
      query_json: encodeURIComponent(JSON.stringify(q.query)),
      from: encodeURIComponent(r.window.from),
      to: encodeURIComponent(r.window.to),
      from_ms: String(from),
      to_ms: String(to),
      range: rangeText(to - from),
    }),
  );
}

/** 告警的来源：规则的 generatorURL，没有时为 Alertmanager 中按告警名过滤的页面 */
export function alertLink(s: LinkSettings, a: Pick<Alert, 'alertname' | 'generator_url'>): string | null {
  const gen = httpUrl(a.generator_url);
  if (gen) {
    return gen;
  }
  if (!s.alertmanagerUrl) {
    return null;
  }
  return httpUrl(`${trim(s.alertmanagerUrl)}/#/alerts?filter=${encodeURIComponent(`{alertname="${a.alertname}"}`)}`);
}

const SHA = /^[0-9a-f]{7,40}$/;

/** 变更的来源：变更自带的链接；计划内退役的依据提交（ADR 0161）；Argo CD 应用页；Git 提交页 */
export function changeLink(s: LinkSettings, c: ChangeEvent): string | null {
  const own = httpUrl(c.link);
  if (own) {
    return own;
  }
  const plan = c.planned_by?.[0];
  if (plan) {
    const href =
      httpUrl(plan.link) ??
      (s.gitCommitUrl && plan.revision && SHA.test(plan.revision)
        ? httpUrl(fill(s.gitCommitUrl, { ...NO_VARS, revision: plan.revision }))
        : null);
    if (href) {
      return href;
    }
  }
  if (s.argocdUrl) {
    for (const ref of [...c.refs, ...c.targets]) {
      if (ref.startsWith('Application.argoproj.io:')) {
        const k = parseStoredKey(ref);
        return httpUrl(`${trim(s.argocdUrl)}/applications/${k.namespace ?? 'argocd'}/${k.name}`);
      }
    }
  }
  if (s.gitCommitUrl && c.revision && SHA.test(c.revision)) {
    return httpUrl(fill(s.gitCommitUrl, { ...NO_VARS, revision: c.revision }));
  }
  return null;
}
