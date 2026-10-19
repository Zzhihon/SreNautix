// changes/v1 一致性测试：changes.list(scope, window) → ChangeEvent[]。
// 被测适配器事先装入已知的变更（场景由调用方描述），套件检查：契约形状、只返回窗口内的变更、
// 新的在前、change_id 唯一且以 source 开头、targets 映射到拓扑节点、按组件过滤、limit 与截断、
// 回放时钟窗口。

import { validatorFor, type ChangesListRequest, type ChangesListResponse, type TimeWindow } from '@srenautix/contract';
import { toMillis } from '../clock.js';
import { Checks, expectEq, expectReject, type ConformanceReport } from './report.js';

export interface ChangesSubject {
  name: string;
  source: string;
  list(req: ChangesListRequest, clock: TimeWindow): Promise<ChangesListResponse>;
}

export interface ChangesScenario {
  cluster_id: string;
  clock: TimeWindow;
  /** 含至少 3 个变更的窗口，以及这些变更在窗口内的期望顺序（change_id，新的在前） */
  busy: { window: TimeWindow; expected: string[] };
  /** 没有变更的窗口 */
  quiet: TimeWindow;
  /** 只被部分变更触及的组件，以及按它过滤后的期望 change_id */
  component: { key: string; expected: string[] };
}

export async function runChangesConformance(s: ChangesSubject, sc: ChangesScenario): Promise<ConformanceReport> {
  const c = new Checks('changes/v1', s.name);
  const valid = validatorFor('integrations/changes/v1/changes.schema.json#/$defs/ListResponse');
  const scope = { cluster_id: sc.cluster_id, namespaces: [], components: [] as string[] };
  const req = (window: TimeWindow, over: Partial<ChangesListRequest> = {}): ChangesListRequest => ({
    scope,
    window,
    ...over,
  });

  await c.run('shape-order', '契约形状正确，新的在前', async () => {
    const r = await s.list(req(sc.busy.window), sc.clock);
    if (!valid(r)) {
      throw new Error(`结果不符合契约：${JSON.stringify(valid.errors)}`);
    }
    expectEq(
      'change_id',
      r.changes.map((x) => x.change_id),
      sc.busy.expected,
    );
    return `${r.changes.length} 个变更`;
  });
  await c.run('window', '只返回窗口内的变更', async () => {
    const r = await s.list(req(sc.busy.window), sc.clock);
    const from = toMillis(sc.busy.window.from);
    const to = toMillis(sc.busy.window.to);
    const out = r.changes.filter((x) => toMillis(x.time) < from || toMillis(x.time) > to);
    expectEq(
      '窗口外的变更',
      out.map((x) => x.change_id),
      [],
    );
    return '全部在窗口内';
  });
  await c.run('identity', 'change_id 唯一且以 source 开头，targets 非空', async () => {
    const r = await s.list(req(sc.busy.window), sc.clock);
    const ids = r.changes.map((x) => x.change_id);
    expectEq('重复', ids.length, new Set(ids).size);
    for (const x of r.changes) {
      if (x.source !== s.source || !x.change_id.startsWith(`${s.source}:`)) {
        throw new Error(`${x.change_id} 的 source 不是 ${s.source}`);
      }
      if (!x.targets.length) {
        throw new Error(`${x.change_id} 没有映射到任何拓扑节点`);
      }
    }
    return '唯一';
  });
  await c.run('component-filter', '按组件过滤', async () => {
    const r = await s.list(req(sc.busy.window, { scope: { ...scope, components: [sc.component.key] } }), sc.clock);
    expectEq(
      'change_id',
      r.changes.map((x) => x.change_id),
      sc.component.expected,
    );
    return `${r.changes.length} 个`;
  });
  await c.run('limit', 'limit 截断并标记，保留最新的', async () => {
    const r = await s.list(req(sc.busy.window, { limit: 1 }), sc.clock);
    expectEq(
      'change_id',
      r.changes.map((x) => x.change_id),
      sc.busy.expected.slice(0, 1),
    );
    expectEq('truncated', r.truncated, true);
    return '截断为 1 个';
  });
  await c.run('quiet', '没有变更的窗口返回空', async () => {
    const r = await s.list(req(sc.quiet), sc.clock);
    expectEq('数量', r.changes.length, 0);
    return '空';
  });
  await c.run('clock', '窗口越出回放时钟窗口时拒绝', () =>
    expectReject(
      '越界',
      () => s.list(req({ from: sc.clock.from, to: new Date(toMillis(sc.clock.to) + 60_000).toISOString() }), sc.clock),
      'ClockWindowViolation',
    ),
  );
  return c.report();
}
