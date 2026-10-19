import type { Channel, Disposition } from '@srenautix/contract';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { ActionOutcome, ChannelActor, NotifyActions } from './ports.js';
import type { ButtonRow, NotifyStore, PendingReply } from './store.js';

/** 回复式交互的有效期（拒绝原因、真实根因）。 */
export const REPLY_WINDOW_MS = 5 * 60_000;

/** 拒绝原因与反馈原因的长度上限，与契约一致。 */
export const MAX_REASON_CHARS = 500;

export const DISPOSITIONS: readonly Disposition[] = ['act', 'ignore', 'escalate', 'undetermined'];

/** 一次按钮点击（签名与渠道目标已由适配器校验）。form 为飞书表单提交的值；Telegram 没有表单。 */
export interface Click {
  channel: Channel;
  chat: string;
  callbackId: string;
  channelUserId: string;
  displayName: string;
  shortId: string;
  form: Record<string, unknown> | null;
  at: Date;
}

export type ClickResult =
  /** 已处理完（或无需处理），只需应答。 */
  | { type: 'answer'; answer: string }
  /** 先应答，再执行 run（调用 server 的操作并记录结果）。 */
  | { type: 'run'; answer: string; run: () => Promise<void> }
  /** 需要点击者以回复方式补充内容（Telegram）：适配器发送提示并登记提示消息 id。 */
  | {
      type: 'prompt';
      answer: string;
      purpose: PendingReply['purpose'];
      replyId: number;
      button: ButtonRow;
      expiresAt: Date;
    }
  /** 需要点击者在跟进按钮中选择正确的处置判断（Telegram）。 */
  | { type: 'choose'; answer: string; button: ButtonRow; principalId: string };

/** 按钮操作结束后按钮的去向：反馈类按钮释放，可以再次点击；审批类按钮成功即结束。 */
const RELEASE_AFTER = new Set([
  'feedback_confirm',
  'feedback_reject',
  'disposition_confirm',
  'disposition_reject',
  'resolved_confirm',
]);
const FINAL_CODES = new Set(['already_decided', 'expired', 'stale', 'not_found']);

const ACTION_OF: Record<string, string> = {
  approve: 'approve',
  reject: 'reject',
  undo: 'undo',
  feedback_confirm: 'feedback_root',
  feedback_reject: 'feedback_root',
  disposition_confirm: 'feedback_disposition',
  disposition_reject: 'feedback_disposition',
  disposition_pick: 'feedback_disposition',
  resolved_confirm: 'resolved_confirm',
};

export const NOT_LINKED_TEXT = '账号未绑定：先在控制台获取绑定码，再发送 /link <绑定码>';

/**
 * 渠道无关的按钮与回复处理（DESIGN §9.2、§11）：只有绑定过的账号可以审批与反馈；聊天渠道只能批准 L 档提议；
 * 同一回调只处理一次；按钮由第一个回调独占；每次操作的结果写回消息的“最近操作”。
 */
export class Interactions {
  constructor(
    private readonly store: NotifyStore,
    private readonly actions: NotifyActions,
    private readonly metrics: ServerMetrics,
    private readonly kick: () => void,
  ) {}

  private async done(c: Click, action: string, outcome: string, answer: string): Promise<ClickResult> {
    await this.store.setCallbackOutcome(c.channel, c.callbackId, outcome, answer);
    this.metrics.callbacks.inc({ channel: c.channel, action, outcome });
    return { type: 'answer', answer };
  }

