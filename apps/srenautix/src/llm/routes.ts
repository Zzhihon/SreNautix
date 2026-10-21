import type { DialectProfile, ModelRoute } from '@srenautix/contract';
import { DEFAULT_BREAKER, RouteBreaker } from './breaker.js';
import { restoredCalibration, type Calibration } from './budget.js';
import { declaredProfile } from './dialect.js';
import { EgressBlocked, type Egress } from './egress.js';
import { FingerprintTracker } from './fingerprint.js';
import type { RouteRuntime } from './session.js';
import { resolveTimeouts, type ModelClass, type RouteTimeouts } from './timeouts.js';

/** 持久化的路由状态：探测得到的方言档案、估算校准、已知的服务方指纹 */
export interface RouteState {
  profile: DialectProfile | null;
  calibration: Calibration | null;
  fingerprint: string | null;
}

export interface RouteInput {
  route: ModelRoute;
  apiKey: string;
  state: RouteState;
  /** 生效的超时与模型类别（配置解析时得出）；省略时按模型类别默认值（ADR 0098） */
  timeouts?: { modelClass: ModelClass; timeouts: RouteTimeouts };
}

/** 校验路由组合：id 唯一；至少有一条路由属于大模型档 */
export function checkRoutes(routes: readonly ModelRoute[]): void {
  const ids = routes.map((r) => r.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`模型路由 id 重复：${ids.join('、')}`);
  }
  if (!routes.length) {
    throw new Error('至少需要一条模型路由');
  }
  for (const r of routes) {
    declaredProfile(r.dialect_profile);
  }
}

/** 启动时被出站策略禁用的路由：不构造客户端，任何情况下都不会被调用 */
export interface DisabledRoute {
  id: string;
  reason: EgressBlocked['reason'];
  message: string;
}

/**
 * 按出站策略划分路由：允许的路由构造运行时，不允许的路由（例如国内配置下的境外路由）记为禁用。
 * 禁用的路由不进入模型层，也不构造客户端；即使被误用，出站模块对每个请求仍会再检查一次（Egress.inspect）。
 */
export function partitionRoutes(
  inputs: readonly RouteInput[],
  egress: Egress,
): { runtimes: RouteRuntime[]; disabled: DisabledRoute[] } {
  checkRoutes(inputs.map((i) => i.route));
  const runtimes: RouteRuntime[] = [];
  const disabled: DisabledRoute[] = [];
  for (const i of inputs) {
    const t = i.timeouts ?? resolveTimeouts(i.route, {});
    let client: RouteRuntime['client'];
    try {
      // SDK 的 timeout 只覆盖到收到响应头为止；流式调用的首 token 与空闲超时由 stream.ts 计时
      client = egress.client(i.route, i.apiKey, t.timeouts.firstTokenMs);
    } catch (e) {
      if (e instanceof EgressBlocked) {
        disabled.push({ id: i.route.id, reason: e.reason, message: e.message });
        continue;
      }
      throw e;
    }
    runtimes.push({
      route: i.route,
      profile: i.state.profile ?? declaredProfile(i.route.dialect_profile),
      client,
      timeouts: t.timeouts,
      modelClass: t.modelClass,
      breaker: new RouteBreaker(i.route.id, { ...DEFAULT_BREAKER, latencyThresholdMs: t.timeouts.firstTokenMs / 2 }),
      // 系数在可信范围之外的已保存校准从头开始（ADR 0129）
      calibration: restoredCalibration(i.route.id, i.state.calibration),
      fingerprint: new FingerprintTracker(i.route.id, i.state.fingerprint),
    });
  }
  return { runtimes, disabled };
}

/** 全部路由都必须可用（评测与测试）：有路由被出站策略禁用时抛出 */
export function buildRuntimes(inputs: readonly RouteInput[], egress: Egress): RouteRuntime[] {
  const { runtimes, disabled } = partitionRoutes(inputs, egress);
  const first = disabled[0];
  if (first) {
    throw new EgressBlocked(first.reason, first.message);
  }
  return runtimes;
}
