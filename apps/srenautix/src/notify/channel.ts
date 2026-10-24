import type { ExternalDigestView } from './external.js';
import type { ButtonTarget, DesiredIncidentMessage } from './ports.js';
import type { ChannelLimits } from './ratelimit.js';

export type ChannelId = 'telegram' | 'feishu';
export type Language = 'zh' | 'en';

/** 一个渠道目标（Telegram 群或飞书群）。 */
export interface ChatTarget {
  channel: ChannelId;
  chat: string;
  language: Language;
}

/** 渲染时登记的回调按钮：short id → 作用对象。 */
export interface RegisteredButton {
  shortId: string;
  kind: string;
  target: ButtonTarget;
  /** 只允许这个渠道账号点击；为 null 时任何已绑定账号都可以点击。 */
  owner: string | null;
}

/** 渠道无关的渲染结果：payload 原样存进 notify_messages，投递时交给适配器。 */
export interface Rendered {
  payload: unknown;
  hash: string;
  buttons: RegisteredButton[];
}

/** 一条按钮操作的结果，显示在消息的“最近操作”中。 */
export interface ActionResultView {
  at: Date;
  actor: string;
  action: string;
  ok: boolean;
  code: string | null;
  message: string;
}

/** 风暴汇总消息的输入。 */
export interface DigestInput {
  stormId: number;
  startedAt: Date;
  members: Array<{
    incidentId: string;
    label: string;
    severity: string;
    state: string;
    title: string;
    /** 该事件消息中待审批的提议数。 */
    pendingApprovals: number;
  }>;
  consoleUrl: string | null;
}

/**
 * 渲染器版本：notify_messages.render_version 记录期望内容由哪一版渲染器产出。渲染结果的规则变化
 * （例如 Telegram 的实体预算，ADR 0145）时加一；进程启动时把旧版本产出、还没有呈现的期望内容按当前代码重新渲染。
 * 旧代码写入的行没有版本（NULL），视为旧版本。
 */
export const RENDER_VERSION = 1;

/**
 * 永久错误的原因（srenautix_notify_abandoned_total 的 reason 标签，取值有限）：
 * entities_too_long、message_too_long、parse_error、bad_request（Telegram 其他 400）、
 * content_too_long、invalid_card、invalid_param（飞书），以及引擎自己判定的 ended_edit_cap。
 */
export type PermanentReason =
  | 'entities_too_long'
  | 'message_too_long'
  | 'parse_error'
  | 'bad_request'
  | 'content_too_long'
  | 'invalid_card'
  | 'invalid_param';

/**
 * 渠道投递错误的分类。permanent：渠道拒绝这条内容本身（Telegram 的 400，除了 message is not modified 与要编辑的消息
 * 不存在；飞书的内容错误），原样重试永远不会成功，先降级为纯文本重试一次，仍然失败就放弃（ADR 0145）。
 * api：其他拒绝（例如 403），5 分钟后重试。
 */
export type DeliveryError =
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'transport' }
  | { kind: 'not_modified' }
  | { kind: 'target_gone' }
  | { kind: 'permanent'; reason: PermanentReason }
  | { kind: 'api' }
  | { kind: 'fatal' };

export interface RenderOptions {
  /** 状态库降级时直接发送：不登记按钮，只保留 URL 按钮。 */
  callbacks: boolean;
}

/** 渠道适配器：渲染、发送、编辑与错误分类。回调由各渠道自己的路由处理。 */
export interface ChannelAdapter {
  readonly channel: ChannelId;
  /**
   * 渠道是否接收按钮回调。只发送的渠道（例如 Telegram 的 updates: none，bot 与其他服务共用）不渲染回调按钮，
   * 只保留 URL 按钮（打开控制台），否则用户点了按钮没有任何反应。
   */
  readonly receivesCallbacks: boolean;
  readonly chats: readonly ChatTarget[];
  readonly limits: ChannelLimits;
  renderIncident(
    chat: ChatTarget,
    msg: DesiredIncidentMessage,
    results: ActionResultView[],
    storm: { startedAt: Date } | null,
    opts: RenderOptions,
  ): Rendered;
  renderDigest(chat: ChatTarget, d: DigestInput): Rendered;
  /** 外部上游的周期汇总消息（ADR 0147）。 */
  renderExternalDigest(chat: ChatTarget, d: ExternalDigestView): Rendered;
  /** 发送一条新消息，返回渠道的消息 id。 */
  send(chat: ChatTarget, payload: unknown, silent: boolean, dedupKey: string): Promise<string>;
  edit(chat: ChatTarget, externalId: string, payload: unknown): Promise<void>;
  classify(err: unknown): DeliveryError;
  /**
   * 去掉实体的纯文本降级：渠道以永久错误拒绝 payload 时用它重试一次。去掉格式与链接，只保留文字
   * （Telegram 保留键盘；飞书卡片只保留标题与正文文字）；无法降级时返回 null。
   */
  plain(payload: unknown): unknown;
}
