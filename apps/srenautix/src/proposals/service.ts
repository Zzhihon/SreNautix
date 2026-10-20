import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import type { ApprovalRecord, Channel, Proposal, ProposalCreate } from '@srenautix/contract';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import type { Bindings, Subject } from '../identity/bindings.js';
import { currentBinding, type CurrentBinding } from '../incident/read.js';
import type { ServerMetrics } from '../metrics.js';
import { appendAudit } from '../store/audit.js';
import { appendEvents, type NewEvent } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import {
  AssertionError,
  assertionHash,
  canonical,
  CANON_VERSION,
  checkBinding,
  executionId,
  formatTs,
  paramsHash,
  signService,
  verifyEnvelope,
  type ApprovalAssertion,
  type ApprovalEnvelope,
  type Keyring,
  type Reauth,
  type WebAuthnProof,
} from './assertion.js';
import type { Catalog, CatalogAction } from './catalog.js';
import type { Policies } from './policy.js';

export const SCHEMA_VERSION = '2.2.0';

/** 提议的来源与调用方（由认证上下文决定，DESIGN §9.3）。 */
export type ProposalCaller =
  | { source: 'research'; callerId: string }
  | { source: 'rule'; callerId: string }
  | { source: 'human'; callerId: string; subject: Subject }
  | { source: 'external'; callerId: string; actions: string[]; namespaces: string[]; perHour: number };

/** 审批人：渠道、主体与重新认证凭据。 */
export interface Approver {
  principalId: string;
  channel: Channel;
  subject: Subject;
  /** 聊天渠道：账号是否已绑定；控制台恒为 true。 */
  linked: boolean;
  /** H 档：重新认证的时间、方式与会话哈希（只来自控制台会话）。 */
  reauth: { authTime: Date; method: Reauth['method']; sessionId: string } | null;
}

export interface ProposalSettings {
  profile: 'observe' | 'standard' | 'compliance';
  signingKey: KeyObject | null;
  keyId: string;
  assertionTtlMs: number;
  proposalTtlMs: number;
  proposalTtlCapMs: number;
  hReauthMaxAgeMs: number;
  /** 审批人公钥（approver-keys v1，与 gateway 同一份）：合规配置 H 档的通行密钥凭据；未配置时为 null。 */
  approverKeys?: () => Keyring | null;
}

/** 通行密钥挑战的有效期：浏览器提示超时 2 分钟，留出提交的时间。 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
const WEBAUTHN_TIMEOUT_MS = 120_000;

/** navigator.credentials.get 的 PublicKeyCredential JSON（WebAuthn L3 toJSON，二进制字段为 base64url）。 */
interface AssertionCredentialJson {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string };
}

const B64U = /^[A-Za-z0-9_-]+$/;

function parseCredential(v: unknown): AssertionCredentialJson {
  const c = v as Partial<AssertionCredentialJson> | null;
  const r = c?.response as Partial<AssertionCredentialJson['response']> | undefined;
  const ok =
    c !== null &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    B64U.test(c.id) &&
    c.type === 'public-key' &&
    r !== undefined &&
    [r.clientDataJSON, r.authenticatorData, r.signature].every((x) => typeof x === 'string' && B64U.test(x));
  if (!ok) {
    throw new HttpError(
      400,
      'bad_request',
      'webauthn 必须是 PublicKeyCredential 的 JSON：id、type=public-key、response 的 clientDataJSON、authenticatorData、signature（base64url）',
    );
  }
  return c as AssertionCredentialJson;
}

