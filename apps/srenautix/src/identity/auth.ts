import type { FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../api/errors.js';
import type { Bindings, Permission, RoleBinding, Subject, Target } from './bindings.js';
import type { CallerRegistry, ServiceCaller } from './callers.js';
import { csrfMatches, SESSION_COOKIE, type Session, type Sessions } from './sessions.js';

/** 一次请求的调用方。 */
export type Caller =
  | { kind: 'user'; session: Session; sessionId: string; subject: Subject; channel: 'console' }
  | { kind: 'grafana'; caller: ServiceCaller; subject: Subject; channel: 'grafana' }
  | { kind: 'service'; caller: ServiceCaller };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Grafana 插件转发时唯一允许的写操作：createFeedback。 */
const GRAFANA_WRITES = new Set(['POST /v1/incidents/:ref/feedback']);

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * 认证与授权。控制台用服务端会话（cookie），改变状态的请求校验 Origin 与 CSRF token；
 * 服务调用方（worker、分支、外部提议方、Grafana 插件）用 bearer token。
 *
 * Grafana 插件（调用方文件中 kind: grafana 的 token）转发时带 X-SreNautix-On-Behalf-Of（Grafana 用户的邮箱）：
 * server 把邮箱映射到登录过 SreNautix 的用户（OIDC 的 email 声明），按该用户的角色绑定授权；
 * 映射不到或映射到多个用户时返回 403。只放行 GET 与 createFeedback。
 */
export class Auth {
  constructor(
    private readonly sessions: Sessions,
    private readonly callers: CallerRegistry,
    private bindings: Bindings,
    private readonly publicOrigin: string,
    /** 控制台创建的 API token（存在 PG，只有提议权限）；不在调用方文件中的 token 再查这里。 */
    private readonly apiTokens: ((token: string) => Promise<ServiceCaller | null>) | null = null,
    /** 邮箱 → 登录过的用户（按小写比较）；没有配置时 Grafana 插件的请求一律 403。 */
    private readonly usersByEmail: ((email: string) => Promise<Subject[]>) | null = null,
  ) {}

  setBindings(b: Bindings): void {
    this.bindings = b;
  }

  get currentBindings(): Bindings {
    return this.bindings;
  }

  async optional(req: FastifyRequest): Promise<Caller | null> {
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      let c = m ? this.callers.authenticate(m[1] as string) : null;
      if (!c && m && this.apiTokens) {
        c = await this.apiTokens(m[1] as string);
      }
      if (!c) {
        throw unauthorized('未知的 bearer token');
      }
      if (c.kind === 'grafana') {
        if (req.method !== 'GET' && !GRAFANA_WRITES.has(`${req.method} ${req.routeOptions.url ?? ''}`)) {
          throw forbidden('Grafana 插件只能调用读取接口与 createFeedback');
        }
        const raw = req.headers['x-srenautix-on-behalf-of'];
        const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!EMAIL.test(email)) {
          throw forbidden('Grafana 插件转发时必须在 X-SreNautix-On-Behalf-Of 中给出用户邮箱');
        }
        const users = this.usersByEmail ? await this.usersByEmail(email) : [];
        if (users.length !== 1) {
          throw forbidden(
            users.length
              ? `邮箱 ${email} 对应多个用户`
              : `邮箱 ${email} 没有对应的 SreNautix 用户（需要先登录一次控制台）`,
          );
        }
        return { kind: 'grafana', caller: c, subject: users[0] as Subject, channel: 'grafana' };
      }
      return { kind: 'service', caller: c };
    }
    const id = req.cookies[SESSION_COOKIE];
    if (!id) {
      return null;
    }
    const session = await this.sessions.touch(id);
    if (!session) {
      return null;
    }
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== this.publicOrigin) {
        throw forbidden('Origin 与控制台地址不一致');
      }
      const csrf = req.headers['x-csrf-token'];
      if (!csrfMatches(session, typeof csrf === 'string' ? csrf : undefined)) {
        throw forbidden('缺少或错误的 X-CSRF-Token');
      }
    }
    return {
      kind: 'user',
      session,
      sessionId: id,
      subject: { id: session.principalId, groups: session.groups },
      channel: 'console',
    };
  }

  async required(req: FastifyRequest): Promise<Caller> {
    const c = await this.optional(req);
    if (!c) {
      throw unauthorized();
    }
    return c;
  }

  /** 人类调用方（控制台或 Grafana 插件）按角色绑定授权；服务调用方由各接口单独规定。 */
  async user(
    req: FastifyRequest,
    permission: Permission,
    target: Target | null = null,
    tier: 'L' | 'H' | null = null,
  ): Promise<Extract<Caller, { subject: Subject }>> {
    const c = await this.required(req);
    if (c.kind === 'service') {
      throw forbidden(`服务调用方 ${c.caller.id} 不能调用这个接口`);
    }
    if (!this.bindings.allowed(c.subject, permission, target, tier)) {
      throw forbidden(`没有权限 ${permission}${target ? `（${target.cluster}/${target.namespace ?? '集群级'}）` : ''}`);
    }
    return c;
  }

  /** 读取类接口：人类调用方返回其 read 作用域，worker 与 Grafana 以外的服务调用方不允许。 */
  async reader(req: FastifyRequest): Promise<{ caller: Caller; scopes: RoleBinding[] | 'all' }> {
    const c = await this.required(req);
    if (c.kind === 'service') {
      if (c.caller.kind === 'worker') {
        return { caller: c, scopes: 'all' };
      }
      if (c.caller.kind === 'external') {
        return {
          caller: c,
          scopes: [
            {
              subject: { kind: 'user', name: c.caller.id },
              role: 'viewer',
              scope: { clusters: ['*'], namespaces: c.caller.namespaces, component_labels: {} },
            },
          ],
        };
      }
      throw forbidden(`服务调用方 ${c.caller.id} 不能调用这个接口`);
    }
    const scopes = this.bindings.scopesFor(c.subject, 'read');
    if (!scopes.length) {
      throw forbidden('没有任何读取权限');
    }
    return { caller: c, scopes };
  }

  service(c: Caller, kind: ServiceCaller['kind']): ServiceCaller {
    if (c.kind !== 'service' || c.caller.kind !== kind) {
      throw forbidden(`只有 ${kind} 服务调用方可以调用这个接口`);
    }
    return c.caller;
  }
}

export function principalOf(c: Caller): string {
  return c.kind === 'service' ? `service:${c.caller.id}` : c.subject.id;
}
