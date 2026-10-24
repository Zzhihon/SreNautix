import type { PackSet, RenderEntity } from '@srenautix/packs-sdk';
import { GoalDataUnavailable, type GoalEvidence } from './evidence.js';
import type { Backend, LoadGuard } from './limits.js';

// 负载保护（ADR 0146 §6.2）：领域的 load_guards 是证据卡，声明保护的后端。每次直接查询这个后端之前执行（BackendLimiter
// 缓存 1 分钟），任何一张异常就跳过查询。保护卡在后端对应的实体上执行：dbstats 为配置的 CNPG Cluster；
// 其余后端没有声明保护卡时不做保护。保护卡本身无法执行（数据源错误）时同样跳过查询：保护不了就不查。

export function packLoadGuard(
  set: () => PackSet,
  evidence: GoalEvidence,
  /** 后端对应的实体；没有时这个后端不做保护 */
  entityOf: (backend: Backend) => (RenderEntity & { uid: string | null }) | null,
  now: () => number = Date.now,
): LoadGuard {
  return async (backend, signal) => {
    const entity = entityOf(backend);
    if (!entity) {
      return null;
    }
    const cards = new Set<string>();
    for (const d of set().domains.values()) {
      for (const g of d.load_guards) {
        if (g.backends.includes(backend as never)) {
          cards.add(g.card);
        }
      }
    }
    for (const card of cards) {
      try {
        const r = await evidence.guardCard(card, entity, now(), signal);
        if (r.verdict === 'abnormal') {
          return { guard: card, reason: r.reason.text.slice(0, 300) };
        }
      } catch (e) {
        if (!(e instanceof GoalDataUnavailable)) {
          throw e;
        }
        return { guard: card, reason: `保护卡没有执行：${e.message}`.slice(0, 300) };
      }
    }
    return null;
  };
}