/** clientDataJSON 中的 challenge；不是 JSON 时 403。 */
function clientChallenge(clientDataJson: string): string {
  try {
    const cd = JSON.parse(Buffer.from(clientDataJson, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof cd.challenge === 'string' ? cd.challenge : '';
  } catch {
    throw new HttpError(403, 'webauthn_bad_client_data', 'clientDataJSON 不是 JSON');
  }
}

/** 断言校验的原因码 → HTTP：时效与绑定为 409，其余（签名、凭据、来源）为 403。 */
function assertionHttpError(e: AssertionError): HttpError {
  const conflict =
    e.code.startsWith('binding_') || ['expired', 'proposal_expired', 'expires_before_issue'].includes(e.code);
  return new HttpError(conflict ? 409 : 403, e.code, e.message);
}

export interface TargetInfo {
  uid: string | null;
  /** pod_restart：由控制器管理（拓扑中有 owned_by 边）。 */
  controllerManaged: boolean;
}

/** 目标的机器推导（DESIGN §16.1 不变量 9：模型给出的目标必须等于机器推导的目标）。 */
export interface TargetResolver {
  resolve(clusterId: string, kind: string, namespace: string | null, name: string): Promise<TargetInfo>;
}

const NAME_KEYS = ['name', 'pod', 'node', 'instance', 'application', 'workflow', 'template', 'cluster', 'repository'];
const OPEN_STATES = ['awaiting_approval', 'approved', 'held', 'dispatched'];

interface Row {
  proposal_id: string;
  state: Proposal['state'];
  body: Proposal;
  cluster_id: string;
  incident_id: string;
  ttl_expires_at: Date | null;
}

/** 需要改仓库的提议（gitops_pr）关联事件 issue：开 PR 之前确保 issue 存在，PR 描述写 Refs，issue 里回链提议（ADR 0095） */
export interface ProposalIssueHook {
  /** 确保事件有 issue，返回从 fromRepo 引用它的写法；不能开出时为 null */
  refFor(incidentId: string, fromRepo: string): Promise<string | null>;
  /** 提议创建之后在 issue 里回链 */
  linked(p: Proposal, refsInBody: boolean): Promise<void>;
}

/** gitops_pr 的参数描述里追加 Refs（不超过目录的 8192 字符上限，已有时不重复） */
export function withRefs(params: Record<string, unknown>, ref: string): Record<string, unknown> {
  const line = `Refs ${ref}`;
  const body = typeof params.body === 'string' ? params.body : '';
  if (body.includes(line)) {
    return params;
  }
  const next = body ? `${body}\n\n${line}` : line;
  return next.length > 8192 ? params : { ...params, body: next };
}

export class ProposalService {
  private issueHook: ProposalIssueHook | null = null;

  setIssueHook(h: ProposalIssueHook | null): void {
    this.issueHook = h;
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly catalog: Catalog,
    private readonly s: ProposalSettings,
    private readonly bindings: () => Bindings,
    private readonly targets: TargetResolver,
    private readonly policies: () => Policies,
    private readonly metrics: ServerMetrics,
  ) {}

  /** 从参数推导目标：kind 取参数中的 kind（目录允许多种时）或目录目标；名称按目录的参数约定取。 */
  targetOf(a: CatalogAction, params: Record<string, unknown>, clusterId: string) {
    const kind = typeof params.kind === 'string' ? params.kind : a.target.kind;
    const ref = a.target.kinds?.find((k) => k.kind === kind) ?? a.target;
    const nameKey = NAME_KEYS.find((k) => typeof params[k] === 'string');
    if (!nameKey) {
      throw new HttpError(400, 'bad_request', `动作 ${a.id} 的参数里没有目标名称`);
    }
    const name = params[nameKey] as string;
    const namespace = a.target.namespaced ? (params.namespace as string) : null;
    return { group: ref.group, version: ref.version, kind, namespace, name, cluster_id: clusterId };
  }

  /** 幂等键：sha256(JCS([incident_id, run_id|rule_id|caller_id, action, params]))。 */
  idempotencyKey(incidentId: string, origin: string, action: string, params: unknown): string {
    return `sha256:${createHash('sha256')
      .update(canonical([incidentId, origin, action, params]))
      .digest('hex')}`;
  }

  /**
   * 提议中转（DESIGN §2.4、§9.3）：绑定字段与事件当前状态不一致返回 409；相同幂等键的未结束提议存在时返回它（200）；
   * 策略不通过时同样创建，state=rejected_by_policy（201）。
   */
  async create(caller: ProposalCaller, body: ProposalCreate): Promise<{ status: 200 | 201; proposal: Proposal }> {
    const hook = body.action === 'gitops_pr' ? this.issueHook : null;
    const repo = (body.params as { repository?: unknown }).repository;
    if (!hook || typeof repo !== 'string') {
      return this.createIn(caller, body, body.params);
    }
    // 幂等键按调用方给出的参数计算；描述里的 Refs 是 server 追加的
    const ref = await hook.refFor(body.incident_id, repo);
    const params = ref ? withRefs(body.params as Record<string, unknown>, ref) : body.params;
    const out = await this.createIn(caller, body, params);
    if (out.status === 201) {
      await hook.linked(out.proposal, ref !== null && params !== body.params);
    }
    return out;
  }

  private async createIn(
    caller: ProposalCaller,
    body: ProposalCreate,
    params: ProposalCreate['params'],
  ): Promise<{ status: 200 | 201; proposal: Proposal }> {
    const a = this.catalog.get(body.action);
    const binding = await currentBinding(this.pool, body.incident_id);
    if (!binding) {
      throw new HttpError(404, 'not_found', `没有事件 ${body.incident_id}`);
    }
    if (!bindingMatches(binding, body.binding)) {
      throw new HttpError(409, 'binding_stale', '提议绑定的事件版本、根因或证据指纹与事件当前状态不一致');
    }
    const origin = body.research_run_id ?? body.rule_id ?? caller.callerId;
    const key = this.idempotencyKey(body.incident_id, origin, body.action, body.params);
    return tx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proposal:${key}`]);
      const prev = await c.query<{ body: Proposal }>(
        'SELECT body FROM server.proposals WHERE idempotency_key = $1 AND state = ANY($2::text[])',
        [key, OPEN_STATES],
      );
      if (prev.rows[0]) {
        return { status: 200 as const, proposal: prev.rows[0].body };
      }
      const checks: Proposal['policy_checks'] = [];
      const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
      check('catalog', !!a, a ? `动作 ${a.id} 在目录中` : `动作 ${body.action} 不在目录中`);
      const paramErr = a ? this.catalog.validateParams(a.id, params) : '动作不在目录中';
      check('params_schema', paramErr === null, paramErr ?? '参数符合目录 schema');
      let target: Proposal['target'] = {
        cluster_id: binding.clusterId,
        kind: '',
        namespace: null,
        name: '',
        uid: null,
        display: '',
      };
      let level: Proposal['level'] = 'irreversible';
      let tier: 'L' | 'H' = 'H';
      let autoRule: string | null = null;
      if (a && paramErr === null) {
        const t = this.targetOf(a, params as Record<string, unknown>, binding.clusterId);
        const info = await this.targets.resolve(binding.clusterId, t.kind, t.namespace, t.name);
        target = {
          cluster_id: t.cluster_id,
          kind: t.kind,
          namespace: t.namespace,
          name: t.name,
          uid: info.uid,
          display: t.namespace ? `${t.namespace}/${t.name}` : t.name,
        };
        const self = this.policies().selfDependency(binding.clusterId, t.kind, t.namespace, t.name);
        ({ level, tier } = this.levelAndTier(a, self, info));
        check('target_resolved', info.uid !== null, info.uid ? `目标 UID ${info.uid}` : '拓扑中没有目标对象的 UID');
        const pol = this.policies().check(binding.clusterId, a.id, t.namespace);
        check('gateway_policy', pol === null, pol ?? '动作与命名空间在 gateway 策略中启用');
        if (self) {
          check('self_dependency', true, '目标属于 SreNautix 自身的依赖：按不可逆加 H 档处理');
        }
        // 自动执行（DESIGN §9.1）：只限规则提议、目录允许、等级可撤销、不是自身依赖、策略列出了这条规则与命名空间
        const ruleName = caller.source === 'rule' && body.rule_id ? (body.rule_id.split('/').pop() ?? '') : '';
        if (
          ruleName &&
          !self &&
          a.auto_execution === 'allowed' &&
          (level === 'reversible' || level === 'reversible_recreatable')
        ) {
          autoRule = this.policies().autoRule(binding.clusterId, a.id, t.namespace, ruleName);
        }
      }
      if (caller.source === 'external') {
        // "*" 表示目录中的全部动作或全部命名空间（控制台创建的 API token）
        const okAction = caller.actions.includes('*') || caller.actions.includes(body.action);
        const okNs =
          caller.namespaces.includes('*') ||
          (target.namespace !== null && caller.namespaces.includes(target.namespace));
        check(
          'caller_scope',
          okAction && okNs,
          okAction && okNs ? '调用方被授权该动作与命名空间' : '调用方没有该动作或命名空间的授权',
        );
        const n = await c.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM server.proposals WHERE body->>'caller_id' = $1 AND created_at > now() - interval '1 hour'",
          [caller.callerId],
        );
        if ((n.rows[0]?.n ?? 0) >= caller.perHour) {
          throw new HttpError(429, 'rate_limited', `调用方 ${caller.callerId} 每小时最多 ${caller.perHour} 个提议`);
        }
      }
      if (caller.source === 'human') {
        const okScope = this.bindings().allowed(caller.subject, 'propose', {
          cluster: binding.clusterId,
          namespace: target.namespace,
          labels: {},
        });
        if (!okScope) {
          throw new HttpError(403, 'forbidden', '没有在该命名空间提议的权限');
        }
      }
      const passed = checks.every((x) => x.passed);
      const now = await dbNow(c);
      const p: Proposal = {
        proposal_id: randomUUID(),
        idempotency_key: key,
        cluster_id: binding.clusterId,
        incident_id: body.incident_id,
        binding: body.binding,
        source: caller.source,
        research_run_id: body.research_run_id,
        rule_id: body.rule_id,
        caller_id: caller.source === 'human' || caller.source === 'external' ? caller.callerId : null,
        action: body.action,
        level,
        tier,
        auto_eligible: autoRule !== null,
        params,
        params_hash: paramsHash(params),
        canon_version: CANON_VERSION,
        target,
        hypothesis_id: body.hypothesis_id,
        evidence_refs: body.evidence_refs,
        expected_effect: body.expected_effect,
        state: passed ? 'awaiting_approval' : 'rejected_by_policy',
        policy_checks: checks,
        approval: null,
        execution: null,
        ttl_expires_at: null,
        first_delivered_at: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      await c.query(
        `INSERT INTO server.proposals (proposal_id, idempotency_key, cluster_id, incident_id, action, level, tier, source, state,
           target_namespace, params, body, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [
          p.proposal_id,
          key,
          p.cluster_id,
          p.incident_id,
          p.action,
          p.level,
          p.tier,
          p.source,
          p.state,
          target.namespace,
          JSON.stringify(p.params),
          JSON.stringify(p),
          now,
        ],
      );
      await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
        { type: 'proposal.created', clusterId: p.cluster_id, payload: p },
      ]);
      this.metrics.proposals.inc({ action: p.action, source: p.source, state: p.state });
      if (passed && autoRule !== null && this.s.signingKey) {
        const principal = `auto:${autoRule}`;
        const r = await this.issue(c, p, null, now, this.s.signingKey, principal, 'auto', undefined);
        await appendAudit(c, 'approval.issued', principal, {
          proposal_id: p.proposal_id,
          assertion_id: r.assertionId,
          assertion_hash: r.aHash,
          tier: r.tier,
          channel: 'auto',
        });
        this.metrics.approvals.inc({ tier: r.tier, channel: 'auto' });
      }
      return { status: 201 as const, proposal: p };
    });
  }

  /** 审批页的服务端重新检查：目录、参数、gateway 策略、目标 UID 是否仍与提议时一致、绑定是否仍然有效。 */
  async recheck(p: Proposal): Promise<Proposal['policy_checks']> {
    const out: Proposal['policy_checks'] = [];
    const a = this.catalog.get(p.action);
    out.push({ name: 'catalog', passed: !!a, detail: a ? `动作 ${p.action} 在目录中` : `动作 ${p.action} 不在目录中` });
    const paramErr = this.catalog.validateParams(p.action, p.params);
    out.push({ name: 'params_schema', passed: paramErr === null, detail: paramErr ?? '参数符合目录 schema' });
    const pol = this.policies().check(p.cluster_id, p.action, p.target.namespace);
    out.push({ name: 'gateway_policy', passed: pol === null, detail: pol ?? '动作与命名空间在 gateway 策略中启用' });
    const info = await this.targets.resolve(p.cluster_id, p.target.kind, p.target.namespace, p.target.name);
    const sameUid = info.uid !== null && info.uid === p.target.uid;
    out.push({
      name: 'target_uid',
      passed: sameUid,
      detail: sameUid
        ? `目标 UID 仍为 ${info.uid}`
        : `目标 UID 现为 ${info.uid ?? '未知'}，提议时为 ${p.target.uid ?? '未知'}`,
    });
    const b = await currentBinding(this.pool, p.incident_id);
    const bound = !!b && bindingMatches(b, p.binding);
    out.push({
      name: 'binding',
      passed: bound,
      detail: bound ? '事件版本、根因与证据指纹仍与提议一致' : '事件已变化，提议绑定已失效',
    });
    return out;
  }

  /** 等级与档位（DESIGN §9.1、§9.2）。 */
  levelAndTier(
    a: CatalogAction,
    selfDependency: boolean,
    info: TargetInfo,
  ): { level: Proposal['level']; tier: 'L' | 'H' } {
    let level: Proposal['level'] = a.level;
    let tier: 'L' | 'H' = a.min_tier;
    if (a.level === 'reversible_recreatable' && !info.controllerManaged) {
      level = a.fallback_level ?? 'irreversible';
      tier = a.fallback_min_tier ?? a.min_tier;
    }
    if (level === 'compensable' || a.blast_radius.l_tier_max === 0) {
      tier = 'H';
    }
    if (selfDependency) {
      level = 'irreversible';
      tier = 'H';
    }
    return { level, tier };
  }

  private async lock(c: Queryable, id: string): Promise<Row> {
    const r = await c.query<Row>(
      'SELECT proposal_id, state, body, cluster_id, incident_id, ttl_expires_at FROM server.proposals WHERE proposal_id = $1 FOR UPDATE',
      [id],
    );
    if (!r.rows[0]) {
      throw new HttpError(404, 'not_found', `没有提议 ${id}`);
    }
    return r.rows[0];
  }

  private async save(c: Queryable, p: Proposal, extra: NewEvent[] = []): Promise<void> {
    const now = await dbNow(c);
    p.updated_at = now.toISOString();
    await c.query(
      `UPDATE server.proposals SET state = $2, body = $3, updated_at = $4, ttl_expires_at = $5, first_delivered_at = $6 WHERE proposal_id = $1`,
      [p.proposal_id, p.state, JSON.stringify(p), now, p.ttl_expires_at, p.first_delivered_at],
    );
    await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
      ...extra,
      { type: 'proposal.updated', clusterId: p.cluster_id, payload: p },
    ]);
    this.metrics.proposals.inc({ action: p.action, source: p.source, state: p.state });
  }

  /** 审批前的公共检查：状态、TTL、绑定是否仍然有效。返回不能审批的原因码。 */
  private async decidable(c: Queryable, row: Row): Promise<'already_decided' | 'expired' | 'stale' | null> {
    const p = row.body;
    if (p.state !== 'awaiting_approval') {
      return p.state === 'stale' ? 'stale' : p.state === 'expired' ? 'expired' : 'already_decided';
    }
    const now = await dbNow(c);
    const cap = new Date(new Date(p.created_at).getTime() + this.s.proposalTtlCapMs);
    if ((row.ttl_expires_at && now >= row.ttl_expires_at) || now >= cap) {
      p.state = 'expired';
      await this.save(c, p);
      return 'expired';
    }
    const b = await currentBinding(c, p.incident_id);
    if (!b || !bindingMatches(b, p.binding)) {
      p.state = 'stale';
      await this.save(c, p);
      return 'stale';
    }
    return null;
  }

  /**
   * 审批（DESIGN §9.2）：L 档可在聊天（已绑定账号）或控制台批；H 档只能在控制台，5 分钟内重新认证过并输入目标名。
   * 审批人的作用域按目标所在的命名空间计算；签发服务签名断言并记入治理审计链。
   */
  async approve(
    who: Approver,
    id: string,
    confirmTarget: string | null,
    webauthn: unknown = null,
  ): Promise<{ proposal: Proposal; envelope: ApprovalEnvelope }> {
    if (!this.s.signingKey) {
      throw new HttpError(409, 'approvals_disabled', '观察模式没有审批能力');
    }
    const key = this.s.signingKey;
    return tx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      const why = await this.decidable(c, row);
      if (why) {
        throw new HttpError(409, why, `提议不能审批：${why}`);
      }
      const p = row.body;
      if (who.channel !== 'console' && !who.linked) {
        throw new HttpError(403, 'not_linked', '聊天账号未绑定，先在控制台获取绑定码并发送 /link <code>');
      }
      if (p.tier === 'H' && who.channel !== 'console') {
        throw new HttpError(403, 'tier_requires_console', 'H 档提议只能在控制台审批');
      }
      const passkey = p.tier === 'H' && this.s.profile === 'compliance';
      if (passkey && webauthn === null) {
        throw new HttpError(
          403,
          'webauthn_required',
          '合规配置下 H 档必须用通行密钥签名：先请求 POST /v1/auth/webauthn/assertion-options，再带上 webauthn 审批',
        );
      }
      if (!passkey && webauthn !== null) {
        throw new HttpError(422, 'webauthn_unexpected', '只有合规配置的 H 档审批使用通行密钥，webauthn 应为 null');
      }
      const target = { cluster: p.cluster_id, namespace: p.target.namespace, labels: {} };
      if (!this.bindings().allowed(who.subject, 'approve', target, p.tier)) {
        throw new HttpError(403, 'forbidden', `没有审批 ${p.target.display} 的权限或风险上限不足`);
      }
      if (p.caller_id === who.principalId && this.s.profile === 'compliance') {
        throw new HttpError(403, 'forbidden', '合规配置下提议人不能审批自己的提议');
      }
      const now = await dbNow(c);
      let reauth: Reauth | undefined;
      if (p.tier === 'H') {
        if (confirmTarget !== p.target.display) {
          throw new HttpError(422, 'confirm_target', `H 档审批需要输入目标名 ${p.target.display}`);
        }
        if (
          !who.reauth ||
          now.getTime() - who.reauth.authTime.getTime() > this.s.hReauthMaxAgeMs ||
          who.reauth.authTime > now
        ) {
          throw new HttpError(403, 'reauth_required', 'H 档审批需要 5 分钟内重新认证');
        }
        reauth = {
          method: who.reauth.method,
          auth_time: formatTs(who.reauth.authTime),
          session_hash: `sha256:${createHash('sha256').update(who.reauth.sessionId).digest('hex')}`,
        };
      }
      if (passkey) {
        const r = await this.recordIssued(c, p, await this.passkeyEnvelope(c, p, who, parseCredential(webauthn), now));
        const proof = r.envelope.proof as WebAuthnProof;
        await appendAudit(c, 'approval.issued', who.principalId, {
          proposal_id: p.proposal_id,
          assertion_id: r.assertionId,
          assertion_hash: r.aHash,
          tier: r.tier,
          channel: who.channel,
          proof: 'webauthn_ed25519',
          credential_id: proof.credential_id,
          self_approved: false,
        });
        await this.implicitFeedback(c, p, who, 'approved');
        this.metrics.approvals.inc({ tier: r.tier, channel: who.channel });
        return { proposal: p, envelope: r.envelope };
      }
      const { envelope, assertionId, aHash, tier } = await this.issue(
        c,
        p,
        row.ttl_expires_at,
        now,
        key,
        who.principalId,
        who.channel,
        reauth,
      );
      await appendAudit(c, 'approval.issued', who.principalId, {
        proposal_id: p.proposal_id,
        assertion_id: assertionId,
        assertion_hash: aHash,
        tier,
        channel: who.channel,
        self_approved: p.caller_id === who.principalId,
      });
      await this.implicitFeedback(c, p, who, 'approved');
      this.metrics.approvals.inc({ tier, channel: who.channel });
      return { proposal: p, envelope };
    });
  }

  /** 合规配置的 H 档：审批人公钥文件中的 WebAuthn 设置与该主体登记的凭据。 */
  private passkeys(principal: string): { keys: Keyring; credentials: string[] } {
    const keys = this.s.approverKeys?.() ?? null;
    if (!keys?.rpId) {
      throw new HttpError(
        409,
        'webauthn_not_configured',
        '合规配置的 H 档审批需要通行密钥：approvals.approver_keys_file 没有配置，或其中没有 webauthn 设置',
      );
    }
    const credentials = [...keys.webauthn.entries()].filter(([, v]) => v.principal === principal).map(([id]) => id);
    if (!credentials.length) {
      throw new HttpError(
        409,
        'webauthn_no_credential',
        `${principal} 没有登记通行密钥（approver_keys_file 的 webauthn 条目）`,
      );
    }
    return { keys, credentials };
  }

  /**
   * 合规配置 H 档的通行密钥挑战（POST /v1/auth/webauthn/assertion-options）：按提议当前的绑定构造待签名的断言，
   * 挑战是 sha256(JCS(断言)) 的 base64url（ADR 0020 第 4 条），只能用一次，5 分钟内有效；同一审批人对同一提议的旧挑战作废。
   */
  async webauthnOptions(who: Approver, id: string): Promise<Record<string, unknown>> {
    if (!this.s.signingKey) {
      throw new HttpError(409, 'approvals_disabled', '观察模式没有审批能力');
    }
    return tx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      const why = await this.decidable(c, row);
      if (why) {
        throw new HttpError(409, why, `提议不能审批：${why}`);
      }
      const p = row.body;
      if (p.tier !== 'H' || this.s.profile !== 'compliance') {
        throw new HttpError(409, 'webauthn_not_required', '只有合规配置的 H 档审批使用通行密钥');
      }
      const target = { cluster: p.cluster_id, namespace: p.target.namespace, labels: {} };
      if (!this.bindings().allowed(who.subject, 'approve', target, p.tier)) {
        throw new HttpError(403, 'forbidden', `没有审批 ${p.target.display} 的权限或风险上限不足`);
      }
      if (p.caller_id === who.principalId) {
        throw new HttpError(403, 'forbidden', '合规配置下提议人不能审批自己的提议');
      }
      const { keys, credentials } = this.passkeys(who.principalId);
      const now = await dbNow(c);
      const assertion = await this.assertionFor(c, p, row.ttl_expires_at, now, who.principalId, who.channel);
      const challenge = createHash('sha256').update(canonical(assertion)).digest('base64url');
      await c.query(
        'DELETE FROM server.webauthn_challenges WHERE proposal_id = $1 AND principal_id = $2 AND used_at IS NULL',
        [p.proposal_id, who.principalId],
      );
      await c.query(
        `INSERT INTO server.webauthn_challenges (challenge, proposal_id, principal_id, assertion, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          challenge,
          p.proposal_id,
          who.principalId,
          JSON.stringify(assertion),
          now,
          new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
        ],
      );
      return {
        challenge,
        rpId: keys.rpId,
        timeout: WEBAUTHN_TIMEOUT_MS,
        userVerification: 'required',
        allowCredentials: credentials.map((cid) => ({ type: 'public-key', id: cid })),
      };
    });
  }

  /**
   * 用通行密钥断言组成信封：挑战必须是该审批人对该提议签发过、未用过、未过期的；断言与提议的绑定仍然一致；
   * 按 gateway 的同一套规则校验签名（rpIdHash、UP 与 UV、来源白名单、凭据属于审批人）。成功后挑战作废。
   */
  private async passkeyEnvelope(
    c: Queryable,
    p: Proposal,
    who: Approver,
    cred: AssertionCredentialJson,
    now: Date,
  ): Promise<ApprovalEnvelope> {
    const { keys } = this.passkeys(who.principalId);
    const challenge = clientChallenge(cred.response.clientDataJSON);
    const r = await c.query<{ assertion: ApprovalAssertion; expires_at: Date; used_at: Date | null }>(
      `SELECT assertion, expires_at, used_at FROM server.webauthn_challenges
        WHERE challenge = $1 AND proposal_id = $2 AND principal_id = $3 FOR UPDATE`,
      [challenge, p.proposal_id, who.principalId],
    );
    const ch = r.rows[0];
    if (!ch) {
      throw new HttpError(403, 'webauthn_challenge_unknown', '挑战不是为该审批人与提议签发的，或已被更新的挑战取代');
    }
    if (ch.used_at) {
      throw new HttpError(403, 'webauthn_challenge_used', '挑战已经用过');
    }
    if (now >= ch.expires_at) {
      throw new HttpError(403, 'webauthn_challenge_expired', '挑战已过期，重新请求 assertion-options');
    }
    const envelope: ApprovalEnvelope = {
      assertion: ch.assertion,
      proof: {
        type: 'webauthn_ed25519',
        credential_id: cred.id,
        authenticator_data: cred.response.authenticatorData,
        client_data_json: cred.response.clientDataJSON,
        signature: cred.response.signature,
      },
    };
    try {
      verifyEnvelope(envelope, keys, { requireWebAuthnForH: true });
      checkBinding(
        ch.assertion,
        {
          proposal_id: p.proposal_id,
          action: p.action,
          params: p.params,
          target_uid: p.target.uid ?? '',
          cluster: p.cluster_id,
          incident_version: p.binding.incident_version,
          root_component: p.binding.root_component,
          evidence_fingerprint: p.binding.evidence_fingerprint,
          proposal_expires_at: null,
        },
        now,
        null,
      );
    } catch (e) {
      if (e instanceof AssertionError) {
        throw assertionHttpError(e);
      }
      throw e;
    }
    await c.query('UPDATE server.webauthn_challenges SET used_at = $2 WHERE challenge = $1', [challenge, now]);
    return envelope;
  }

  /**
   * 签发服务签名断言并把提议改为 approved。断言的 expires_at 取断言 TTL 与提议剩余 TTL 中较早的一个；
   * 目标 UID 未知、根因超过断言长度上限、集群 gateway 处于仅提议状态时不签发。
   */
  private async issue(
    c: Queryable,
    p: Proposal,
    ttlExpiresAt: Date | null,
    now: Date,
    key: KeyObject,
    principal: string,
    channel: ApprovalRecord['channel'],
    reauth: Reauth | undefined,
  ): Promise<{ envelope: ApprovalEnvelope; assertionId: string; aHash: string; tier: 'L' | 'H' }> {
    const assertion = await this.assertionFor(c, p, ttlExpiresAt, now, principal, channel);
    return this.recordIssued(c, p, signService(assertion, key, this.s.keyId, reauth));
  }

  /** 待签名的断言；目标 UID 未知、根因过长、gateway 仅提议时不签发。 */
  private async assertionFor(
    c: Queryable,
    p: Proposal,
    ttlExpiresAt: Date | null,
    now: Date,
    principal: string,
    channel: ApprovalRecord['channel'],
  ): Promise<ApprovalAssertion> {
    if (!p.target.uid) {
      throw new HttpError(409, 'target_unresolved', '目标对象的 UID 未知，不能签发断言');
    }
    if (p.binding.root_component.length > 253) {
      throw new HttpError(400, 'root_component_too_long', '根因组件超过断言允许的 253 个字符');
    }
    const spoke = await c.query<{ propose_only: boolean }>(
      'SELECT propose_only FROM server.spoke_status WHERE cluster_id = $1',
      [p.cluster_id],
    );
    if (spoke.rows[0]?.propose_only) {
      throw new HttpError(409, 'propose_only', '该集群的 gateway 处于仅提议状态');
    }
    const issued = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const ttlEnd = ttlExpiresAt ?? new Date(new Date(p.created_at).getTime() + this.s.proposalTtlCapMs);
    const expires = new Date(
      Math.min(issued.getTime() + this.s.assertionTtlMs, Math.max(ttlEnd.getTime(), issued.getTime() + 1000)),
    );
    return {
      proposal_id: p.proposal_id,
      action: p.action,
      level: p.level,
      tier: p.tier,
      params_hash: p.params_hash,
      canon_version: CANON_VERSION,
      target_uid: p.target.uid,
      cluster: p.cluster_id,
      incident_version: p.binding.incident_version,
      root_component: p.binding.root_component,
      evidence_fingerprint: p.binding.evidence_fingerprint,
      approver_principal: principal,
      channel,
      issued_at: formatTs(issued),
      expires_at: formatTs(expires),
    };
  }

  /** 记录已签名的断言（工单队列）并把提议改为 approved。 */
  private async recordIssued(
    c: Queryable,
    p: Proposal,
    envelope: ApprovalEnvelope,
  ): Promise<{ envelope: ApprovalEnvelope; assertionId: string; aHash: string; tier: 'L' | 'H' }> {
    const assertion = envelope.assertion;
    const channel = assertion.channel as ApprovalRecord['channel'];
    const principal = assertion.approver_principal;
    const issued = new Date(assertion.issued_at);
    const expires = new Date(assertion.expires_at);
    const aHash = assertionHash(assertion);
    const assertionId = randomUUID();
    await c.query(
      `INSERT INTO server.approval_assertions (assertion_id, proposal_id, cluster_id, tier, channel, principal_id, assertion_hash, execution_id,
         envelope, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        assertionId,
        p.proposal_id,
        p.cluster_id,
        assertion.tier,
        channel,
        principal,
        aHash,
        executionId(p.proposal_id, aHash),
        JSON.stringify(envelope),
        issued,
        expires,
      ],
    );
    p.state = 'approved';
    p.approval = {
      decision: channel === 'auto' ? 'auto' : 'approved',
      principal_id: principal,
      channel,
      reason: null,
      assertion_id: assertionId,
      at: issued.toISOString(),
    };
    await this.save(c, p, [
      {
        type: 'approval.issued',
        clusterId: p.cluster_id,
        payload: {
          proposal_id: p.proposal_id,
          assertion_id: assertionId,
          tier: assertion.tier,
          expires_at: expires.toISOString(),
        },
      },
    ]);
    return { envelope, assertionId, aHash, tier: assertion.tier };
  }

  async reject(who: Approver, id: string, reason: string): Promise<Proposal> {
    if (!reason.trim() || reason.length > 500) {
      throw new HttpError(400, 'bad_request', '拒绝必须填写 1–500 字的理由');
    }
    return tx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      const why = await this.decidable(c, row);
      if (why) {
        throw new HttpError(409, why, `提议不能拒绝：${why}`);
      }
      const p = row.body;
      if (who.channel !== 'console' && !who.linked) {
        throw new HttpError(403, 'not_linked', '聊天账号未绑定');
      }
      if (
        !this.bindings().allowed(who.subject, 'reject', {
          cluster: p.cluster_id,
          namespace: p.target.namespace,
          labels: {},
        })
      ) {
        throw new HttpError(403, 'forbidden', '没有拒绝该提议的权限');
      }
      const now = await dbNow(c);
      p.state = 'rejected';
      p.approval = {
        decision: 'rejected',
        principal_id: who.principalId,
        channel: who.channel,
        reason: reason.trim(),
        assertion_id: null,
        at: now.toISOString(),
      };
      await this.save(c, p);
      await appendAudit(c, 'approval.rejected', who.principalId, {
        proposal_id: p.proposal_id,
        reason: reason.trim(),
        channel: who.channel,
      });
      await this.implicitFeedback(c, p, who, 'rejected');
      return p;
    });
  }

  /**
   * 撤销已执行的 reversible 动作：提交反向动作（或以执行前参数重新执行）的新提议，并由撤销人直接批准（L 档）。
   * 执行前参数来自 gateway 的 verified 事件中的 restore_params。
   */
  async undo(who: Approver, id: string): Promise<{ proposal: Proposal; envelope: ApprovalEnvelope }> {
    const r = await this.pool.query<Row>(
      'SELECT proposal_id, state, body, cluster_id, incident_id, ttl_expires_at FROM server.proposals WHERE proposal_id = $1',
      [id],
    );
    const orig = r.rows[0]?.body;
    if (!orig) {
      throw new HttpError(404, 'not_found', `没有提议 ${id}`);
    }
    if (orig.state !== 'dispatched' || !orig.execution || !['verified', 'verifying'].includes(orig.execution.phase)) {
      throw new HttpError(409, 'not_undoable', '只有已执行并校验中或校验通过的提议可以撤销');
    }
    const undoAction = this.catalog.undoAction(orig.action);
    if (!undoAction) {
      throw new HttpError(409, 'undo_unavailable', `动作 ${orig.action} 不可撤销`);
    }
    let params: Record<string, unknown>;
    if (undoAction === orig.action) {
      const ev = await this.pool.query<{ body: { restore_params?: Record<string, unknown> } }>(
        "SELECT body FROM server.execution_events WHERE proposal_id = $1 AND body ? 'restore_params' ORDER BY seq DESC LIMIT 1",
        [id],
      );
      const restore = ev.rows[0]?.body.restore_params;
      if (!restore) {
        throw new HttpError(409, 'undo_unavailable', 'gateway 没有给出执行前的参数');
      }
      params = restore;
    } else {
      // 反向动作不带原动作的执行后校验条件
      params = Object.fromEntries(Object.entries(orig.params).filter(([k]) => k !== 'verify'));
    }
    const b = await currentBinding(this.pool, orig.incident_id);
    if (!b) {
      throw new HttpError(404, 'not_found', '事件不存在');
    }
    const root = b.rootComponent;
    if (root === null) {
      throw new HttpError(409, 'root_unknown', '事件当前没有根因组件，不能绑定撤销提议');
    }
    const fp = [...b.fingerprints][0] ?? orig.binding.evidence_fingerprint;
    const created = await this.create(
      { source: 'human', callerId: who.principalId, subject: who.subject },
      {
        incident_id: orig.incident_id,
        binding: { incident_version: b.version, root_component: root, evidence_fingerprint: fp },
        action: undoAction,
        params,
        research_run_id: null,
        rule_id: null,
        hypothesis_id: null,
        evidence_refs: [],
        expected_effect: `撤销提议 ${orig.proposal_id}`,
      },
    );
    if (created.proposal.state !== 'awaiting_approval') {
      throw new HttpError(
        409,
        'undo_rejected',
        `撤销提议未通过策略检查：${created.proposal.policy_checks
          .filter((x) => !x.passed)
          .map((x) => x.detail)
          .join('；')}`,
      );
    }
    const out = await this.approve(who, created.proposal.proposal_id, created.proposal.target.display);
    await tx(this.pool, async (c) => {
      await this.implicitFeedback(c, orig, who, 'undone');
    });
    return out;
  }

  /** 批量审批：只允许同类型、同集群、L 档（DESIGN §9.2），逐项返回结果。 */
  async batch(
    who: Approver,
    ids: string[],
  ): Promise<Array<{ proposal_id: string; outcome: string; message: string; assertion_id: string | null }>> {
    const rows = await this.pool.query<{ proposal_id: string; body: Proposal }>(
      'SELECT proposal_id, body FROM server.proposals WHERE proposal_id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map(rows.rows.map((r) => [r.proposal_id, r.body]));
    const first = byId.get(ids[0] as string);
    const out: Array<{ proposal_id: string; outcome: string; message: string; assertion_id: string | null }> = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (!p) {
        out.push({ proposal_id: id, outcome: 'not_found', message: '提议不存在', assertion_id: null });
        continue;
      }
      if (p.tier !== 'L' || p.action !== first?.action || p.cluster_id !== first.cluster_id) {
        out.push({
          proposal_id: id,
          outcome: p.tier === 'H' ? 'tier_requires_console' : 'forbidden',
          message: '批量审批只限同类型、同集群、L 档',
          assertion_id: null,
        });
        continue;
      }
      try {
        const r = await this.approve(who, id, null);
        out.push({
          proposal_id: id,
          outcome: 'approved',
          message: '已签发审批断言',
          assertion_id: r.proposal.approval?.assertion_id ?? null,
        });
      } catch (e) {
        if (!(e instanceof HttpError)) {
          throw e;
        }
        const map: Record<string, string> = {
          already_decided: 'already_decided',
          expired: 'expired',
          stale: 'stale',
          not_linked: 'not_linked',
          tier_requires_console: 'tier_requires_console',
        };
        out.push({ proposal_id: id, outcome: map[e.code] ?? 'forbidden', message: e.message, assertion_id: null });
      }
    }
    return out;
  }

  /** 隐式反馈（DESIGN §11）：批准、拒绝、撤销自动记为对应反馈。 */
  private async implicitFeedback(
    c: Queryable,
    p: Proposal,
    who: Approver,
    kind: 'approved' | 'rejected' | 'undone',
  ): Promise<void> {
    const inc = await c.query<{ version: number }>('SELECT version FROM server.incidents WHERE incident_id = $1', [
      p.incident_id,
    ]);
    const fb = {
      feedback_id: randomUUID(),
      incident_id: p.incident_id,
      incident_version: inc.rows[0]?.version ?? p.binding.incident_version,
      research_run_id: p.research_run_id,
      principal_id: who.principalId,
      channel: who.channel,
      linked: who.linked,
      implicit: kind,
    };
    const r = await c.query<{ created_at: Date }>(
      `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, research_run_id, principal_id, channel, linked, implicit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING created_at`,
      [
        fb.feedback_id,
        fb.incident_id,
        fb.incident_version,
        fb.research_run_id,
        fb.principal_id,
        fb.channel,
        fb.linked,
        fb.implicit,
      ],
    );
    const payload = {
      ...fb,
      verdict: null,
      root_component: null,
      disposition_verdict: null,
      disposition: null,
      mechanism: null,
      reason: null,
      stale: false,
      created_at: (r.rows[0] as { created_at: Date }).created_at.toISOString(),
    };
    await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
      { type: 'feedback.recorded', clusterId: p.cluster_id, payload },
    ]);
    this.metrics.feedback.inc({ linked: String(who.linked), channel: who.channel, implicit: kind });
  }

  /** 事件引擎在版本变化的同一事务里调用：绑定已失效的未结束提议标为 stale（DESIGN §2.4）。 */
  async markStale(c: Queryable, b: CurrentBinding): Promise<number> {
    const r = await c.query<Row>(
      "SELECT proposal_id, state, body, cluster_id, incident_id, ttl_expires_at FROM server.proposals WHERE incident_id = $1 AND state IN ('awaiting_approval', 'approved', 'held') FOR UPDATE",
      [b.incidentId],
    );
    let n = 0;
    for (const row of r.rows) {
      if (!bindingMatches(b, row.body.binding)) {
        row.body.state = 'stale';
        await this.save(c, row.body);
        await c.query(
          'UPDATE server.approval_assertions SET pulled_at = coalesce(pulled_at, now()) WHERE proposal_id = $1',
          [row.proposal_id],
        );
        n++;
      }
    }
    return n;
  }

  /** 第一次成功送达：提议 TTL 从此开始（DESIGN §9.2），不超过硬上限。 */
  async delivered(ids: string[], at: Date): Promise<void> {
    if (!ids.length) {
      return;
    }
    await tx(this.pool, async (c) => {
      const r = await c.query<Row>(
        'SELECT proposal_id, state, body, cluster_id, incident_id, ttl_expires_at FROM server.proposals WHERE proposal_id = ANY($1::uuid[]) AND first_delivered_at IS NULL FOR UPDATE',
        [ids],
      );
      for (const row of r.rows) {
        const p = row.body;
        const cap = new Date(p.created_at).getTime() + this.s.proposalTtlCapMs;
        p.first_delivered_at = at.toISOString();
        p.ttl_expires_at = new Date(Math.min(at.getTime() + this.s.proposalTtlMs, cap)).toISOString();
        await this.save(c, p);
      }
    });
  }

  /** 周期任务：TTL 或硬上限到期的待审批提议标为 expired。 */
  async expire(): Promise<number> {
    return tx(this.pool, async (c) => {
      const r = await c.query<Row>(
        `SELECT proposal_id, state, body, cluster_id, incident_id, ttl_expires_at FROM server.proposals
          WHERE state = 'awaiting_approval' AND (ttl_expires_at <= now() OR created_at <= now() - make_interval(secs => $1)) FOR UPDATE SKIP LOCKED`,
        [this.s.proposalTtlCapMs / 1000],
      );
      for (const row of r.rows) {
        row.body.state = 'expired';
        await this.save(c, row.body);
      }
      return r.rowCount ?? 0;
    });
  }
}

export function bindingMatches(b: CurrentBinding, x: Proposal['binding']): boolean {
  return (
    b.state !== 'merged' &&
    x.incident_version === b.version &&
    x.root_component === b.rootComponent &&
    b.fingerprints.has(x.evidence_fingerprint)
  );
}

async function dbNow(c: Queryable): Promise<Date> {
  const r = await c.query<{ now: Date }>('SELECT now() AS now');
  return (r.rows[0] as { now: Date }).now;
}
