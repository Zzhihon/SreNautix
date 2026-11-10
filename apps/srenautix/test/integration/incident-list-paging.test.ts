import type { Incident } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerIncidentRoutes } from '../../src/console-bff/routes-incidents.js';
import type { Auth } from '../../src/identity/auth.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import type { EvidenceRunner } from '../../src/stage-a/ports.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';

// GET /v1/incidents 的翻页与总数（契约 2.57.0）：total 不受 cursor 与 limit 影响，各页不重叠、拼起来是全部事件，
// 最后一页没有 next_cursor；按摘要字段（处置）筛选时 total 是筛选后的数。响应按 openapi.yaml 校验。

const CLUSTER = 'paging';
const MIN = 60_000;
const T = Date.parse('2026-11-01T00:00:00Z');
let db: TestDb;
let app: FastifyInstance;

async function seed(n: number): Promise<string> {
  const id = `9a9e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  for (let n = 1; n <= 5; n++) {
    await seed(n);
  }
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerIncidentRoutes(app, {
    pool: db.server,
    auth: { reader: async () => ({ scopes: 'all' }) } as unknown as Auth,
    feedback: { latest: async () => new Map() } as unknown as FeedbackService,
    topology: new TopologyStore(db.server),
    evidence: {} as EvidenceRunner,
    worker: null,
    services: () => new ServiceCatalog([], []),
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

type Page = {
  items: Array<{ incident_id: string }>;
  next_cursor: string | null;
  total: number;
  total_truncated: boolean;
};

async function page(query: string): Promise<Page> {
  const r = await app.inject({ method: 'GET', url: `/v1/incidents?state=all&cluster_id=${CLUSTER}${query}` });
  expect(r.statusCode).toBe(200);
  expect(responseErrors('/v1/incidents', 'get', 200, r.json())).toBeNull();
  return r.json() as Page;
}

describe('收件箱翻页（契约 2.57.0）', () => {
  it('total 不随翻页变化；各页不重叠，拼起来是全部事件，按首次触发从新到旧；最后一页没有 cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    const totals: number[] = [];
    do {
      const p: Page = await page(`&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      totals.push(p.total);
      expect(p.total_truncated).toBe(false);
      seen.push(...p.items.map((i) => i.incident_id));
      cursor = p.next_cursor;
    } while (cursor);
    expect(totals).toEqual([5, 5, 5]);
    expect(seen).toEqual([5, 4, 3, 2, 1].map((n) => `9a9e0000-0000-4000-8000-${String(n).padStart(12, '0')}`));
  });

  it('按处置筛选时 total 是筛选后的数（没有阶段 A 报告的事件没有处置）', async () => {
    const p = await page('&disposition=act');
    expect([p.total, p.items.length, p.next_cursor]).toEqual([0, 0, null]);
  });
});
