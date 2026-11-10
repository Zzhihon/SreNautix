import type { Incident } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forbidden } from '../../src/kernel/errors.js';
import { createApp } from '../../src/kernel/http.js';
import { registerIncidentRoutes } from '../../src/console-bff/routes-incidents.js';
import type { Auth } from '../../src/identity/auth.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import type { EvidenceRunner } from '../../src/stage-a/ports.js';
import { migrateExpand } from '../../src/kernel/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 事件的认领（ADR 0195）：认领、接手、放下都记录；收件箱的一行带当前处理人；时间线有每一次认领与放下；
// 没有 claim 权限的调用方被拒绝。响应按 openapi.yaml 校验。

const CLUSTER = 'claims';
const MIN = 60_000;
const T = Date.parse('2026-11-01T00:00:00Z');
let db: TestDb;
let app: FastifyInstance;

async function seed(n: number): Promise<string> {
  const id = `c1a10000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = new Date(T + n * MIN).toISOString();
  const root = `Deployment:shop/api-${n}`;
  const body = {
    incident_id: id,
    cluster_id: CLUSTER,
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
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at,
       root_component, body, categories, primary_category, services, updated_at)
     VALUES ($1, $2, $3, 1, 'firing', 'warning', $4, NULL, $5, $6, '{unclassified}', 'unclassified', '{}', $4)`,
    [id, CLUSTER, body.label, at, root, JSON.stringify(body)],
  );
  return id;
}

let caller = 'user:alice';
let allowed = true;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  await seed(1);
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerIncidentRoutes(app, {
    pool: db.server,
    auth: {
      reader: async () => ({ scopes: 'all' }),
      user: async (_req: unknown, permission: string) => {
        if (!allowed) {
          throw forbidden(`没有权限 ${permission}`);
        }
        return { kind: 'user', subject: { id: caller, groups: [] }, channel: 'console' };
      },
    } as unknown as Auth,
    feedback: { latest: async () => new Map() } as unknown as FeedbackService,
    topology: new TopologyStore(db.server),
    evidence: {} as EvidenceRunner,
    worker: null,
    services: () => new ServiceCatalog([], []),
    businessImpactAlerts: () => [],
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const ID = 'c1a10000-0000-4000-8000-000000000001';
type Claim = { principal_id: string; channel: string; claimed_at: string } | null;

async function claimOnRow(): Promise<Claim> {
  const r = await app.inject({ method: 'GET', url: `/v1/incidents?state=all&cluster_id=${CLUSTER}` });
  expect(responseErrors('/v1/incidents', 'get', 200, r.json())).toBeNull();
  return (r.json() as { items: Array<{ claim: Claim }> }).items[0]!.claim;
}

describe('事件的认领（ADR 0195）', () => {
  it('认领、接手、放下：收件箱的一行跟着变，时间线记下每一次', async () => {
    expect(await claimOnRow()).toBeNull();
    const a = await app.inject({ method: 'POST', url: `/v1/incidents/${ID}/claim` });
    expect(a.statusCode).toBe(200);
    expect(responseErrors('/v1/incidents/{incident_ref}/claim', 'post', 200, a.json())).toBeNull();
    expect(await claimOnRow()).toMatchObject({ principal_id: 'user:alice', channel: 'console' });

    caller = 'user:bob';
    await app.inject({ method: 'POST', url: `/v1/incidents/${ID}/claim` });
    expect((await claimOnRow())?.principal_id).toBe('user:bob');

    const del = await app.inject({ method: 'DELETE', url: `/v1/incidents/${ID}/claim` });
    expect(del.statusCode).toBe(204);
    expect(await claimOnRow()).toBeNull();
    // 没有处理人时放下不做事，也不记录
    expect((await app.inject({ method: 'DELETE', url: `/v1/incidents/${ID}/claim` })).statusCode).toBe(204);

    const t = await app.inject({ method: 'GET', url: `/v1/incidents/${ID}/timeline` });
    expect(responseErrors('/v1/incidents/{incident_ref}/timeline', 'get', 200, t.json())).toBeNull();
    const claims = (t.json() as Array<{ kind: string; text: string }>).filter((e) => e.kind === 'claim');
    expect(claims.map((e) => e.text)).toEqual([
      'user:alice 认领（console）',
      'user:bob 认领（console）',
      'user:bob 放下（console）',
    ]);
  });

  it('没有 claim 权限的调用方被拒绝', async () => {
    allowed = false;
    const r = await app.inject({ method: 'POST', url: `/v1/incidents/${ID}/claim` });
    expect(r.statusCode).toBe(403);
    allowed = true;
  });
});