  async click(c: Click): Promise<ClickResult> {
    const rec = await this.store.recordCallback({
      channel: c.channel,
      callbackId: c.callbackId,
      chat: c.chat,
      channelUserId: c.channelUserId,
      shortId: c.shortId,
      at: c.at,
    });
    if (!rec.fresh) {
      return { type: 'answer', answer: rec.answer ?? '已收到，正在处理' };
    }
    const btn = await this.store.button(c.shortId);
    if (!btn || btn.channel !== c.channel || btn.chat !== c.chat) {
      return this.done(c, 'unknown', 'unknown_button', '按钮已失效，请在控制台操作');
    }
    const principalId = await this.actions.linkedPrincipal(c.channel, c.channelUserId);
    if (!principalId) {
      return this.done(c, btn.kind, 'not_linked', NOT_LINKED_TEXT);
    }
    if (btn.owner && btn.owner !== c.channelUserId) {
      return this.done(c, btn.kind, 'not_owner', '只有发起这次反馈的成员可以选择');
    }
    if (btn.kind === 'approve' && btn.target.tier !== 'L') {
      return this.done(c, btn.kind, 'tier_requires_console', '这个提议需要在控制台审批（H 档，需要重新认证）');
    }
    if (!(await this.store.claim(btn.shortId, c.callbackId, c.at))) {
      const text =
        btn.kind === 'reject' || btn.kind === 'feedback_reject' ? '其他成员正在填写，见提示消息' : '该按钮已被处理';
      return this.done(c, btn.kind, 'already_handled', text);
    }
    // 渠道没有给出显示名（飞书回调只有 open_id）时用绑定的主体 id
    const actor: ChannelActor = {
      channel: c.channel,
      channelUserId: c.channelUserId,
      principalId,
      displayName: c.displayName || principalId,
    };
    const t = btn.target;
    const ref = { incidentId: t.incidentId, incidentVersion: t.incidentVersion, researchRunId: t.researchRunId };
    const submitted = '已提交，结果见消息';
    const run = (fn: () => Promise<ActionOutcome>): ClickResult => ({
      type: 'run',
      answer: submitted,
      run: () => this.execute(c, btn, actor, fn),
    });
    const form = c.form;
    switch (btn.kind) {
      case 'approve':
        return this.started(
          c,
          btn,
          run(() => this.actions.approve(actor, t.proposalId as string)),
        );
      case 'undo':
        return this.started(
          c,
          btn,
          run(() => this.actions.undo(actor, t.proposalId as string)),
        );
      case 'feedback_confirm':
        return this.started(
          c,
          btn,
          run(() => this.actions.feedbackRoot(actor, ref, 'confirmed', t.rootComponent, null)),
        );
      case 'disposition_confirm':
        return this.started(
          c,
          btn,
          run(() => this.actions.feedbackDisposition(actor, ref, 'confirmed', null)),
        );
      case 'resolved_confirm':
        return this.started(
          c,
          btn,
          run(() => this.actions.resolvedConfirm(actor, t.incidentId, t.incidentVersion)),
        );
      case 'disposition_pick':
        return this.started(
          c,
          btn,
          run(() => this.actions.feedbackDisposition(actor, ref, 'rejected', t.disposition)),
        );
      case 'reject': {
        if (form) {
          const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
          if (!reason || Array.from(reason).length > MAX_REASON_CHARS) {
            await this.store.release(btn.shortId, c.callbackId);
            return this.done(c, btn.kind, 'invalid_reason', `拒绝必须填写原因（不超过 ${MAX_REASON_CHARS} 字）`);
          }
          return this.started(
            c,
            btn,
            run(() => this.actions.reject(actor, t.proposalId as string, reason)),
          );
        }
        return this.prompt(c, btn, actor, 'reject_reason', '请在 5 分钟内回复机器人的提示消息，填写拒绝原因');
      }
      case 'feedback_reject': {
        if (form) {
          const root = typeof form.root === 'string' ? form.root : '';
          if (root !== '-' && !t.choices.includes(root)) {
            await this.store.release(btn.shortId, c.callbackId);
            return this.done(c, btn.kind, 'unknown_component', '请从列表中选择真实根因组件');
          }
          const reason =
            typeof form.reason === 'string' && form.reason.trim()
              ? form.reason.trim().slice(0, MAX_REASON_CHARS)
              : null;
          return this.started(
            c,
            btn,
            run(() => this.actions.feedbackRoot(actor, ref, 'rejected', root === '-' ? null : root, reason)),
          );
        }
        return this.prompt(c, btn, actor, 'root_component', '请在 5 分钟内回复机器人的提示消息，填写真实根因组件');
      }
      case 'disposition_reject': {
        if (form) {
          const d = typeof form.disposition === 'string' ? form.disposition : '';
          if (!(DISPOSITIONS as readonly string[]).includes(d)) {
            await this.store.release(btn.shortId, c.callbackId);
            return this.done(c, btn.kind, 'invalid_disposition', '请选择正确的处置判断');
          }
          return this.started(
            c,
            btn,
            run(() => this.actions.feedbackDisposition(actor, ref, 'rejected', d as Disposition)),
          );
        }
        // 选择按钮发出之后释放，其他成员也可以发起自己的选择
        await this.store.release(btn.shortId, c.callbackId);
        await this.store.setCallbackOutcome(c.channel, c.callbackId, 'awaiting_choice', '请选择正确的处置判断');
        this.metrics.callbacks.inc({ channel: c.channel, action: btn.kind, outcome: 'awaiting_choice' });
        return { type: 'choose', answer: '请选择正确的处置判断', button: btn, principalId };
      }
      default:
        await this.store.release(btn.shortId, c.callbackId);
        return this.done(c, btn.kind, 'invalid_data', '按钮无效');
    }
  }

