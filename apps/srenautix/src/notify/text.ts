import type { Language } from './channel.js';

/** 消息模板中的固定文案（中英文），各渠道的渲染共用。不可信文本从不拼进这里的模板。 */
type Dict = Record<string, string>;

const SEVERITY: Record<Language, Dict> = {
  zh: { critical: '严重', warning: '警告', info: '提示' },
  en: { critical: 'CRITICAL', warning: 'WARNING', info: 'INFO' },
};

const STATE: Record<Language, Dict> = {
  zh: { firing: '未恢复', resolved: '已恢复', merged: '已合并' },
  en: { firing: 'firing', resolved: 'resolved', merged: 'merged' },
};

const SECTION: Record<Language, Dict> = {
  zh: { situation: '1. 现状与背景', root_cause: '2. 问题根源', remedy: '3. 解决方案', evidence: '4. 相关证据' },
  en: { situation: '1. Situation', root_cause: '2. Root cause', remedy: '3. Remedy', evidence: '4. Evidence' },
};

const OMITTED: Record<Language, Dict> = {
  zh: {
    situation: '1. 现状与背景已省略，见控制台',
    root_cause: '2. 问题根源已省略，见控制台',
    remedy: '3. 解决方案已省略，见控制台',
    evidence: '4. 相关证据已省略，见控制台',
    results: '最近操作已省略，见控制台',
  },
  en: {
    situation: '1. Situation omitted, see the console',
    root_cause: '2. Root cause omitted, see the console',
    remedy: '3. Remedy omitted, see the console',
    evidence: '4. Evidence omitted, see the console',
    results: 'Recent actions omitted, see the console',
  },
};

const DISPOSITION: Record<Language, Dict> = {
  zh: { act: '处理', ignore: '忽略', escalate: '升级', undetermined: '无法判定' },
  en: { act: 'Act', ignore: 'Ignore', escalate: 'Escalate', undetermined: 'Undetermined' },
};

const ACTION: Record<Language, Dict> = {
  zh: {
    approve: '批准',
    reject: '拒绝',
    undo: '撤销',
    feedback_root: '反馈根因',
    feedback_disposition: '反馈处置判断',
    resolved_confirm: '确认恢复',
    reject_timeout: '拒绝',
    root_timeout: '反馈根因',
  },
  en: {
    approve: 'approve',
    reject: 'reject',
    undo: 'undo',
    feedback_root: 'root cause feedback',
    feedback_disposition: 'disposition feedback',
    resolved_confirm: 'confirm recovery',
    reject_timeout: 'reject',
    root_timeout: 'root cause feedback',
  },
};

const MISC: Record<Language, Dict> = {
  zh: {
    incident: '事件',
    first_firing: '首次触发',
    source: '来源：',
    model: '【模型生成】',
    results: '最近操作',
    storm: '属于 {at} 开始的事件风暴，汇总消息中列出全部事件',
    digest_title: '事件风暴：自 {at} 起 {n} 个事件',
    digest_note: '各事件消息已静默发送。',
    digest_pending: '待审批 {n} 个',
    digest_none: '无待审批提议',
    console: '控制台：',
    truncated: '\n…（内容过长已截断，完整内容见控制台）',
    open_console: '在控制台打开',
  },
  en: {
    incident: 'Incident',
    first_firing: 'First firing',
    source: 'Source: ',
    model: '[model generated] ',
    results: 'Recent actions',
    storm: 'Part of the incident storm since {at}; the digest lists every incident',
    digest_title: 'Incident storm: {n} incidents since {at}',
    digest_note: 'Incident messages were sent silently.',
    digest_pending: '{n} awaiting approval',
    digest_none: 'no pending approvals',
    console: 'Console: ',
    truncated: '\n… (truncated, see the console for the full report)',
    open_console: 'Open in console',
  },
};

const label = (m: Dict, v: string) => m[v] ?? v;

export const t = {
  severity: (l: Language, v: string) => label(SEVERITY[l], v),
  state: (l: Language, v: string) => label(STATE[l], v),
  section: (l: Language, v: string) => label(SECTION[l], v),
  omitted: (l: Language, v: string) => label(OMITTED[l], v),
  disposition: (l: Language, v: string) => label(DISPOSITION[l], v),
  action: (l: Language, v: string) => label(ACTION[l], v),
  misc: (l: Language, key: keyof (typeof MISC)['zh'], vars: Record<string, string | number> = {}) =>
    (MISC[l][key] as string).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')),
};

export function hm(d: Date): string {
  return `${d.toISOString().slice(11, 16)} UTC`;
}

export function ymdhm(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** 单个字段限制在 max 个字符（code point）以内，超出时以“…”结尾。 */
export function clip(s: string, max: number): string {
  const v = s.trim();
  const cps = Array.from(v);
  return cps.length <= max ? v : `${cps.slice(0, max - 1).join('')}…`;
}

export function oneLine(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * 控制台链接能否作为 URL 按钮：必须是 https，且主机不是 localhost、内网地址或集群内域名
 * （Telegram 与飞书都不接受这类地址的 URL 按钮）。
 */
export function publicHttpsUrl(raw: string | null): boolean {
  if (!raw) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') {
    return false;
  }
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.svc') ||
    h.endsWith('.cluster.local') ||
    h.endsWith('.internal')
  ) {
    return false;
  }
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith('[')) {
    return false;
  }
  return h.includes('.');
}
