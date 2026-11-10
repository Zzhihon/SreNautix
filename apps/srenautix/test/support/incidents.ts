import type { Incident } from '@srenautix/contract';
import type pg from 'pg';

const MIN = 60_000;
const T = Date.parse('2026-11-01T00:00:00Z');

/** 写一个最小的未恢复事件（根因 Deployment:shop/api-<n>），返回事件 id；需要 server 的扩展迁移 */
export async function seedFiringIncident(pool: pg.Pool, clusterId: string, n: number): Promise<string> {
  const id = `c1a10000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(T + n * MIN).toISOString();
  const root = `Deployment:shop/api-${n}`;
  const body = {
    incident_id: id,
    cluster_id: clusterId,
    label: `${root}:2026-11-01T00:00:00Z`,
    incident_version: 1,
    state: 'firing',
    severity: 'warning',
    first_firing_at: at,
    ended_at: null,
    root: { component: root, entity: null, ambiguous: false, margin: null, silent_root: false },
    candidates: [],
    members: [],
    components: [root],
    categories: ['unclassified'],
    primary_category: 'unclassified',
    services: [],
    primary_service: null,
    primary_service_source: null,
    business_domain: null,
    changes: [],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 1,
    created_at: at,
    updated_at: at,
  } as unknown as Incident;
  await pool.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at,
       root_component, body, categories, primary_category, services, updated_at)
     VALUES ($1, $2, $3, 1, 'firing', 'warning', $4, NULL, $5, $6, '{unclassified}', 'unclassified', '{}', $4)`,
    [id, clusterId, body.label, at, root, JSON.stringify(body)],
  );
  return id;
}
