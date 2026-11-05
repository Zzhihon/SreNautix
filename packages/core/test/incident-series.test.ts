import { describe, expect, it } from 'vitest';
import { assertValid, type Alert, type AlertmanagerAlert, type Incident } from '@srenautix/contract';
import {
  AlertCatalog,
  buildKubeTopology,
  computeIncidents,
  DEFAULT_RCA_PARAMS,
  EntityResolver,
  incidentOccurrences,
  incidentSeriesKey,
  memberParents,
  normalizeAlert,
  reconcileIncidents,
  seriesKey,
  TopologyStore,
  type KubeObject,
  type ReconcileResult,
} from '../src/index.js';

// ADR 0184：HPA 告警的组件归到 scaleTargetRef 指向的工作负载；同一系列（告警名集合 + 归一后的根因组件）在重开窗口内
// 复发时重开原事件，窗口之外与不同组件上的复发是新事件。
const CLUSTER = 'demo';
const T0 = Date.parse('2026-10-15T10:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOOKBACK = DEFAULT_RCA_PARAMS.adjacencyMs;
const WINDOW = 7 * DAY;

/** shop 命名空间里的一个 Deployment（ReplicaSet、Pod）与伸缩它的 HPA */
function workload(name: string): KubeObject[] {
  const rs = `${name}-6b8f`;
  return [
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'shop', uid: `uid-${name}` } },
    {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        name: rs,
        namespace: 'shop',
        uid: `uid-${rs}`,
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name, controller: true }],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `${rs}-x1`,
        namespace: 'shop',
        uid: `uid-${rs}-x1`,
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: rs, controller: true }],
      },
      spec: { nodeName: 'node-a' },
    },
    {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name, namespace: 'shop', uid: `uid-hpa-${name}` },
      spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name }, minReplicas: 1, maxReplicas: 3 },
    },
  ];
}

