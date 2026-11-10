// notify 的配置段（server 的 notify 与重建评测的 reconstruct.notify 共用的部分也在这里）；config/server.ts 只组装
import { z } from 'zod';
import { alertMatcher, type AlertMatcher } from '../alerts/business-impact.js';
import { duration, path, url } from '../kernel/config-schema.js';
import { parseDuration } from '../kernel/files.js';
import type { ExternalRootSettings } from './external.js';

const telegram = z
  .object({
    enabled: z.boolean().default(false),
    bot_token_file: path,
    api_base: url.default('https://api.telegram.org'),
    chats: z.array(z.object({ id: z.number().int(), language: z.enum(['zh', 'en']).default('zh') }).strict()).min(1),
    // none：只发送和编辑，不接收更新（与其他服务共用同一个 bot 时使用）；webhook：Telegram 推送到 /v1/channels/telegram/webhook；polling：长轮询 getUpdates（选主）
    updates: z.enum(['none', 'webhook', 'polling']).default('none'),
    webhook_secret_file: path.optional(),
    messages_per_minute: z.number().int().min(1).max(30).default(20),
    edit_gap: duration.default('3s'),
  })
  .strict();

// 标签条件：标签名 → 允许的取值（每个键都要满足，取值之一即可）
const labelMatch = z.record(z.string().min(1), z.array(z.string().min(1)).min(1));

const EXTERNAL_ROOTS_DEFAULT = {
  enabled: true,
  period: '1h',
  grace: '30s',
  components: [] as string[],
  alert_labels: {} as Record<string, string[]>,
  business_impact: {
    impact_cards: true,
    within: '30m',
    topology_hops: 6,
  },
};

// 外部上游的周期汇总（ADR 0147）：根因是领域包声明 external 的组件类型（例如模型服务方）、components 列出的组件，
// 或全部成员告警都满足 alert_labels 的事件，不逐条推送、不开 issue，每个周期（按 UTC 对齐，1h 即整点）汇总一条；
// 同时有与这个上游事件相关的业务影响（ADR 0150：notify.business_impact_alerts 定义的业务影响告警（ADR 0166），或
// impact_cards 为 true 时其他事件异常的影响卡，在上游事件开始后 within 之内开始，或组件沿依赖边 topology_hops 跳以内到达
// 上游根因；本事件异常的影响卡）时照常即时推送。grace 是周期结束后等待多久再统计与发送（0s 到 120s），只影响 server
// 发送汇总的时刻
const externalRoots = z
  .object({
    enabled: z.boolean().default(true),
    period: duration.default('1h'),
    grace: duration.default('30s'),
    components: z.array(z.string().min(1)).default([]),
    alert_labels: labelMatch.default({}),
    business_impact: z
      .object({
        impact_cards: z.boolean().default(true),
        within: duration.default('30m'),
        // 0 时不按拓扑判定
        topology_hops: z.number().int().min(0).max(12).default(6),
      })
      .strict()
      .default({ impact_cards: true, within: '30m', topology_hops: 6 }),
  })
  .strict();

/** IANA 时区名：Intl 能用它格式化时间 */
function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export type ExternalRootsConfig = z.infer<typeof externalRoots>;

/**
 * 推送规则中可以复用的两项：推送的严重度与外部上游的周期汇总。server 的 notify 与重建评测的 reconstruct.notify
 * （ADR 0175）同一写法
 */
export const notifySeverities = z.array(z.enum(['critical', 'warning', 'info'])).default(['critical', 'warning']);
export const notifyDigest = z
  .object({ external_roots: externalRoots.default(EXTERNAL_ROOTS_DEFAULT) })
  .strict()
  .default({ external_roots: EXTERNAL_ROOTS_DEFAULT });

/** 重建评测的 reconstruct.notify（ADR 0175）：推送的严重度与外部上游的周期汇总，默认值与 server 相同 */
export const notifyRules = z.object({ severities: notifySeverities, digest: notifyDigest }).strict();
export type NotifyRulesConfig = z.infer<typeof notifyRules>;
export const NOTIFY_RULES_DEFAULT: NotifyRulesConfig = {
  severities: ['critical', 'warning'],
  digest: { external_roots: EXTERNAL_ROOTS_DEFAULT },
};

/** notify.digest.external_roots 与业务影响告警 → 外部上游的分类设置（notify/external.ts 的 ExternalRoots） */
export function externalRootSettings(
  xr: ExternalRootsConfig,
  businessImpactAlerts: readonly AlertMatcher[],
  path = 'notify.digest.external_roots',
): ExternalRootSettings {
  return {
    enabled: xr.enabled,
    periodMs: parseDuration(`${path}.period`, xr.period),
    components: xr.components,
    alertLabels: xr.alert_labels,
    impact: {
      alerts: businessImpactAlerts,
      impactCards: xr.business_impact.impact_cards,
      withinMs: parseDuration(`${path}.business_impact.within`, xr.business_impact.within),
      topologyHops: xr.business_impact.topology_hops,
    },
  };
}

const feishu = z
  .object({
    enabled: z.boolean().default(false),
    api_base: url.default('https://open.feishu.cn'),
    app_id: z.string().min(1),
    app_secret_file: path,
    encrypt_key_file: path.optional(),
    verification_token_file: path,
    chats: z
      .array(z.object({ chat_id: z.string().min(1), language: z.enum(['zh', 'en']).default('zh') }).strict())
      .min(1),
    messages_per_minute: z.number().int().min(1).max(100).default(100),
    messages_per_second: z.number().int().min(1).max(5).default(5),
    edit_gap: duration.default('1s'),
    // 聊天账号与控制台使用同一个飞书身份源时，按 union_id 自动绑定
    auto_link_union_id: z.boolean().default(false),
  })
  .strict();

/** server 配置的 notify 段 */
export const notifyConfig = z
  .object({
    // 每条消息开头的前缀，例如 "[影子]"
    prefix: z.string().default(''),
    // 消息里时间的时区（IANA 名，例如 Asia/Shanghai）；时间后面写 UTC 或与 UTC 的偏移（UTC+8）
    time_zone: z.string().default('UTC').refine(validTimeZone, { message: 'notify.time_zone 不是 IANA 时区名' }),
    severities: notifySeverities,
    resolved_retention: duration.default('6h'),
    telegram: telegram.optional(),
    feishu: feishu.optional(),
    digest: notifyDigest,
    // 业务影响告警（ADR 0166）：满足任一项的告警。首条消息时延的 business_impact 标签（ADR 0159）、外部上游汇总的
    // 业务影响（ADR 0150）、处置推导中业务受影响时不给 ignore（ADR 0163）与计划内退役判为 ignore 的前提（ADR 0167）
    // 都用它。为空时没有业务影响告警
    business_impact_alerts: z.array(alertMatcher).default([]),
  })
  .strict()
  .default({
    prefix: '',
    time_zone: 'UTC',
    severities: ['critical', 'warning'],
    resolved_retention: '6h',
    digest: { external_roots: EXTERNAL_ROOTS_DEFAULT },
    business_impact_alerts: [],
  });
export type NotifyConfig = z.infer<typeof notifyConfig>;
