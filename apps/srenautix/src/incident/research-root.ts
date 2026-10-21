import type pg from 'pg';

/**
 * 研判根因与发现根因是否一致（ADR 0104 §14）：按属主粒度比较，两个组件键相同，或沿 owned_by 取到的顶层属主相同
 * （Pod 与它所属的 Deployment、同一 Deployment 的两个 Pod）就算一致。没有属主时取键本身。
 */
export function rootsAgree(a: string, b: string, ownerOf: (key: string) => string | null): boolean {
  if (a === b) {
    return true;
  }
  return (ownerOf(a) ?? a) === (ownerOf(b) ?? b);
}

/** 事件最近一次完成的研判给出的根因，及它与事件根因是否一致 */
export interface ResearchRoot {
  run_id: string;
  component: string;
  mismatch: boolean;
}

export interface ResearchRootIncident {
  incident_id: string;
  cluster_id: string;
  root_component: string | null;
}

export type OwnerLookup = (clusterId: string, key: string, at: Date) => Promise<string | null>;

/**
 * 每个事件最近一次完成、给出了根因的研判，与事件根因按属主粒度比较。事件没有根因时不比较（mismatch 为 false）。
 * 只标记，不改变事件的分组与根因：发现必须可以确定地重放，不随模型的输出变化。
 */
export async function researchRoots(
  pool: pg.Pool,
  ownerOf: OwnerLookup,
  incidents: readonly ResearchRootIncident[],
  now = new Date(),
): Promise<Map<string, ResearchRoot>> {
  const out = new Map<string, ResearchRoot>();
  if (!incidents.length) {
    return out;
  }
  const runs = await pool.query<{ incident_id: string; run_id: string; root_component: string }>(
    `SELECT DISTINCT ON (incident_id) incident_id, run_id, root_component FROM server.research_runs
      WHERE incident_id = ANY($1::uuid[]) AND state = 'completed' AND root_component IS NOT NULL
      ORDER BY incident_id, started_at DESC`,
    [incidents.map((i) => i.incident_id)],
  );
  const byId = new Map(incidents.map((i) => [i.incident_id, i]));
  for (const r of runs.rows) {
    const inc = byId.get(r.incident_id);
    if (!inc) {
      continue;
    }
    let mismatch = false;
    if (inc.root_component && inc.root_component !== r.root_component) {
      const owners = new Map<string, string | null>();
      for (const k of [inc.root_component, r.root_component]) {
        owners.set(k, await ownerOf(inc.cluster_id, k, now));
      }
      mismatch = !rootsAgree(inc.root_component, r.root_component, (k) => owners.get(k) ?? null);
    }
    out.set(r.incident_id, { run_id: r.run_id, component: r.root_component, mismatch });
  }
  return out;
}
