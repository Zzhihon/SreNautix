import type { Channel, Disposition, FeedbackReasonCode, Incident } from '@srenautix/contract';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import type { ChatLinks } from '../identity/chat-links.js';
import { incidentVersion } from '../incident/read.js';
import type { FeedbackService } from '../proposals/feedback.js';
import type { Approver, ProposalService } from '../proposals/service.js';
import type { ActionOutcome, ChannelActor, NotifyActions } from './ports.js';

const CODES = new Set([
  'not_linked',
  'forbidden',
  'tier_requires_console',
  'already_decided',
  'expired',
  'stale',
  'not_found',
]);

/** server 业务错误 → 渠道的操作结果；其余错误按缺陷抛出。 */
function outcomeOf(e: unknown): ActionOutcome {
  if (!(e instanceof HttpError)) {
    throw e;
  }
  if (CODES.has(e.code)) {
    return { ok: false, code: e.code as Exclude<ActionOutcome, { ok: true }>['code'], message: e.message };
  }
  if (e.status === 400 || e.status === 422) {
    return { ok: false, code: 'invalid', message: e.message };
  }
  if (e.status === 403) {
    return { ok: false, code: 'forbidden', message: e.message };
  }
  if (e.status === 503) {
    return { ok: false, code: 'unavailable', message: e.message };
  }
  return { ok: false, code: 'invalid', message: e.message };
}

/**
 * 渠道回调交回 server 的操作（DESIGN §9.2、§11）。聊天账号必须先绑定；审批人的角色与作用域按绑定主体在 Git 中的角色绑定计算，
 * 组取主体最近一次登录控制台时身份源给出的组。
 */
export class ServerNotifyActions implements NotifyActions {
  constructor(
    private readonly pool: pg.Pool,
    private readonly proposals: ProposalService,
    private readonly feedback: FeedbackService,
    private readonly links: ChatLinks,
  ) {}

  private async approver(a: ChannelActor): Promise<Approver | null> {
    if (!a.principalId) {
      return null;
    }
    const u = await this.pool.query<{ groups: string[] }>('SELECT groups FROM server.users WHERE principal_id = $1', [
      a.principalId,
    ]);
    return {
      principalId: a.principalId,
      channel: a.channel,
      subject: { id: a.principalId, groups: u.rows[0]?.groups ?? [] },
      linked: true,
      reauth: null,
    };
  }

  private notLinked(): ActionOutcome {
    return { ok: false, code: 'not_linked', message: '先在控制台获取绑定码，发送 /link <绑定码>' };
  }

  async approve(actor: ChannelActor, proposalId: string): Promise<ActionOutcome> {
    const who = await this.approver(actor);
    if (!who) {
      return this.notLinked();
    }
    try {
      await this.proposals.approve(who, proposalId, null);
      return { ok: true, message: '已批准，审批断言已签发' };
    } catch (e) {
      return outcomeOf(e);
    }
  }

  async reject(actor: ChannelActor, proposalId: string, reason: string): Promise<ActionOutcome> {
    const who = await this.approver(actor);
    if (!who) {
      return this.notLinked();
    }
    try {
      await this.proposals.reject(who, proposalId, reason);
      return { ok: true, message: '已拒绝' };
    } catch (e) {
      return outcomeOf(e);
    }
  }

  async undo(actor: ChannelActor, proposalId: string): Promise<ActionOutcome> {
    const who = await this.approver(actor);
    if (!who) {
      return this.notLinked();
    }
    try {
      await this.proposals.undo(who, proposalId);
      return { ok: true, message: '撤销已提交' };
    } catch (e) {
      return outcomeOf(e);
    }
  }

  private async incident(id: string, version: number): Promise<Incident | null> {
    return incidentVersion(this.pool, id, version);
  }

  async feedbackRoot(
    actor: ChannelActor,
    t: { incidentId: string; incidentVersion: number; researchRunId: string | null },
    verdict: 'confirmed' | 'rejected',
    rootComponent: string | null,
    reason: string | null,
    reasonCode: FeedbackReasonCode | null,
  ): Promise<ActionOutcome> {
    if (!actor.principalId) {
      return this.notLinked();
    }
    const inc = await this.incident(t.incidentId, t.incidentVersion);
    if (!inc) {
      return { ok: false, code: 'not_found', message: '事件不存在' };
    }
    try {
      await this.feedback.create({ principalId: actor.principalId, channel: actor.channel, linked: true }, inc, {
        research_run_id: t.researchRunId,
        verdict,
        root_component: verdict === 'confirmed' ? null : rootComponent,
        disposition_verdict: null,
        disposition: null,
        mechanism: null,
        reason,
        reason_code: reasonCode,
      });
      return { ok: true, message: '已记录反馈' };
    } catch (e) {
      return outcomeOf(e);
    }
  }

  async feedbackDisposition(
    actor: ChannelActor,
    t: { incidentId: string; incidentVersion: number; researchRunId: string | null },
    verdict: 'confirmed' | 'rejected',
    disposition: Disposition | null,
    reasonCode: FeedbackReasonCode | null,
  ): Promise<ActionOutcome> {
    if (!actor.principalId) {
      return this.notLinked();
    }
    const inc = await this.incident(t.incidentId, t.incidentVersion);
    if (!inc) {
      return { ok: false, code: 'not_found', message: '事件不存在' };
    }
    try {
      await this.feedback.create({ principalId: actor.principalId, channel: actor.channel, linked: true }, inc, {
        research_run_id: t.researchRunId,
        verdict: null,
        root_component: null,
        disposition_verdict: verdict,
        disposition: verdict === 'rejected' ? disposition : null,
        mechanism: null,
        reason: null,
        reason_code: reasonCode,
      });
      return { ok: true, message: '已记录反馈' };
    } catch (e) {
      return outcomeOf(e);
    }
  }

  async resolvedConfirm(actor: ChannelActor, incidentId: string, version: number): Promise<ActionOutcome> {
    if (!actor.principalId) {
      return this.notLinked();
    }
    const inc = await this.incident(incidentId, version);
    if (!inc) {
      return { ok: false, code: 'not_found', message: '事件不存在' };
    }
    await this.feedback.resolvedConfirm({ principalId: actor.principalId, channel: actor.channel, linked: true }, inc);
    return { ok: true, message: '已确认恢复' };
  }

  async link(channel: Channel, channelUserId: string, code: string): Promise<ActionOutcome> {
    const r = await this.links.redeem(channel, channelUserId, code);
    if (r.ok) {
      return { ok: true, message: `已绑定到 ${r.principalId}` };
    }
    return {
      ok: false,
      code: 'invalid',
      message: r.reason === 'already_used' ? '绑定码已使用' : '绑定码不存在或已过期',
    };
  }

  async linkedPrincipal(channel: Channel, channelUserId: string): Promise<string | null> {
    return (await this.links.lookup(channel, channelUserId))?.principalId ?? null;
  }

  linkByUnionId(channel: Channel, channelUserId: string, unionId: string): Promise<string | null> {
    return this.links.linkByUnionId(channel, channelUserId, unionId);
  }
}
