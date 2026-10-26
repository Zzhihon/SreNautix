import type { Channel, Disposition, NotifyMessage, Severity } from '@srenautix/contract';
import type { ExternalWindowStats } from './external.js';

/**
 * 通知层与事件、提议、反馈之间的接口。消息内容（渠道无关的 NotifyMessage）由 notify/compose.ts 从事件状态生成；
 * 渠道适配器（channels/telegram、channels/feishu）只负责渲染、投递、回调校验，回调经 NotifyActions 交回 server。
 */

/** 一个事件当前应当呈现的消息。 */
export interface DesiredIncidentMessage {
  incidentId: string;
  clusterId: string;
  /** 事件稳定标签，用于日志与控制台链接。 */
  label: string;
  severity: Severity;
  state: 'firing' | 'resolved' | 'merged';
  /** 首次触发时间，用于风暴判定与排序。 */
  firstFiringAt: Date;
  /** 事件恢复的时间；恢复后在保留期内继续编辑。 */
  endedAt: Date | null;
  /** 优先级通道（DESIGN §11）：审批与新的 critical → 风暴摘要 → 编辑 → 恢复。 */
  lane: 'urgent' | 'digest' | 'edit' | 'recovery';
  message: NotifyMessage;
  /** 消息中按钮作用的对象，渠道把它们登记到按钮表，回调时原样交回。 */
  targets: ButtonTarget[];
  language: 'zh' | 'en';
  /**
   * external：根因是外部上游且没有业务影响（ADR 0147），不单独推送，进入周期汇总；已经有消息的事件照常编辑。
   * 省略或 null 时照常推送
   */
  digest?: 'external' | null;
  /**
   * planned_retirement：阶段 A 判为 ignore，全部告警由计划内的退役解释（ADR 0167），不推送新消息；已经有消息的事件照常编辑。
   * 省略或 null 时照常推送
   */
  withheld?: 'planned_retirement' | null;
}

/** 按钮作用的对象：kind 与 NotifyButton.kind 一致。 */
export interface ButtonTarget {
  /** 与 NotifyMessage.buttons 中对应按钮的 callback 相同。 */
  key: string;
  kind: NotifyMessageButtonKind;
  incidentId: string;
  incidentVersion: number;
  proposalId: string | null;
  /** 提议的审批档位；聊天渠道只能审批 L 档。非提议按钮为 null。 */
  tier: 'L' | 'H' | null;
  researchRunId: string | null;
  /** 反馈按钮选择的根因组件（从本次研判的拓扑组件中选择）；null 表示“结论错，不知道真实根因”。 */
  rootComponent: string | null;
  /** 处置判断按钮的取值。 */
  disposition: Disposition | null;
  /** feedback_reject 可选的真实根因组件（本次研判的拓扑组件）；其他按钮为空数组。 */
  choices: string[];
}

export type NotifyMessageButtonKind = NotifyMessage['buttons'][number]['kind'];

/** 渠道回调里已经校验过签名、映射到绑定主体的操作人。 */
export interface ChannelActor {
  channel: Channel;
  channelUserId: string;
  /** 已绑定的主体；未绑定为 null（不能审批与反馈）。 */
  principalId: string | null;
  displayName: string;
}

export type ActionOutcome =
  | { ok: true; message: string }
  | {
      ok: false;
      code:
        | 'not_linked'
        | 'forbidden'
        | 'tier_requires_console'
        | 'already_decided'
        | 'expired'
        | 'stale'
        | 'not_found'
        | 'invalid'
        | 'unavailable';
      message: string;
    };

/** server 实现：渠道回调交回的操作。每个操作都记录渠道与绑定主体，并产生对应的隐式反馈。 */
export interface NotifyActions {
  approve(actor: ChannelActor, proposalId: string): Promise<ActionOutcome>;
  reject(actor: ChannelActor, proposalId: string, reason: string): Promise<ActionOutcome>;
  undo(actor: ChannelActor, proposalId: string): Promise<ActionOutcome>;
  /** 根因维度：confirmed，或 rejected 并给出真实根因（null 表示不知道）。 */
  feedbackRoot(
    actor: ChannelActor,
    t: { incidentId: string; incidentVersion: number; researchRunId: string | null },
    verdict: 'confirmed' | 'rejected',
    rootComponent: string | null,
    reason: string | null,
  ): Promise<ActionOutcome>;
  /** 处置维度：confirmed，或 rejected 并给出正确的处置判断。 */
  feedbackDisposition(
    actor: ChannelActor,
    t: { incidentId: string; incidentVersion: number; researchRunId: string | null },
    verdict: 'confirmed' | 'rejected',
    disposition: Disposition | null,
  ): Promise<ActionOutcome>;
  /** 事件恢复时的一键确认。 */
  resolvedConfirm(actor: ChannelActor, incidentId: string, incidentVersion: number): Promise<ActionOutcome>;
  /** `/link <code>`。 */
  link(channel: Channel, channelUserId: string, code: string): Promise<ActionOutcome>;
  /** 按渠道账号查绑定主体。 */
  linkedPrincipal(channel: Channel, channelUserId: string): Promise<string | null>;
  /** 聊天账号与控制台使用同一个身份源时按 union_id 自动绑定；没有唯一匹配的用户时返回 null。 */
  linkByUnionId(channel: Channel, channelUserId: string, unionId: string): Promise<string | null>;
}

/** server 实现：当前应当呈现消息的事件（期望状态的来源），以及提议 TTL 的“首次送达”回写。 */
export interface MessageSource {
  /** 需要消息的事件（推送级别、恢复后保留期内、已经有消息的）。 */
  desired(language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]>;
  /**
   * 指定事件当前的消息，不论严重度、抑制与恢复后的保留期（已结束的事件用已结束状态的模板）；不存在的事件不返回。
   * 启动时重新渲染旧渲染器产出的期望内容用（ADR 0145）；不实现时不重新渲染
   */
  byIds?(incidentIds: readonly string[], language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]>;
  /** 某条消息第一次成功送达：提议的 TTL 从此开始计算。 */
  delivered(incidentId: string, proposalIds: string[], at: Date): Promise<void>;
  /** 外部上游在 [from, to) 内的汇总统计（ADR 0147）；没有启用外部上游汇总时不实现 */
  externalWindow?(from: Date, to: Date): Promise<ExternalWindowStats>;
  /**
   * 一条事件消息（notify_messages.id 为 messageId）第一次送达后调用：它是这个事件在所有渠道目标上的第一条消息时，
   * 返回两个计时起点与是否业务影响类（ADR 0159、0165），之前已有消息送达时返回 null。不实现时不记录首条消息时延
   */
  firstMessage?(incidentId: string, messageId: number, at: Date): Promise<FirstMessage | null>;
}

/** 事件第一条消息的时延口径（ADR 0159、0165） */
export interface FirstMessage {
  /** 事件的计时起点（告警源给出的开始时刻；拆分出的事件为拆分时刻） */
  onsetMs: number;
  /**
   * 从 Alertmanager 起算的计时起点：成员告警第一次在 Alertmanager 中被看到的最早时刻；拆分出的事件为拆分时刻。
   * 送达时没有成员告警在 Alertmanager 中出现过时为 null
   */
  alertmanagerMs: number | null;
  origin: 'new' | 'split';
  businessImpact: boolean;
}
