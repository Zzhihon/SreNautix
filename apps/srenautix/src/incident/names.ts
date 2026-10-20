import type { Incident } from '@srenautix/contract';
import type { Queryable } from '../store/pool.js';

// 组件的可读名称（ADR 0101）：阶段 A 按领域包的 display_name 来源求出，存在 server.component_names。
// 只用于显示（标题、通知、控制台、issue），组件键不变。

/** 一批组件键的名称；没有名称的键不在结果中 */
export async function componentNames(
  q: Queryable,
  clusterId: string,
  keys: Iterable<string | null | undefined>,
): Promise<Record<string, string>> {
  const wanted = [...new Set([...keys].filter((k): k is string => !!k))];
  if (!wanted.length) {
    return {};
  }
  const r = await q.query<{ component: string; display_name: string }>(
    'SELECT component, display_name FROM server.component_names WHERE cluster_id = $1 AND component = ANY($2::text[])',
    [clusterId, wanted],
  );
  return Object.fromEntries(r.rows.map((x) => [x.component, x.display_name]));
}

/** 事件涉及的组件：根因、候选与成员组件 */
export function incidentComponentKeys(inc: Pick<Incident, 'root' | 'candidates' | 'components'>): string[] {
  return [inc.root.component, ...inc.candidates.map((c) => c.component), ...inc.components].filter(
    (k): k is string => !!k,
  );
}

/** 事件附上组件名称（读取接口、通知与 issue 使用） */
export async function withComponentNames<T extends Incident>(q: Queryable, inc: T): Promise<T> {
  return { ...inc, component_names: await componentNames(q, inc.cluster_id, incidentComponentKeys(inc)) };
}
