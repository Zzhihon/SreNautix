import type { Incident, StageAReport } from '@srenautix/contract';
import type pg from 'pg';
import type { Queryable } from '../store/pool.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IncidentRow {
  incident_id: string;
  cluster_id: string;
  label: string;
  version: number;
  state: 'firing' | 'resolved' | 'merged';
  severity: string;
  first_firing_at: Date;
  ended_at: Date | null;
  root_component: string | null;
  suppressed: boolean;
  observability_blind: boolean;
  split_from: string | null;
  merged_into: string | null;
  body: Incident;
  updated_at: Date;
}

/**
 * 事件引用（contract IncidentRef）：incident_id、稳定标签，或别名表中的旧 id 与旧标签。
 * 合并过的事件解析到吸收它的事件（沿别名链走到底）。
 */
export async function resolveIncidentRef(
  db: pg.Pool | Queryable,
  ref: string,
  clusterId: string | null = null,
): Promise<IncidentRow | null> {
  let id: string | null;
  if (UUID.test(ref)) {
    id = ref.toLowerCase();
  } else {
    const r = await db.query<{ incident_id: string }>(
      'SELECT incident_id FROM server.incidents WHERE label = $1 AND ($2::text IS NULL OR cluster_id = $2) ORDER BY created_at DESC LIMIT 1',
      [ref, clusterId],
    );
    id = r.rows[0]?.incident_id ?? null;
    if (!id) {
      const a = await db.query<{ from_incident_id: string }>(
        'SELECT from_incident_id FROM server.incident_aliases WHERE from_label = $1 AND ($2::text IS NULL OR cluster_id = $2) ORDER BY merged_at DESC LIMIT 1',
        [ref, clusterId],
      );
      id = a.rows[0]?.from_incident_id ?? null;
    }
  }
  for (let hops = 0; id && hops < 16; hops++) {
    const r = await db.query<IncidentRow>('SELECT * FROM server.incidents WHERE incident_id = $1', [id]);
    const row = r.rows[0];
    if (row && row.state !== 'merged') {
      return row;
    }
    const a = await db.query<{ into_incident_id: string }>(
      'SELECT into_incident_id FROM server.incident_aliases WHERE from_incident_id = $1',
      [id],
    );
    const next = a.rows[0]?.into_incident_id ?? row?.merged_into ?? null;
    if (!next) {
      return row ?? null;
    }
    id = next;
  }
  return null;
}

export async function incidentVersion(
  db: pg.Pool | Queryable,
  incidentId: string,
  version: number,
): Promise<Incident | null> {
  const r = await db.query<{ body: Incident }>(
    'SELECT body FROM server.incident_versions WHERE incident_id = $1 AND version = $2',
    [incidentId, version],
  );
  return r.rows[0]?.body ?? null;
}

export async function latestStageA(
  db: pg.Pool | Queryable,
  incidentId: string,
  version: number | null = null,
): Promise<StageAReport | null> {
  const r = await db.query<{ body: StageAReport }>(
    `SELECT body FROM server.stage_a_reports WHERE incident_id = $1 AND ($2::int IS NULL OR incident_version = $2)
      ORDER BY incident_version DESC LIMIT 1`,
    [incidentId, version],
  );
  return r.rows[0]?.body ?? null;
}

/** 提议绑定的当前值（DESIGN §2.4）：事件版本、根因组件、当前版本有效的证据指纹（阶段 A 与已完成的研判）。 */
export interface CurrentBinding {
  incidentId: string;
  clusterId: string;
  version: number;
  rootComponent: string | null;
  fingerprints: Set<string>;
  state: IncidentRow['state'];
}

export async function currentBinding(db: pg.Pool | Queryable, incidentId: string): Promise<CurrentBinding | null> {
  const r = await db.query<{
    cluster_id: string;
    version: number;
    root_component: string | null;
    state: IncidentRow['state'];
  }>('SELECT cluster_id, version, root_component, state FROM server.incidents WHERE incident_id = $1', [incidentId]);
  const row = r.rows[0];
  if (!row) {
    return null;
  }
  const fps = await db.query<{ fp: string }>(
    `SELECT evidence_fingerprint AS fp FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2
     UNION SELECT evidence_fingerprint FROM server.research_runs WHERE incident_id = $1 AND incident_version = $2 AND evidence_fingerprint IS NOT NULL`,
    [incidentId, row.version],
  );
  return {
    incidentId,
    clusterId: row.cluster_id,
    version: row.version,
    rootComponent: row.root_component,
    fingerprints: new Set(fps.rows.map((x) => x.fp)),
    state: row.state,
  };
}
