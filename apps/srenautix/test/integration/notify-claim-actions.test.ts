import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bindings, type RoleBinding } from '../../src/identity/bindings.js';
import { ChatLinks } from '../../src/identity/chat-links.js';
import { currentClaims } from '../../src/incident/claims.js';
import { migrateExpand } from '../../src/kernel/store/migrate.js';
import { ServerNotifyActions } from '../../src/notify/actions.js';
import type { ChannelActor } from '../../src/notify/ports.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import type { ProposalService } from '../../src/proposals/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { seedFiringIncident } from '../support/incidents.js';

// 聊天消息上的“我来处理”（ADR 0195）：绑定过的账号按角色绑定判断 claim 权限，认领写入与控制台相同的认领记录

const CLUSTER = 'chat-claims';
let db: TestDb;
let actions: ServerNotifyActions;
let incidentId: string;

const binding = (name: string, role: RoleBinding['role']): { binding: RoleBinding; file: string } => ({
  binding: {
    subject: { kind: 'user', name },
    role,
    scope: { clusters: [CLUSTER], namespaces: ['shop'], component_labels: {} },
  } as RoleBinding,
  file: 'test.yaml',
});

const actor = (principalId: string | null, channel: ChannelActor['channel'] = 'telegram'): ChannelActor => ({
  channel,
  channelUserId: `u-${principalId ?? 'none'}`,
  principalId,
  displayName: principalId ?? 'anonymous',
});

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  incidentId = await seedFiringIncident(db.server, CLUSTER, 1);
  const bindings = new Bindings([binding('oidc:alice', 'responder'), binding('oidc:bob', 'viewer')], 'rev');
  actions = new ServerNotifyActions(
    db.server,
    {} as ProposalService,
    {} as FeedbackService,
    new ChatLinks(db.server),
    () => bindings,
  );
});

afterAll(async () => {
  await db?.close();
});

describe('聊天渠道认领事件', () => {
  it('没有绑定的账号先绑定', async () => {
    expect(await actions.claim(actor(null), incidentId)).toMatchObject({ ok: false, code: 'not_linked' });
  });

  it('没有 claim 权限（viewer）时拒绝，不写认领记录', async () => {
    expect(await actions.claim(actor('oidc:bob'), incidentId)).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await currentClaims(db.server, [incidentId])).get(incidentId)).toBeUndefined();
  });

  it('不能认领的渠道拒绝', async () => {
    expect(await actions.claim(actor('oidc:alice', 'slack'), incidentId)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('responder 认领后成为处理人，记录渠道', async () => {
    expect(await actions.claim(actor('oidc:alice'), incidentId)).toMatchObject({ ok: true });
    expect((await currentClaims(db.server, [incidentId])).get(incidentId)).toMatchObject({
      principal_id: 'oidc:alice',
      channel: 'telegram',
    });
  });

  it('不存在的事件', async () => {
    expect(await actions.claim(actor('oidc:alice'), 'c1a10000-0000-4000-8000-999999999999')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