  private async started(c: Click, btn: ButtonRow, r: ClickResult): Promise<ClickResult> {
    await this.store.setCallbackOutcome(c.channel, c.callbackId, 'submitted', r.type === 'run' ? r.answer : '');
    this.metrics.callbacks.inc({ channel: c.channel, action: btn.kind, outcome: 'submitted' });
    return r;
  }

  private async prompt(
    c: Click,
    btn: ButtonRow,
    actor: ChannelActor,
    purpose: PendingReply['purpose'],
    answer: string,
  ): Promise<ClickResult> {
    const expiresAt = new Date(c.at.getTime() + REPLY_WINDOW_MS);
    const replyId = await this.store.createReply({
      channel: c.channel,
      chat: c.chat,
      shortId: btn.shortId,
      purpose,
      channelUserId: c.channelUserId,
      principalId: actor.principalId as string,
      displayName: actor.displayName,
      now: c.at,
      expiresAt,
    });
    await this.store.setCallbackOutcome(
      c.channel,
      c.callbackId,
      purpose === 'reject_reason' ? 'awaiting_reason' : 'awaiting_root',
      answer,
    );
    this.metrics.callbacks.inc({
      channel: c.channel,
      action: btn.kind,
      outcome: purpose === 'reject_reason' ? 'awaiting_reason' : 'awaiting_root',
    });
    return { type: 'prompt', answer, purpose, replyId, button: btn, expiresAt };
  }

  /** 调用 server 的操作，记录结果，按结果结束或释放按钮。操作失败（异常）时释放按钮，异常原样抛出。 */
  private async execute(
    c: { channel: Channel; chat: string; callbackId: string; at: Date },
    btn: ButtonRow,
    actor: ChannelActor,
    fn: () => Promise<ActionOutcome>,
  ): Promise<void> {
    let out: ActionOutcome;
    try {
      out = await fn();
    } catch (e) {
      await this.store.release(btn.shortId, c.callbackId);
      throw e;
    }
    await this.record(c.channel, c.chat, btn, actor.displayName, ACTION_OF[btn.kind] ?? btn.kind, out, c.at);
    if (RELEASE_AFTER.has(btn.kind) || (!out.ok && !FINAL_CODES.has(out.code))) {
      await this.store.release(btn.shortId, c.callbackId);
    } else {
      await this.store.finish(btn.shortId, c.callbackId, c.at);
    }
    this.kick();
  }

  private async record(
    channel: string,
    chat: string,
    btn: ButtonRow,
    actor: string,
    action: string,
    out: ActionOutcome,
    at: Date,
  ): Promise<void> {
    await this.store.addResult({
      channel,
      chat,
      incidentId: btn.target.incidentId,
      proposalId: btn.target.proposalId,
      action,
      actor,
      ok: out.ok,
      code: out.ok ? null : out.code,
      message: out.message,
      at,
    });
  }

  /**
   * 对提示消息的回复。返回需要回复给用户的说明（null 表示不回复）；不是对提示的回复时返回 undefined。
   * 只有点击者本人、在窗口内、记录仍在等待时才提交。
   */
  async reply(r: {
    channel: Channel;
    chat: string;
    promptMessageId: string;
    channelUserId: string;
    text: string;
    at: Date;
  }): Promise<string | null | undefined> {
    const p = await this.store.replyByPrompt(r.channel, r.chat, r.promptMessageId);
    if (!p) {
      return undefined;
    }
    if (p.channelUserId !== r.channelUserId || p.state !== 'waiting' || r.at >= p.expiresAt) {
      return null;
    }
    const btn = await this.store.button(p.shortId);
    if (!btn) {
      throw new Error(`等待回复 ${p.id} 的按钮 ${p.shortId} 不存在`);
    }
    const actor: ChannelActor = {
      channel: r.channel,
      channelUserId: p.channelUserId,
      principalId: p.principalId,
      displayName: p.displayName,
    };
    const text = r.text.trim();
    const claimId = (await this.claimant(p)) ?? '';
    if (p.purpose === 'reject_reason') {
      if (!text) {
        return null;
      }
      if (Array.from(text).length > MAX_REASON_CHARS) {
        return `原因最长 ${MAX_REASON_CHARS} 字，本次未提交，请在 ${p.expiresAt.toISOString().slice(11, 16)} UTC 前重新回复提示消息`;
      }
      if (!(await this.store.submitReply(p.id, text, r.at))) {
        return null;
      }
      await this.execute({ channel: r.channel, chat: r.chat, callbackId: claimId, at: r.at }, btn, actor, () =>
        this.actions.reject(actor, btn.target.proposalId as string, text),
      );
      return null;
    }
    const parsed = parseRootReply(text, btn.target.choices);
    if (parsed.kind === 'unknown') {
      return `无法识别组件“${parsed.word}”，可选：${btn.target.choices.join('、')}；不知道真实根因时回复 -`;
    }
    if (parsed.kind === 'too_long') {
      return `原因最长 ${MAX_REASON_CHARS} 字，本次未提交，请重新回复`;
    }
    if (!(await this.store.submitReply(p.id, text, r.at))) {
      return null;
    }
    await this.execute({ channel: r.channel, chat: r.chat, callbackId: claimId, at: r.at }, btn, actor, () =>
      this.actions.feedbackRoot(
        actor,
        {
          incidentId: btn.target.incidentId,
          incidentVersion: btn.target.incidentVersion,
          researchRunId: btn.target.researchRunId,
        },
        'rejected',
        parsed.component,
        parsed.reason,
      ),
    );
    return null;
  }

