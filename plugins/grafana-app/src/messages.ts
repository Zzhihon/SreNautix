// 插件自己的文案，与 @srenautix/ui 的文案合并；evidence.rerun_forbidden 覆盖为插件里的说明。

import type { Locale, Messages } from '@srenautix/ui';

export const PLUGIN_MESSAGES: Record<Locale, Messages> = {
  'zh-CN': {
    'plugin.not_found_title': '没有这个页面',
    'plugin.not_found': '插件里只有事件收件箱、事件详情和研判运行明细：{path}',
    'plugin.unconfigured_title': '插件还没有配置',
    'plugin.unconfigured':
      '在插件配置中填写中心地址（hubUrl）、控制台地址（consoleUrl）和 Grafana 插件 token。token 在 SreNautix 控制台的设置页创建，只能读取和提交反馈。',
    'evidence.rerun_forbidden': '实时重跑在 SreNautix 控制台中进行',
    'config.title': 'SreNautix 连接',
    'config.hub_url': '中心地址',
    'config.hub_url_hint': '插件后端访问 SreNautix server 的地址，例如 http://srenautix.srenautix.svc:8080',
    'config.console_url': '控制台地址',
    'config.console_url_hint': '浏览器打开控制台的地址；插件里的"批准"跳转到这里',
    'config.token': 'Grafana 插件 token',
    'config.token_set': '已设置（不回显）',
    'config.token_hint': '只能读取和提交反馈；后端转发时带上当前 Grafana 用户的邮箱',
    'config.save': '保存并启用',
    'config.saved': '已保存',
    'config.failed': '保存失败',
  },
  en: {
    'plugin.not_found_title': 'No such page',
    'plugin.not_found': 'The plugin has the incident inbox, incident detail and research run pages only: {path}',
    'plugin.unconfigured_title': 'The plugin is not configured',
    'plugin.unconfigured':
      'Set the hub URL (hubUrl), the console URL (consoleUrl) and a Grafana plugin token in the plugin configuration. Create the token on the SreNautix console settings page; it can only read and submit feedback.',
    'evidence.rerun_forbidden': 'Live reruns happen in the SreNautix console',
    'config.title': 'SreNautix connection',
    'config.hub_url': 'Hub URL',
    'config.hub_url_hint':
      'Where the plugin backend reaches the SreNautix server, e.g. http://srenautix.srenautix.svc:8080',
    'config.console_url': 'Console URL',
    'config.console_url_hint': 'Where browsers open the console; Approve in the plugin links here',
    'config.token': 'Grafana plugin token',
    'config.token_set': 'Set (not shown)',
    'config.token_hint': 'Reads and submits feedback only; the backend forwards the current Grafana user email',
    'config.save': 'Save and enable',
    'config.saved': 'Saved',
    'config.failed': 'Save failed',
  },
};
