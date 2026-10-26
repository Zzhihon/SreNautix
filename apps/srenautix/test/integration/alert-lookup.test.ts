import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AlertCatalog, DEFAULT_RCA_PARAMS } from '@srenautix/core';
import { DomUtils, parseDocument } from 'htmlparser2';
import { simpleParser, type ParsedMail } from 'mailparser';
import { Secret, TOTP } from 'otpauth';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { lookupAlert, type AlertLookupQuery } from '../../src/console-bff/routes-alerts.js';
import type { RoleBinding } from '../../src/identity/bindings.js';
import { hashPassword } from '../../src/identity/password.js';
import { SESSION_COOKIE } from '../../src/identity/sessions.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { fromAlertmanager } from '../../src/ingest/normalize.js';
import { IngestService } from '../../src/ingest/service.js';
import { ServerMetrics } from '../../src/metrics.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { freePort, startAlertmanager, startPrometheus, until, type Proc } from '../support/monitoring.js';

/**
 * 告警链接（ADR 0154）：真实 Prometheus（带 external label）→ 真实 Alertmanager → webhook 接入 server，同一个接收器
 * 用 docs/console/alertmanager-links.tmpl 渲染邮件发往真实 SMTP 服务；从邮件的纯文本与 HTML 正文取出链接，
 * 经 server 的 /v1/alerts/lookup 找到告警所属的事件。另一组用例在真实 PG 上经接入与事件引擎生成事件，
 * 覆盖合并、已恢复、尚未归入、读取范围、集群过滤与接入时丢弃的告警。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `alert-lookup-${process.pid}`);
const TEMPLATE = resolve(import.meta.dirname, '../../../../docs/console/alertmanager-links.tmpl');
const CONSOLE = 'https://srenautix.example.com';
const PUBLIC = 'https://srenautix.example.test';
const TOKENS = { ingest: 'ingest-token-lookup-0123456789abcdef', external: 'external-token-lookup-0123456789ab' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// 规则标签带 alertgroup（vmalert 自动加的分组标签），值里有 &、/、=、?、空格、非 ASCII 与像数字的字符串
const RULE_LABELS = {
  severity: 'critical',
  namespace: 'shop',
  pod: 'api-7d9f8-x2k4p',
  alertgroup: 'shop-rules',
  path: '/v1/orders?a=1&b=2',
  team: '支付 组',
  version: '1.0',
};
const RULES = `groups:
  - name: shop-rules
    rules:
      - alert: LookupCrashLooping
        expr: vector(1) > 0
        labels: ${JSON.stringify(RULE_LABELS)}
        annotations: {summary: "api 反复重启"}
`;
const EXTERNAL = { prometheus: 'monitoring/kps-prometheus' };

const file = (name: string, content: string) => {
  const p = join(ROOT, name);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

describe('Alertmanager 模板生成的链接', () => {
  let db: TestDb;
  let srv: ServerHandle;
  let smtp: SMTPServer;
  let am: Proc;
  let prom: Proc;
  let cookie = '';
  const mails: ParsedMail[] = [];

  const lookup = async (query: string, auth: { session?: boolean; token?: string } = { session: true }) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth.session) {
      headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    }
    if (auth.token) {
      headers.authorization = `Bearer ${auth.token}`;
    }
    const res = await fetch(`${srv.apiUrl}/v1/alerts/lookup?${query}`, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    db = await newTestDb();
    await migrateExpand(db.server, 'server', serverTracks);
    const smtpPort = await freePort();
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onData(stream, _session, done) {
        simpleParser(stream).then((m) => {
          mails.push(m);
          done();
        }, done);
      },
    });
    await new Promise<void>((res) => smtp.listen(smtpPort, '127.0.0.1', res));

    const totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
    const config = parseServerConfig({
      cluster_id: 'c1',
      // 只读接口，不需要审批签名：观察模式
      profile: 'observe',
      log_level: 'warn',
      public_url: PUBLIC,
      ingest: {
        sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', TOKENS.ingest) }],
        reconcile: { enabled: false },
      },
      packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: { source: 'off' },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({
            callers: [
              {
                id: 'pay-bot',
                kind: 'external',
                channel: 'api',
                actions: ['workload_scale'],
                namespaces: ['pay'],
                token_sha256: sha(TOKENS.external),
              },
            ],
          }),
        ),
      },
      identity: {
        local_admin: {
          username: 'admin',
          password_hash_file: file('admin.hash', await hashPassword('correct horse battery')),
          totp_secret_file: file('admin.totp', totp.secret.base32),
        },
        bindings_dir: resolve(
          file(
            'bindings/admin.yaml',
            stringify({
              bindings: [
                {
                  subject: { kind: 'group', name: 'srenautix:local-admin' },
                  role: 'admin',
                  scope: { clusters: ['*'], namespaces: ['*'] },
                },
              ],
            }),
          ),
          '..',
        ),
      },
      audit: {
        checkpoint_key_file: file(
          'checkpoint.pem',
          generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        ),
      },
    });
    srv = await buildServer({
      config,
      pg: db.serverConfig,
      noAuxListeners: true,
      apiListen: { host: '127.0.0.1', port: 0 },
      serve: 'api',
    });
    const login = await fetch(`${srv.apiUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery', totp: totp.generate() }),
    });
    expect(login.status).toBe(200);
    cookie = /__Host-srenautix_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';

    // 邮件正文只用 docs/console/alertmanager-links.tmpl 里的 srenautix.alert_url
    am = await startAlertmanager(`${srv.apiUrl}/v1/ingest/am`, TOKENS.ingest, {
      smarthost: `127.0.0.1:${smtpPort}`,
      templates: [TEMPLATE],
      text: '{{ range .Alerts }}{{ template "srenautix.alert_url" . }}\n{{ end }}',
      html: '<html><body>{{ range .Alerts }}<a href="{{ template "srenautix.alert_url" . }}">{{ .Labels.alertname }}</a>{{ end }}</body></html>',
    });
    prom = await startPrometheus(RULES, am.url, EXTERNAL);
  }, 120_000);

  afterAll(async () => {
    await prom?.stop();
    await am?.stop();
    await srv?.stop();
    await new Promise<void>((res) => (smtp ? smtp.close(() => res()) : res()));
    await db?.close();
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('纯文本与 HTML 正文的链接都打开告警所属的事件；alertgroup 与 external label 不影响查找', async () => {
    const mail = await until(
      'Alertmanager 发出邮件',
      async () => mails.find((m) => typeof m.text === 'string' && m.text.includes('/alerts?')),
      60_000,
      async () => `${prom.log()}\n${am.log()}`,
    );
    const textLink = (mail.text ?? '').trim();
    const doc = parseDocument(typeof mail.html === 'string' ? mail.html : '');
    const anchors = DomUtils.findAll((e) => e.name === 'a', doc.children);
    expect(anchors).toHaveLength(1);
    // htmlparser2 解码属性里的字符引用，得到浏览器点击时使用的地址
    const htmlLink = DomUtils.getAttributeValue(anchors[0]!, 'href');
    expect(htmlLink).toBe(textLink);
    const url = new URL(textLink);
    expect(`${url.origin}${url.pathname}`).toBe(`${CONSOLE}/alerts`);
    const params = [...url.searchParams];
    // 链接带着告警的全部标签：SortedPairs 把 alertname 放在最前，其余按名称排序
    expect(params).toEqual([
      ['l.alertname', 'LookupCrashLooping'],
      ...Object.entries({ ...RULE_LABELS, ...EXTERNAL })
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [`l.${k}`, v]),
    ]);

    const alertId = await until('告警归入事件', async () => {
      const r = await db.server.query<{ alert_id: string; incident_id: string }>(
        `SELECT a.alert_id, m.incident_id FROM server.alert_state a JOIN server.incident_members m USING (alert_id)
          WHERE a.alertname = 'LookupCrashLooping' AND m.left_version IS NULL`,
      );
      return r.rows[0] ?? null;
    });
    const r = await lookup(url.search.slice(1));
    expect(r.status).toBe(200);
    expect(responseErrors('/v1/alerts/lookup', 'get', 200, r.body)).toBeNull();
    // 身份标签不含 alertgroup 与 prometheus，标签值与规则里的原文相同
    expect(r.body.identity_labels).toEqual({
      alertname: 'LookupCrashLooping',
      severity: RULE_LABELS.severity,
      namespace: RULE_LABELS.namespace,
      pod: RULE_LABELS.pod,
      path: RULE_LABELS.path,
      team: RULE_LABELS.team,
      version: RULE_LABELS.version,
    });
    expect(r.body).toMatchObject({
      outcome: 'incident',
      excluded_labels: ['alertgroup', 'prometheus'],
      alert: { alert_id: alertId.alert_id, cluster_id: 'c1', status: 'firing' },
      incident: { incident_id: alertId.incident_id, state: 'firing' },
    });
    const stored = await db.server.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM server.alert_state WHERE alert_id = $1',
      [alertId.alert_id],
    );
    expect(r.body.fingerprint).toBe(stored.rows[0]!.fingerprint);

    // 只能读 pay 命名空间的外部调用方：告警与事件都在 shop，不给出任何内容
    const outside = await lookup(url.search.slice(1), { token: TOKENS.external });
    expect(outside.status).toBe(200);
    expect(outside.body).toMatchObject({ outcome: 'not_visible', alert: null, incident: null });
  });

  it('没有会话时 401；参数不合法时 400', async () => {
    expect((await lookup('l.alertname=X', {})).status).toBe(401);
    for (const q of [
      'l.namespace=shop',
      'l.alertname=X&l.alertname=Y',
      'l.alertname=X&state=firing',
      'l.alertname=X&cluster_id=Bad_Id',
    ]) {
      const r = await lookup(q);
      expect(r.status, q).toBe(400);
      expect(r.body.error, q).toBe('bad_request');
    }
  });
});

describe('查找告警所属事件的各种结果', () => {
  let db: TestDb;
  let ingest: IngestService;
  let engine: IncidentEngine;
  const metrics = new ServerMetrics('server', false);
  const OPTS = { selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' };
  const ALL = 'all' as const;
  const scope = (namespaces: string[]): RoleBinding[] => [
    {
      subject: { kind: 'user', name: 'u' },
      role: 'viewer',
      scope: { clusters: ['*'], namespaces, component_labels: {} },
    },
  ];

  /** 经接入写入一条告警（与 webhook 同一条解析与写入路径） */
  const fire = async (cluster: string, labels: Record<string, string>, startsAt: Date, endsAt?: Date) => {
    const raw = fromAlertmanager(
      {
        labels,
        annotations: {},
        startsAt: startsAt.toISOString(),
        endsAt: endsAt ? endsAt.toISOString() : '0001-01-01T00:00:00Z',
        status: endsAt ? 'resolved' : 'firing',
      } as Parameters<typeof fromAlertmanager>[0],
      'alertmanager',
      new Date(),
    );
    await ingest.write(cluster, 'am', 'alertmanager', [raw], { test: true });
  };
  const q = (labels: Record<string, string>, clusterId: string | null = null): AlertLookupQuery => ({
    labels,
    clusterId,
  });
  const incidentOf = async (alertname: string) =>
    (
      await db.server.query<{ incident_id: string }>(
        `SELECT m.incident_id FROM server.alert_state a JOIN server.incident_members m USING (alert_id)
          WHERE a.alertname = $1 AND m.left_version IS NULL ORDER BY a.starts_at DESC LIMIT 1`,
        [alertname],
      )
    ).rows[0]!.incident_id;

  beforeAll(async () => {
    db = await newTestDb();
    await migrateExpand(db.server, 'server', serverTracks);
    const topology = new TopologyStore(db.server);
    ingest = new IngestService(
      db.server,
      [],
      { clusterId: 'c1', ...OPTS },
      { catalog: new AlertCatalog([]), nodes: topology, ksm: null, ruleExpr: () => undefined, chronic: () => false },
      metrics,
      () => {
        throw new Error('测试中状态库一直可用');
      },
    );
    engine = new IncidentEngine({
      pool: db.server,
      topology,
      params: () => DEFAULT_RCA_PARAMS,
      changes: async () => [],
      probes: async () => [],
      stale: { markStale: async () => 0 },
      metrics,
      suppressedAlerts: async () => new Map<string, string>(),
    });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('合并过的事件打开吸收它的事件；已恢复的事件照常打开', async () => {
    const shop = { alertname: 'ShopDown', severity: 'critical', namespace: 'shop' };
    const pay = { alertname: 'PayDown', severity: 'critical', namespace: 'pay' };
    await fire('c1', shop, new Date(Date.now() - 120_000));
    await fire('c1', pay, new Date(Date.now() - 110_000));
    await engine.recompute('c1');
    const from = await incidentOf('ShopDown');
    const into = await incidentOf('PayDown');
    expect(from).not.toBe(into);
    expect(await lookupAlert(db.server, ALL, q(shop), OPTS)).toMatchObject({
      outcome: 'incident',
      incident: { incident_id: from, state: 'firing' },
    });

    // 合并按事件引擎的写法记录（persist）：被吸收的事件标为 merged 并指向吸收它的事件，别名表记下 from → into
    const label = (
      await db.server.query<{ label: string }>('SELECT label FROM server.incidents WHERE incident_id = $1', [from])
    ).rows[0]!.label;
    await db.server.query("UPDATE server.incidents SET state = 'merged', merged_into = $2 WHERE incident_id = $1", [
      from,
      into,
    ]);
    await db.server.query(
      `INSERT INTO server.incident_aliases (from_incident_id, from_label, cluster_id, into_incident_id, at_version)
       VALUES ($1, $2, 'c1', $3, 2)`,
      [from, label, into],
    );
    const merged = await lookupAlert(db.server, ALL, q({ ...shop, alertgroup: 'g', prometheus: 'm/p' }), OPTS);
    expect(merged).toMatchObject({ outcome: 'incident', incident: { incident_id: into } });
    expect(responseErrors('/v1/alerts/lookup', 'get', 200, merged)).toBeNull();

    // PayDown 恢复，下一轮重算后事件 resolved，链接照常打开它
    const started = (
      await db.server.query<{ starts_at: Date }>("SELECT starts_at FROM server.alert_state WHERE alertname = 'PayDown'")
    ).rows[0]!.starts_at;
    await fire('c1', pay, started, new Date());
    await engine.recompute('c1');
    const resolved = await lookupAlert(db.server, ALL, q(pay), OPTS);
    expect(resolved).toMatchObject({
      outcome: 'incident',
      alert: { status: 'resolved' },
      incident: { incident_id: into, state: 'resolved' },
    });
  });

  it('收到了还没有归入事件、读取范围之外、没有收到、接入时丢弃', async () => {
    const fresh = { alertname: 'JustArrived', severity: 'warning', namespace: 'shop' };
    await fire('c1', fresh, new Date(Date.now() - 5_000));
    const pending = await lookupAlert(db.server, ALL, q(fresh), OPTS);
    expect(pending).toMatchObject({ outcome: 'not_grouped', alert: { status: 'firing' }, incident: null });
    expect(responseErrors('/v1/alerts/lookup', 'get', 200, pending)).toBeNull();
    expect(await lookupAlert(db.server, scope(['pay']), q(fresh), OPTS)).toMatchObject({
      outcome: 'not_visible',
      alert: null,
    });
    await engine.recompute('c1');
    expect(await lookupAlert(db.server, scope(['shop']), q(fresh), OPTS)).toMatchObject({ outcome: 'incident' });
    expect(await lookupAlert(db.server, scope(['pay']), q(fresh), OPTS)).toMatchObject({
      outcome: 'not_visible',
      alert: null,
      incident: null,
    });

    expect(
      await lookupAlert(db.server, ALL, q({ alertname: 'NeverSent', namespace: 'shop', version: '1.0' }), OPTS),
    ).toMatchObject({ outcome: 'not_received', alert: null, incident: null });
    expect(
      await lookupAlert(db.server, ALL, q({ alertname: 'SelfAlert', srenautix_self: 'true' }), OPTS),
    ).toMatchObject({ outcome: 'self_alert' });
    const dropped: Array<Record<string, string>> = [
      { alertname: 'Watchdog' },
      { alertname: 'InfoInhibitor', severity: 'none' },
      { alertname: 'Quiet', severity: 'none' },
    ];
    for (const labels of dropped) {
      expect(await lookupAlert(db.server, ALL, q(labels), OPTS), labels.alertname).toMatchObject({
        outcome: 'ignored',
      });
    }
  });

  it('同一组标签出现在两个集群时取开始时间最晚的一条，cluster_id 限定集群', async () => {
    const labels = { alertname: 'TwinAlert', severity: 'warning', namespace: 'shop' };
    await fire('c1', labels, new Date(Date.now() - 300_000));
    await fire('c2', labels, new Date(Date.now() - 60_000));
    await engine.recompute('c1');
    await engine.recompute('c2');
    expect(await lookupAlert(db.server, ALL, q(labels), OPTS)).toMatchObject({ alert: { cluster_id: 'c2' } });
    expect(await lookupAlert(db.server, ALL, q(labels, 'c1'), OPTS)).toMatchObject({
      outcome: 'incident',
      alert: { cluster_id: 'c1' },
    });
  });
});