  private async claimant(p: PendingReply): Promise<string | null> {
    const b = await this.store.button(p.shortId);
    return b?.claimedBy ?? null;
  }

  /** 过期的回复窗口：拒绝原因未填写时不提交；真实根因未填写时提交“结论错、根因未知”。 */
  async expire(now: Date): Promise<void> {
    for (const p of await this.store.expireReplies(now)) {
      const btn = await this.store.button(p.shortId);
      if (!btn) {
        continue;
      }
      const by = btn.claimedBy ?? '';
      if (p.purpose === 'reject_reason') {
        await this.store.addResult({
          channel: p.channel,
          chat: p.chat,
          incidentId: btn.target.incidentId,
          proposalId: btn.target.proposalId,
          action: 'reject_timeout',
          actor: p.displayName,
          ok: false,
          code: 'reason_timeout',
          message: '5 分钟内未填写原因，未提交',
          at: now,
        });
        await this.store.release(btn.shortId, by);
        this.kick();
        continue;
      }
      const actor: ChannelActor = {
        channel: p.channel as Channel,
        channelUserId: p.channelUserId,
        principalId: p.principalId,
        displayName: p.displayName,
      };
      try {
        await this.execute({ channel: p.channel as Channel, chat: p.chat, callbackId: by, at: now }, btn, actor, () =>
          this.actions.feedbackRoot(
            actor,
            {
              incidentId: btn.target.incidentId,
              incidentVersion: btn.target.incidentVersion,
              researchRunId: btn.target.researchRunId,
            },
            'rejected',
            null,
            '5 分钟内未填写真实根因',
          ),
        );
      } catch (e) {
        logger.warn('过期的根因反馈提交失败', { error: e, short_id: btn.shortId });
      }
    }
  }

  async link(channel: Channel, channelUserId: string, code: string): Promise<string> {
    const out = await this.actions.link(channel, channelUserId, code);
    return out.message;
  }
}

export type RootReply =
  | { kind: 'ok'; component: string | null; reason: string | null }
  | { kind: 'unknown'; word: string }
  | { kind: 'too_long' };

/**
 * “组件 原因”：第一个词（以空白或常见分隔符分隔）是组件，不分大小写，也接受至少 3 个字符的唯一前缀；
 * “-” 或“跳过”表示不知道真实根因。其后是原因，可以省略。
 */
export function parseRootReply(text: string, choices: readonly string[]): RootReply {
  const t = text.trim();
  if (Array.from(t).length > MAX_REASON_CHARS) {
    return { kind: 'too_long' };
  }
  // 组件键本身含有 ':' 与 '/'，分隔符只用空白与中文标点、逗号、分号
  const m = /^([^\s：，,;；、]+)(?:[\s：，,;；、]+([\s\S]*))?$/.exec(t);
  const word = (m?.[1] ?? '').replace(/[。.!！?？]+$/u, '');
  const reason = m?.[2]?.trim() || null;
  if (word === '-' || word === '跳过' || t === '-') {
    return { kind: 'ok', component: null, reason };
  }
  const lower = word.toLowerCase();
  const exact = choices.find((c) => c.toLowerCase() === lower);
  if (exact) {
    return { kind: 'ok', component: exact, reason };
  }
  // 组件键形如 Kind:ns/name：也接受只写 name 或 ns/name
  const byName = choices.filter((c) => {
    const lc = c.toLowerCase();
    return lc.endsWith(`/${lower}`) || lc.endsWith(`:${lower}`);
  });
  if (byName.length === 1) {
    return { kind: 'ok', component: byName[0] as string, reason };
  }
  if (lower.length >= 3) {
    const pre = choices.filter((c) => {
      const lc = c.toLowerCase();
      const tail = lc.slice(lc.lastIndexOf('/') + 1);
      return lc.startsWith(lower) || tail.startsWith(lower);
    });
    if (pre.length === 1) {
      return { kind: 'ok', component: pre[0] as string, reason };
    }
  }
  return { kind: 'unknown', word: word || t };
}
