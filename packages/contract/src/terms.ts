// 界面与消息共用的术语：一个概念一个名称。控制台与 Grafana 插件的文案（packages/ui 的 i18n JSON，测试核对与这里相同）、
// Telegram、飞书与 GitHub issue 的消息都取这里的名称。

export const TERMS = {
  'zh-CN': {
    severity: { critical: '严重', warning: '警告', info: '提示' },
    state: { firing: '未恢复', resolved: '已恢复', merged: '已合并' },
    disposition: { act: '处理', escalate: '升级', ignore: '忽略', undetermined: '无法判定' },
  },
  en: {
    severity: { critical: 'Critical', warning: 'Warning', info: 'Info' },
    state: { firing: 'Firing', resolved: 'Resolved', merged: 'Merged' },
    disposition: { act: 'Act', escalate: 'Escalate', ignore: 'Ignore', undetermined: 'Undetermined' },
  },
} as const;

export type TermLocale = keyof typeof TERMS;
