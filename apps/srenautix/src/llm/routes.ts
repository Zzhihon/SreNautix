import type { DialectProfile, ModelRoute } from '@srenautix/contract';
import { DEFAULT_BREAKER, RouteBreaker } from './breaker.js';
import { newCalibration, type Calibration } from './budget.js';
import { declaredProfile } from './dialect.js';
import type { Egress } from './egress.js';
import { FingerprintTracker } from './fingerprint.js';
import type { RouteRuntime } from './session.js';

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

export function buildRuntimes(inputs: readonly RouteInput[], egress: Egress, callTimeoutMs: number): RouteRuntime[] {
  checkRoutes(inputs.map((i) => i.route));
  return inputs.map((i) => ({
    route: i.route,
    profile: i.state.profile ?? declaredProfile(i.route.dialect_profile),
    client: egress.client(i.route, i.apiKey, callTimeoutMs),
    breaker: new RouteBreaker(i.route.id, { ...DEFAULT_BREAKER, callTimeoutMs }),
    calibration: i.state.calibration ?? newCalibration(i.route.id),
    fingerprint: new FingerprintTracker(i.route.id, i.state.fingerprint),
  }));
}
