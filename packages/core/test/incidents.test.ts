import { describe, expect, it } from 'vitest';
import { assertValid, type Alert, type AlertmanagerAlert, type Incident } from '@srenautix/contract';
import {
  computeIncidents,
  DEFAULT_RCA_PARAMS,
  EntityResolver,
  incidentLabel,
  normalizeAlert,
  reconcileIncidents,
  resolveIncidentRef,
  type ReconcileResult,
  type TopologyStore,
} from '../src/index.js';
import { catalog, CLUSTER, clusterStore, MIN, RULE_EXPRS, T0 } from './fixtures.js';

async function alert(
  store: TopologyStore,
  labels: Record<string, string>,
  startsAt: string,
  now: number,
): Promise<Alert> {
  const raw: AlertmanagerAlert = {
    labels,
    annotations: {},
    startsAt,
    endsAt: '0001-01-01T00:00:00Z',
    status: 'firing',
  };
  return (await normalizeAlert(raw, {
    clusterId: CLUSTER,
    source: 'alertmanager',
    receivedAt: now,
    catalog: catalog(),
    resolver: new EntityResolver({ store }),
    ruleExprs: RULE_EXPRS,
    now,
  }))!;
}

function ids() {
  let n = 0;
  return () => `11111111-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

/** 把一次对账的结果并入"数据库"中的事件 */
function persist(db: Map<string, Incident>, r: ReconcileResult): void {
  for (const i of r.incidents) {
    assertValid('schemas/incident.schema.json', i);
    db.set(i.incident_id, i);
  }
}

describe('持久化事件的对账：合并、拆分、别名', () => {
  it('两个症状事件因数据库告警合并，数据库告警消失后拆分', async () => {
    const store = clusterStore();
    const graph = store.asOf(T0 + 60 * MIN);
    const newId = ids();
    const db = new Map<string, Incident>();
    const api = await alert(
      store,
      { alertname: 'ApiErrorRatioHigh', namespace: 'shop', deployment: 'api', severity: 'critical' },
      '2026-10-15T10:02:00Z',
      T0,
    );
    const worker = await alert(
      store,
      { alertname: 'WorkerJobFailuresHigh', namespace: 'shop', deployment: 'worker', severity: 'warning' },
      '2026-10-15T10:03:00Z',
      T0,
    );
    const pg = await alert(
      store,
      { alertname: 'KubeContainerOOMKilled', namespace: 'shop', pod: 'pg-1', severity: 'critical' },
      '2026-10-15T10:01:00Z',
      T0,
    );
    const step = (alerts: Alert[], now: number) => {
      const r = reconcileIncidents({
        clusterId: CLUSTER,
        previous: [...db.values()].filter((i) => i.state !== 'merged'),
        computed: computeIncidents({ alerts, changes: [], graph, params: DEFAULT_RCA_PARAMS, now }),
        topologyVersion: graph.version,
        now,
        newId,
      });
      persist(db, r);
      return r;
    };

    // 10:04 只有两个症状：两个事件
    const r1 = step([api, worker], T0 + 4 * MIN);
    expect(r1.changes.map((c) => c.type)).toEqual(['incident.created', 'incident.created']);
    const [a, b] = r1.incidents;
    expect(a!.label).toBe('Deployment:shop/api:2026-10-15T10:00:00Z');
    expect(b!.label).toBe('Deployment:shop/worker:2026-10-15T10:00:00Z');

    // 10:06 数据库告警到达（触发时间 10:01）：三条告警一个分组，较早创建的 a 保留，b 合并进 a
    const r2 = step([api, worker, pg], T0 + 6 * MIN);
    expect(r2.changes.map((c) => c.type).sort()).toEqual(['incident.merged', 'incident.updated']);
    const a2 = db.get(a!.incident_id)!;
    const b2 = db.get(b!.incident_id)!;
    expect(a2).toMatchObject({
      incident_version: 2,
      label: 'Deployment:shop/api:2026-10-15T10:00:00Z',
      first_firing_at: '2026-10-15T10:01:00Z',
      state: 'firing',
    });
    expect(a2.root.component).toBe('Cluster:shop/pg');
    expect(a2.aliases).toEqual([
      { from_incident_id: b!.incident_id, from_label: b!.label, at_version: 2, merged_at: '2026-10-15T10:06:00Z' },
    ]);
    expect(b2).toMatchObject({ state: 'merged', merged_into: a!.incident_id, incident_version: 2 });
    expect(b2.members.every((m) => m.left_version === 2)).toBe(true);
    expect(a2.members.map((m) => [m.alertname, m.joined_version, m.left_version])).toEqual(
      expect.arrayContaining([
        ['ApiErrorRatioHigh', 1, null],
        ['WorkerJobFailuresHigh', 2, null],
        ['KubeContainerOOMKilled', 2, null],
      ]),
    );
    // 旧标签与旧 id 都解析到合并后的事件
    for (const ref of [b!.label, b!.incident_id, a!.label, a!.incident_id]) {
      expect(resolveIncidentRef(ref, [...db.values()])?.incident_id).toBe(a!.incident_id);
    }

    // 同样的输入再对账一次：没有变化
    const same = step([api, worker, pg], T0 + 7 * MIN);
    expect(same.changes).toEqual([]);
    expect(same.incidents).toEqual([]);

    // 数据库告警被撤回（例如重新映射后不再属于这个集群）：分组拆开，a 保留 api，worker 成为拆分出的新事件
    const r3 = step([api, worker], T0 + 8 * MIN);
    const created = r3.changes.find((c) => c.type === 'incident.created');
    const split = r3.changes.find((c) => c.type === 'incident.split');
    expect(created).toBeDefined();
    expect(split).toMatchObject({ from_incident_id: a!.incident_id, from_version: 3 });
    const a3 = db.get(a!.incident_id)!;
    expect(a3.incident_version).toBe(3);
    expect(a3.members.filter((m) => m.left_version === null).map((m) => m.alertname)).toEqual(['ApiErrorRatioHigh']);
    const c = created!.type === 'incident.created' ? created!.incident : undefined;
    expect(c).toMatchObject({
      split_from: a!.incident_id,
      incident_version: 1,
      label: 'Deployment:shop/worker:2026-10-15T10:00:00Z~2',
    });
    // 合并过的 b 不复活
    expect(db.get(b!.incident_id)!.state).toBe('merged');
  });

  it('告警全部恢复：事件 resolved，ended_at 取最后一条的结束时间', async () => {
    const store = clusterStore();
    const graph = store.asOf(T0);
    const api = await alert(
      store,
      { alertname: 'ApiErrorRatioHigh', namespace: 'shop', deployment: 'api', severity: 'critical' },
      '2026-10-15T10:02:00Z',
      T0,
    );
    const newId = ids();
    const r1 = reconcileIncidents({
      clusterId: CLUSTER,
      previous: [],
      computed: computeIncidents({ alerts: [api], changes: [], graph, params: DEFAULT_RCA_PARAMS, now: T0 + 5 * MIN }),
      topologyVersion: graph.version,
      now: T0 + 5 * MIN,
      newId,
    });
    const resolved = { ...api, status: 'resolved' as const, ends_at: '2026-10-15T10:20:00Z' };
    const r2 = reconcileIncidents({
      clusterId: CLUSTER,
      previous: r1.incidents,
      computed: computeIncidents({
        alerts: [resolved],
        changes: [],
        graph,
        params: DEFAULT_RCA_PARAMS,
        now: T0 + 21 * MIN,
      }),
      topologyVersion: graph.version,
      now: T0 + 21 * MIN,
      newId,
    });
    expect(r2.changes.map((c) => c.type)).toEqual(['incident.resolved']);
    expect(r2.incidents[0]).toMatchObject({ state: 'resolved', ended_at: '2026-10-15T10:20:00Z', incident_version: 1 });
  });

  it('超出回看窗口的 resolved 事件（ADR 0132）：同一告警重新触发时重开；只有标签相同也重开；merged 的只占用标签', async () => {
    const store = clusterStore();
    const graph = store.asOf(T0);
    const labels = { alertname: 'ApiErrorRatioHigh', namespace: 'shop', deployment: 'api', severity: 'critical' };
    const api = await alert(store, labels, '2026-10-15T10:02:00Z', T0);
    const newId = ids();
    const step = (previous: Incident[], dormant: Incident[], alerts: Alert[], now: number) =>
      reconcileIncidents({
        clusterId: CLUSTER,
        previous,
        dormant,
        computed: computeIncidents({ alerts, changes: [], graph, params: DEFAULT_RCA_PARAMS, now }),
        topologyVersion: graph.version,
        now,
        newId,
      });
    const r1 = step([], [], [api], T0 + 5 * MIN);
    const r2 = step(r1.incidents, [], [{ ...api, status: 'resolved', ends_at: '2026-10-15T10:20:00Z' }], T0 + 21 * MIN);
    const resolved = r2.incidents[0]!;
    expect(resolved).toMatchObject({ state: 'resolved', incident_version: 1 });

    // 几小时后同一个告警（指纹与开始时间不变）重新触发：事件已不在 previous 里，只在 dormant 里
    const r3 = step([], [resolved], [api], T0 + 600 * MIN);
    expect(r3.changes.map((c) => c.type)).toEqual(['incident.updated']);
    expect(r3.incidents).toHaveLength(1);
    expect(r3.incidents[0]).toMatchObject({
      incident_id: resolved.incident_id,
      label: resolved.label,
      state: 'firing',
      ended_at: null,
      incident_version: 2,
    });
    assertValid('schemas/incident.schema.json', r3.incidents[0]);
    // 没有 dormant 时（旧行为）新建一个标签相同的事件，持久化时撞上 (cluster_id, label) 唯一约束
    expect(step([], [], [api], T0 + 600 * MIN).incidents[0]).toMatchObject({
      label: resolved.label,
      incident_version: 1,
    });

    // 同一桶里另一次触发（告警 id 不同）：按标签重开同一个事件
    const again = await alert(store, labels, '2026-10-15T10:07:00Z', T0 + 600 * MIN);
    expect(again.alert_id).not.toBe(api.alert_id);
    const r4 = step([], [resolved], [again], T0 + 600 * MIN);
    expect(r4.incidents.map((i) => [i.incident_id, i.label, i.state, i.incident_version])).toEqual([
      [resolved.incident_id, resolved.label, 'firing', 2],
    ]);

    // merged 的事件不重开，标签照样占用
    const merged: Incident = { ...resolved, state: 'merged', merged_into: '11111111-0000-4000-8000-999999999999' };
    const r5 = step([], [merged], [again], T0 + 600 * MIN);
    expect(r5.changes.map((c) => c.type)).toEqual(['incident.created']);
    expect(r5.incidents[0]).toMatchObject({ label: `${resolved.label}~2`, incident_version: 1 });
    expect(r5.incidents[0]!.incident_id).not.toBe(resolved.incident_id);
  });

  it('标签取整到 10 分钟', () => {
    expect(incidentLabel('Cluster:shop/pg', Date.parse('2026-10-15T10:29:59Z'))).toBe(
      'Cluster:shop/pg:2026-10-15T10:20:00Z',
    );
    expect(incidentLabel(null, Date.parse('2026-10-15T10:30:00Z'))).toBe('unlabelled:2026-10-15T10:30:00Z');
  });
});
