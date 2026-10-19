import { AsyncLocalStorage } from 'node:async_hooks';
import OpenAI from 'openai';
import type { ModelRoute } from '@srenautix/contract';
import { logger } from '../log.js';
import { findSecrets, mergeHits, redactText, type RedactionHits, type RedactionKind } from './redact.js';
import type { Item, LlmRequest, Segment } from './types.js';

// 唯一的出站模块（DESIGN §8.4）：worker 发往模型服务的每个请求都在这里构造客户端、脱敏、检查蜜标并计量。
// 其他模块不得直接引用 openai 的运行时或调用 fetch 访问模型端点（test/unit/egress-lint.test.ts 检查）。

export class EgressBlocked extends Error {
  override name = 'EgressBlocked';
  constructor(
    readonly reason: 'halted' | 'honeytoken' | 'secret_in_body' | 'cross_border' | 'host_mismatch',
    message: string,
  ) {
    super(message);
  }
}

export interface EgressPolicy {
  /** 国内配置默认禁止出境路由（in_domain=false） */
  allowCrossBorder: boolean;
  /** 运行时蜜标：任何出站请求体包含其中之一，立即停止全部出站 */
  honeytokens: readonly string[];
}

export interface EgressCall {
  bytes: number;
}

/** 出站请求体中不允许出现的高置信度凭证类别；命中说明脱敏链路有缺口，请求不发出 */
const BODY_FORBIDDEN: ReadonlySet<RedactionKind> = new Set(['pem', 'jwt', 'cloud_ak', 'api_token']);

export interface PreparedRequest {
  request: LlmRequest;
  hits: RedactionHits;
}

function redactSegment(s: Segment, hits: RedactionHits): Segment {
  if (s.egress === 'allow') {
    return s;
  }
  const r = redactText(s.text);
  mergeHits(hits, r.hits);
  return { ...s, text: r.text };
}

export class Egress {
  private haltReason: string | null = null;
  private readonly current = new AsyncLocalStorage<EgressCall>();

  constructor(
    private readonly policy: EgressPolicy,
    private readonly onHalt: (reason: string) => void,
  ) {
    for (const t of policy.honeytokens) {
      if (t.length < 16) {
        throw new Error('蜜标长度至少 16 个字符');
      }
      if (findSecrets(t).length || redactText(t).text !== t) {
        throw new Error('蜜标的形状不能被脱敏规则命中，否则脱敏会把它掩盖');
      }
    }
  }

  get halted(): string | null {
    return this.haltReason;
  }

  /** 出站前对请求做脱敏：egress=redact 的片段与模型自己的历史输出 */
  prepare(req: LlmRequest): PreparedRequest {
    const hits: RedactionHits = {};
    const items: Item[] = req.items.map((i): Item => {
      switch (i.type) {
        case 'system':
        case 'user':
          return { ...i, segments: i.segments.map((s) => redactSegment(s, hits)) };
        case 'assistant': {
          const r = redactText(i.text);
          mergeHits(hits, r.hits);
          return { ...i, text: r.text };
        }
        case 'tool_result':
          return { ...i, output: redactSegment(i.output, hits) };
        case 'tool_call':
          return i;
      }
    });
    return { request: { ...req, items }, hits };
  }

  /** 路由是否允许出站；不允许时抛出，路由配置校验与每次请求都调用 */
  assertRouteAllowed(route: ModelRoute): void {
    if (!route.in_domain && !this.policy.allowCrossBorder) {
      throw new EgressBlocked('cross_border', `路由 ${route.id} 在境外（in_domain=false），当前配置禁止出境`);
    }
  }

  /** 为一条路由构造 OpenAI 客户端；所有请求经过 guardedFetch */
  client(route: ModelRoute, apiKey: string, timeoutMs: number): OpenAI {
    this.assertRouteAllowed(route);
    const base = new URL(route.base_url);
    const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== base.origin) {
        throw new EgressBlocked('host_mismatch', `请求地址 ${url.origin} 与路由 ${route.id} 的 base_url 不一致`);
      }
      const body = init?.body ?? null;
      if (body !== null && typeof body !== 'string') {
        throw new Error('模型请求体必须是字符串');
      }
      this.inspect(route, body ?? '');
      const call = this.current.getStore();
      if (call) {
        call.bytes += Buffer.byteLength(body ?? '', 'utf8');
      }
      return fetch(input, init);
    };
    return new OpenAI({ apiKey, baseURL: route.base_url, timeout: timeoutMs, maxRetries: 0, fetch: guardedFetch });
  }

  /** 在出站计量上下文中执行一次调用；call.bytes 累计实际发出的字节数（调用失败时同样有效） */
  async track<T>(call: EgressCall, fn: () => Promise<T>): Promise<T> {
    return this.current.run(call, fn);
  }

  private inspect(route: ModelRoute, body: string): void {
    if (this.haltReason) {
      throw new EgressBlocked('halted', `出站已停止：${this.haltReason}`);
    }
    this.assertRouteAllowed(route);
    for (const t of this.policy.honeytokens) {
      if (body.includes(t)) {
        this.haltReason = `路由 ${route.id} 的请求体命中蜜标`;
        logger.error('出站请求命中蜜标，停止全部出站', { route: route.id });
        this.onHalt(this.haltReason);
        throw new EgressBlocked('honeytoken', this.haltReason);
      }
    }
    const leaked = findSecrets(body).filter((k) => BODY_FORBIDDEN.has(k));
    if (leaked.length) {
      throw new EgressBlocked(
        'secret_in_body',
        `路由 ${route.id} 的请求体中仍有凭证（${leaked.join('、')}），请求未发出`,
      );
    }
  }
}