function store(objects: KubeObject[]): TopologyStore {
  let n = 0;
  const s = new TopologyStore({
    clusterId: CLUSTER,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  s.reconcile(buildKubeTopology(objects), T0 - 30 * DAY, 'informer');
  return s;
}

const catalog = new AlertCatalog([
  {
    pack: 'test',
    entries: [
      {
        id: 'kube-hpa-maxed-out',
        alertname: 'KubeHpaMaxedOut',
        expr: 'kube_horizontalpodautoscaler_status_current_replicas >= kube_horizontalpodautoscaler_spec_max_replicas',
        role: 'symptom',
        entity: { kind: 'HorizontalPodAutoscaler', name_labels: ['horizontalpodautoscaler'] },
      },
    ],
  },
]);

/**
 * HPA 到顶告警。via 为 hpa 时实体按目录条目取 HPA；为 deployment 时告警自带实体标签，指向被伸缩的 Deployment
 * （同一条规则在不同时期的写法不同，实体在两者之间交替）
 */
async function hpaMaxed(s: TopologyStore, name: string, via: 'hpa' | 'deployment', startsAt: number): Promise<Alert> {
  const labels: Record<string, string> = {
    alertname: 'KubeHpaMaxedOut',
    namespace: 'shop',
    horizontalpodautoscaler: name,
    severity: 'warning',
    ...(via === 'deployment' ? { entity_kind: 'Deployment', entity: name } : {}),
  };
  const raw: AlertmanagerAlert = {
    labels,
    annotations: {},
    startsAt: new Date(startsAt).toISOString(),
    endsAt: '0001-01-01T00:00:00Z',
    status: 'firing',
  };
  return (await normalizeAlert(raw, {
    clusterId: CLUSTER,
    source: 'alertmanager',
    receivedAt: startsAt,
    catalog,
    resolver: new EntityResolver({ store: s }),
    now: startsAt,
  }))!;
}

const resolvedAt = (a: Alert, at: number): Alert => ({ ...a, status: 'resolved', ends_at: new Date(at).toISOString() });

/**
 * 按事件引擎的读法模拟持久化：previous 是仍在触发或回看窗口内结束的事件，其余已持久化的事件作为 dormant；
 * 告警只取仍在触发或回看窗口内结束的
 */
class Engine {
  readonly db = new Map<string, Incident>();
  private n = 0;
  constructor(
    private readonly s: TopologyStore,
    private readonly reopenWindowMs: number | undefined,
  ) {}

  step(alerts: readonly Alert[], now: number): ReconcileResult {
    const visible = alerts.filter((a) => a.ends_at === null || Date.parse(a.ends_at) > now - LOOKBACK);
    const all = [...this.db.values()];
    const previous = all.filter(
      (i) => i.state !== 'merged' && (i.state === 'firing' || Date.parse(i.ended_at!) > now - LOOKBACK),
    );
    const ids = new Set(previous.map((i) => i.incident_id));
    const graph = this.s.asOf(now);
    const r = reconcileIncidents({
      clusterId: CLUSTER,
      previous,
      dormant: all.filter((i) => !ids.has(i.incident_id)),
      reopenWindowMs: this.reopenWindowMs,
      computed: computeIncidents({ alerts: visible, changes: [], graph, params: DEFAULT_RCA_PARAMS, now }),
      topologyVersion: graph.version,
      now,
      newId: () => `22222222-0000-4000-8000-${String(++this.n).padStart(12, '0')}`,
    });
    for (const i of r.incidents) {
      assertValid('schemas/incident.schema.json', i);
      this.db.set(i.incident_id, i);
    }
    return r;
  }
}

/** 一次发生：start 起触发，持续 minutes 分钟后恢复；返回这次的告警（已恢复）与两次对账的结果 */
async function occur(
  e: Engine,
  s: TopologyStore,
  name: string,
  via: 'hpa' | 'deployment',
  start: number,
  minutes = 30,
) {
  const a = await hpaMaxed(s, name, via, start);
  const fired = e.step([a], start + MIN);
  const ended = resolvedAt(a, start + minutes * MIN);
  const resolved = e.step([ended], start + (minutes + 1) * MIN);
  return { alert: ended, fired, resolved };
}

describe('HPA 的组件归到它伸缩的工作负载（ADR 0184）', () => {
  it('scaleTargetRef 生成 scales 边；没有控制者的 HPA 归到 Deployment 的组件，有控制者时跟随控制者', () => {
    const snap = buildKubeTopology(workload('api'));
    expect(snap.edges).toContainEqual(
      expect.objectContaining({
        from: 'HorizontalPodAutoscaler:shop/api',
        to: 'Deployment:shop/api',
        relation: 'scales',
        provenance: 'structural',
        confidence: 1,
        evidence: 'spec.scaleTargetRef Deployment/api',
      }),
    );
    const graph = store(workload('api')).asOf(T0);
    expect(graph.componentOf('HorizontalPodAutoscaler:shop/api')).toBe('Deployment:shop/api');
    expect(graph.membersOf('Deployment:shop/api')).toContain('HorizontalPodAutoscaler:shop/api');
    // scales 不是依赖边
    expect(graph.dependencies('HorizontalPodAutoscaler:shop/api')).toEqual([]);

    // 由 ScaledObject 创建的 HPA：跟随控制者
    const keda = workload('api').map((o) =>
      o.kind === 'HorizontalPodAutoscaler'
        ? {
            ...o,
            metadata: {
              ...o.metadata,
              ownerReferences: [
                { apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', name: 'api', controller: true },
              ],
            },
          }
        : o,
    );
    expect(store(keda).asOf(T0).componentOf('HorizontalPodAutoscaler:shop/api')).toBe('ScaledObject:shop/api');
    expect(memberParents(buildKubeTopology(keda).edges).get('HorizontalPodAutoscaler:shop/api')).toBe(
      'ScaledObject:shop/api',
    );
    expect(memberParents(snap.edges).get('HorizontalPodAutoscaler:shop/api')).toBe('Deployment:shop/api');
  });

  it('实体在 HPA 与 Deployment 之间交替时，告警的组件都是 Deployment', async () => {
    const s = store(workload('api'));
    const a = await hpaMaxed(s, 'api', 'hpa', T0);
    const b = await hpaMaxed(s, 'api', 'deployment', T0);
    expect([a.entity?.kind, a.component]).toEqual(['HorizontalPodAutoscaler', 'Deployment:shop/api']);
    expect([b.entity?.kind, b.component]).toEqual(['Deployment', 'Deployment:shop/api']);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('同一系列复发时重开原事件（ADR 0184）', () => {
  it('3 天里 firing/resolved 10 次、实体交替：1 个事件、10 个版本、10 次发生', async () => {
    const s = store(workload('api'));
    const e = new Engine(s, WINDOW);
    const starts = Array.from({ length: 10 }, (_, k) => T0 + k * 7 * HOUR);
    const first = await occur(e, s, 'api', 'hpa', starts[0]!);
    expect(first.fired.changes.map((c) => c.type)).toEqual(['incident.created']);
    const created = first.fired.incidents[0]!;
    expect(created).toMatchObject({ label: 'Deployment:shop/api:2026-10-15T10:00:00Z', incident_version: 1 });
    expect(first.resolved.changes.map((c) => c.type)).toEqual(['incident.resolved']);

    for (let k = 1; k < 10; k++) {
      const o = await occur(e, s, 'api', k % 2 === 0 ? 'hpa' : 'deployment', starts[k]!);
      // 上一次在 6.5 小时前结束，早已超出 30 分钟的回看窗口：按系列重开，incident_id 与标签不变，版本加一
      expect(o.fired.changes.map((c) => c.type)).toEqual(['incident.updated']);
      expect(o.fired.incidents[0]).toMatchObject({
        incident_id: created.incident_id,
        label: created.label,
        state: 'firing',
        ended_at: null,
        incident_version: k + 1,
      });
      expect(o.resolved.incidents[0]).toMatchObject({ state: 'resolved', incident_version: k + 1 });
    }
    expect(e.db.size).toBe(1);
    const inc = e.db.get(created.incident_id)!;
    expect(inc).toMatchObject({
      incident_version: 10,
      state: 'resolved',
      first_firing_at: '2026-10-15T10:00:00Z',
      root: expect.objectContaining({ component: 'Deployment:shop/api' }),
    });
    expect(incidentSeriesKey(inc)).toBe('Deployment:shop/api|KubeHpaMaxedOut');
    // 每次发生的告警都是成员（之前的已离开），10 次发生各 30 分钟
    expect(inc.members).toHaveLength(10);
    expect(inc.members.filter((m) => m.left_version === null)).toHaveLength(1);
    expect(incidentOccurrences([inc]).map((o) => [o.start, o.end])).toEqual(starts.map((t) => [t, t + 30 * MIN]));
  });

  it('没有重开窗口时（按系列重开关闭）每次复发都是新事件', async () => {
    const s = store(workload('api'));
    const e = new Engine(s, undefined);
    for (let k = 0; k < 4; k++) {
      await occur(e, s, 'api', k % 2 === 0 ? 'hpa' : 'deployment', T0 + k * 7 * HOUR);
    }
    expect(e.db.size).toBe(4);
  });

  it('回看窗口内复发（成员不重叠）同样回到原事件', async () => {
    const s = store(workload('api'));
    const e = new Engine(s, WINDOW);
    const first = await occur(e, s, 'api', 'hpa', T0);
    // 上一次 10:30 恢复，10:40 再次触发：上一次的告警与事件都还在回看窗口内
    const again = await hpaMaxed(s, 'api', 'deployment', T0 + 40 * MIN);
    const r = e.step([first.alert, again], T0 + 41 * MIN);
    expect(e.db.size).toBe(1);
    expect(r.incidents.map((i) => [i.incident_id, i.state])).toEqual([
      [first.fired.incidents[0]!.incident_id, 'firing'],
    ]);
  });

  it('窗口之外复发是新事件；不同组件上的同名告警不合并', async () => {
    const s = store([...workload('api'), ...workload('web')]);
    const e = new Engine(s, WINDOW);
    const api = await occur(e, s, 'api', 'hpa', T0);
    // web 在 api 恢复后 2 小时到顶：系列键不同，另一个事件
    const web = await occur(e, s, 'web', 'hpa', T0 + 2 * HOUR);
    expect(web.fired.changes.map((c) => c.type)).toEqual(['incident.created']);
    expect(web.fired.incidents[0]!.root.component).toBe('Deployment:shop/web');
    // api 在上一次结束 7 天又 1 小时之后复发：超出窗口，新事件
    const late = await occur(e, s, 'api', 'deployment', T0 + 30 * MIN + WINDOW + HOUR);
    expect(late.fired.changes.map((c) => c.type)).toEqual(['incident.created']);
    const lateId = late.fired.incidents[0]!.incident_id;
    expect(lateId).not.toBe(api.fired.incidents[0]!.incident_id);
    expect(e.db.size).toBe(3);
    // 之后的复发回到最近结束的那个事件
    const next = await occur(e, s, 'api', 'hpa', T0 + 30 * MIN + WINDOW + 5 * HOUR);
    expect(next.fired.incidents.map((i) => i.incident_id)).toEqual([lateId]);
    expect(e.db.size).toBe(3);
  });
});

describe('系列键与发生次数', () => {
  it('没有根因或根因是命名空间伪组件时没有系列键；告警名去重排序', () => {
    expect(seriesKey(null, ['A'])).toBeNull();
    expect(seriesKey('Namespace:shop', ['A'])).toBeNull();
    expect(seriesKey('Deployment:shop/api', [])).toBeNull();
    expect(seriesKey('Deployment:shop/api', ['B', 'A', 'B'])).toBe('Deployment:shop/api|A,B');
  });

  it('发生次数：重叠的区间合并，仍在触发的一次没有结束时刻，离开时仍在触发的成员不算', () => {
    const m = (id: string, start: string, end: string | null, left: number | null) => ({
      alert_id: id,
      alertname: 'X',
      role: 'symptom' as const,
      component: 'Deployment:shop/api',
      severity: 'warning' as const,
      status: end === null ? ('firing' as const) : ('resolved' as const),
      starts_at: start,
      ends_at: end,
      joined_version: 1,
      left_version: left,
    });
    const inc = (members: ReturnType<typeof m>[]) => ({ members }) as unknown as Incident;
    const out = incidentOccurrences([
      inc([
        m('a', '2026-10-15T10:00:00Z', '2026-10-15T10:30:00Z', 2),
        m('b', '2026-10-15T10:20:00Z', '2026-10-15T10:45:00Z', 2),
        m('moved', '2026-10-15T09:00:00Z', null, 2),
      ]),
      inc([m('c', '2026-10-15T12:00:00Z', null, null)]),
    ]);
    expect(out).toEqual([
      { start: Date.parse('2026-10-15T10:00:00Z'), end: Date.parse('2026-10-15T10:45:00Z') },
      { start: Date.parse('2026-10-15T12:00:00Z'), end: null },
    ]);
  });
});
