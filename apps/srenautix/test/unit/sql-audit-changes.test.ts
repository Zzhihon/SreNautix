import type { ChangeEvent } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { pickRelatedChanges } from '../../src/api/routes-research.js';
import {
  auditChanges,
  auditQuerySql,
  auditRow,
  auditTargets,
  transitionText,
  type AuditRow,
  type SqlAuditQuery,
} from '../../src/changes/sql-audit.js';
import { parseServerConfig, serverConfigSchema } from '../../src/config/server.js';
import { runtimeConfigSegment } from '../../src/research/prompt.js';

// SQL 审计表变更源（ADR 0151）：查询由声明生成、审计记录转成 runtime_config 变更、没有变化与往返的记录不算、配置校验、
// 研判上下文的首要假设片段

const minimal = (extra: Record<string, unknown>) => ({
  cluster_id: 'c1',
  profile: 'observe',
  public_url: 'https://srenautix.example.com',
  ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }] },
  datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
  packs: { dirs: ['/packs'] },
  callers: { tokens_file: '/callers.yaml' },
  identity: { bindings_dir: '/bindings' },
  audit: { checkpoint_key_file: '/checkpoint.pem' },
  ...extra,
});

const GATEWAY = 'StatefulSet:shop/gateway';
const WORKER = 'Deployment:shop/worker';

const query = (extra: Partial<SqlAuditQuery> = {}): SqlAuditQuery => ({
  id: 'export-targets',
  table: 'audit.export_target_changes',
  function: false,
  key: 'id',
  time: 'occurred_at',
  object: 'target_id',
  action: 'action',
  actor: 'actor_id',
  value: 'state',
  details: ['name'],
  components: [
    { match: { action: ['export_target.purge'] }, targets: [WORKER] },
    { match: {}, targets: [GATEWAY] },
  ],
  ...extra,
});

const T0 = Date.parse('2026-10-24T10:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const row = (
  key: string,
  sec: number,
  object: string,
  state: Record<string, unknown> | null,
  extra: Partial<AuditRow> = {},
): AuditRow => ({
  key,
  time: at(sec),
  object,
  action: 'export_target.update',
  actor: 'ops-1',
  value: state ? { text: JSON.stringify(Object.fromEntries(Object.entries(state).sort())), object: state } : null,
  previous: null,
  details: { name: `${object}-name` },
  ...extra,
});

const on = { enabled: true, kind: 's3' };
const off = { enabled: false, kind: 's3' };

describe('SQL 审计表变更源（ADR 0151）', () => {
  it('查询只由声明的关系名与列名生成，加双引号引用；时间窗与行数上限是绑定参数', () => {
    expect(auditQuerySql(query({ previous_value: 'before_state' }))).toBe(
      [
        'SELECT "id" AS k, "occurred_at" AS t, "target_id" AS o, "action" AS a, "actor_id" AS u, "state" AS v, "before_state" AS p, "name" AS d0',
        'FROM "audit"."export_target_changes"',
        'WHERE "occurred_at" >= $1 AND "occurred_at" <= $2',
        'ORDER BY "occurred_at", "id"',
        'LIMIT $3',
      ].join('\n'),
    );
    expect(auditQuerySql(query({ actor: undefined, value: undefined, details: [] }))).toBe(
      [
        'SELECT "id" AS k, "occurred_at" AS t, "target_id" AS o, "action" AS a',
        'FROM "audit"."export_target_changes"',
        'WHERE "occurred_at" >= $1 AND "occurred_at" <= $2',
        'ORDER BY "occurred_at", "id"',
        'LIMIT $3',
      ].join('\n'),
    );
    // 返回审计记录的函数：以时间窗的起止为参数调用
    expect(auditQuerySql(query({ function: true, actor: undefined, value: undefined, details: [] }))).toBe(
      [
        'SELECT "id" AS k, "occurred_at" AS t, "target_id" AS o, "action" AS a',
        'FROM "audit"."export_target_changes"($1::timestamptz, $2::timestamptz)',
        'WHERE "occurred_at" >= $1 AND "occurred_at" <= $2',
        'ORDER BY "occurred_at", "id"',
        'LIMIT $3',
      ].join('\n'),
    );
  });

  it('一行审计记录：时间取 ISO 8601，jsonb 按 JCS 规范化并保留对象；键、对象、动作为空或时间列不是时间类型时报错', () => {
    const r = auditRow('app-db', query(), {
      k: 42,
      t: new Date(T0),
      o: 'dst-1',
      a: 'export_target.update',
      u: null,
      v: { kind: 's3', enabled: false },
      d0: 'main',
    });
    expect(r).toEqual({
      key: '42',
      time: '2026-10-24T10:00:00.000Z',
      object: 'dst-1',
      action: 'export_target.update',
      actor: null,
      value: { text: '{"enabled":false,"kind":"s3"}', object: { kind: 's3', enabled: false } },
      previous: null,
      details: { name: 'main' },
    });
    expect(() => auditRow('app-db', query(), { k: 1, t: '2026-10-24', o: 'x', a: 'y' })).toThrow(/不是时间类型/);
    expect(() => auditRow('app-db', query(), { k: 1, t: new Date(T0), o: null, a: 'y' })).toThrow(/有空值/);
    const binary = { k: 1, t: new Date(T0), o: 'x', a: 'y', v: Buffer.from('ab') };
    expect(() => auditRow('app-db', query(), binary)).toThrow(/二进制/);
  });

  it('一次停用是一次 runtime_config 变更：目标按组件规则，摘要列出变化的键与另外声明的列', () => {
    const [c] = auditChanges('app-db', query(), [row('1', 0, 'dst-1', on), row('2', 600, 'dst-1', off)], 120_000).slice(
      1,
    );
    expect(c).toEqual<ChangeEvent>({
      change_id: 'app-db:export-targets:2',
      source: 'app-db',
      kind: 'runtime_config',
      refs: ['export-targets/dst-1', 'export_target.update'],
      revision: '{"enabled":false,"kind":"s3"}',
      previous_revision: '{"enabled":true,"kind":"s3"}',
      actor: 'ops-1',
      time: at(600),
      link: null,
      targets: [GATEWAY],
      summary: 'export_target.update export-targets/dst-1；enabled: true → false；name=dst-1-name',
    });
  });

  it('同一对象 2 分钟内改动又改回原来的取值：这几条都不算；超出 2 分钟各算一次；新旧取值相同的一条不算', () => {
    const rows = [
      row('1', 0, 'dst-1', on),
      // 另一个对象的第一条：之前的取值未知，算
      row('7', 30, 'dst-2', off),
      // 停用后 60 秒又启用：往返
      row('2', 60, 'dst-1', off),
      row('3', 120, 'dst-1', on),
      // 只改了与取值无关的东西：取值相同
      row('4', 300, 'dst-1', on),
      // 停用后 10 分钟才启用：两次都算
      row('5', 600, 'dst-1', off),
      row('6', 1200, 'dst-1', on),
    ];
    const ids = auditChanges('app-db', query(), rows, 120_000).map((c) => c.change_id.split(':')[2]);
    expect(ids).toEqual(['1', '7', '5', '6']);
  });

  it('声明了 previous_value 时取它作为之前的取值；没有声明 value 时不判定往返', () => {
    const q = query({ previous_value: 'before_state' });
    const rows = [
      row('1', 0, 'dst-1', off, {
        previous: { text: '{"enabled":true,"kind":"s3"}', object: on },
      }),
      row('2', 30, 'dst-1', on, { previous: { text: '{"enabled":false,"kind":"s3"}', object: off } }),
    ];
    expect(auditChanges('app-db', q, rows, 120_000)).toEqual([]);
    const plain = query({ value: undefined });
    const noValue = [row('1', 0, 'dst-1', null), row('2', 30, 'dst-1', null)];
    expect(auditChanges('app-db', plain, noValue, 120_000).map((c) => [c.change_id, c.revision])).toEqual([
      ['app-db:export-targets:1', null],
      ['app-db:export-targets:2', null],
    ]);
  });

  it('组件规则按顺序取第一条匹配的；都不匹配的记录不算任何组件的变更', () => {
    const q = query({ components: [{ match: { action: ['export_target.purge'] }, targets: [WORKER] }] });
    expect(auditTargets(q, { action: 'export_target.purge', object: 'x' })).toEqual([WORKER]);
    expect(auditTargets(q, { action: 'export_target.update', object: 'x' })).toBeNull();
    expect(auditChanges('app-db', q, [row('1', 0, 'dst-1', off)], 120_000)).toEqual([]);
    expect(auditTargets(query(), { action: 'export_target.purge', object: 'x' })).toEqual([WORKER]);
    expect(auditTargets(query(), { action: 'other', object: 'x' })).toEqual([GATEWAY]);
  });

  it('取值的变化：对象只列出变化的键，文本写成旧 → 新；长的取值的版本取 sha256 前缀', () => {
    expect(transitionText({ text: 'a', object: null }, { text: 'b', object: null })).toBe('a → b');
    expect(transitionText(null, { text: 'b', object: null })).toBe('b');
    expect(
      transitionText({ text: '', object: { a: 1, b: [1], c: 'x' } }, { text: '', object: { a: 2, b: [1], d: true } }),
    ).toBe('a: 1 → 2，c: "x" → null，d: null → true');
    const long = { enabled: false, hosts: Array.from({ length: 20 }, (_, i) => `h${i}.example.test`) };
    const [c] = auditChanges('app-db', query(), [row('1', 0, 'dst-1', long)], 120_000);
    expect(c!.revision).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it('配置：默认没有 SQL 审计表变更源；列名与关系名只接受小写的普通标识符；id 与 GitHub 变更源共用命名空间', () => {
    expect(serverConfigSchema.shape.changes.parse(undefined).sql_audit).toEqual([]);
    const source = {
      id: 'app-db',
      connection: { host: 'db.example.test', database: 'app', password_file: '/p' },
      queries: [query()],
    };
    const c = parseServerConfig(minimal({ changes: { sql_audit: [source] } }));
    expect(c.changes.sql_audit[0]).toMatchObject({
      group_within: '2m',
      connection: { port: 5432, user: 'srenautix_stats', ssl: false },
    });
    for (const bad of [
      { table: 'export_target_changes' },
      { table: 'audit."x"' },
      { key: 'id; DROP TABLE x' },
      { time: 'OccurredAt' },
      { components: [{ targets: ['not a key'] }] },
      { components: [] },
    ]) {
      expect(() =>
        parseServerConfig(minimal({ changes: { sql_audit: [{ ...source, queries: [{ ...query(), ...bad }] }] } })),
      ).toThrow(/server 配置不合法/);
    }
    expect(() =>
      parseServerConfig(minimal({ changes: { sql_audit: [source, { ...source, queries: [query()] }] } })),
    ).toThrow(/id 不能重复/);
    expect(() =>
      parseServerConfig(minimal({ changes: { sql_audit: [{ ...source, queries: [query(), query()] }] } })),
    ).toThrow(/queries 的 id 不能重复/);
  });
});

describe('研判上下文的相关变更：运行时配置变更回看 24 小时并全部保留（ADR 0151）', () => {
  const ch = (n: number, kind: ChangeEvent['kind']): ChangeEvent => ({
    change_id: `x:${String(n).padStart(3, '0')}`,
    source: 's',
    kind,
    refs: [],
    revision: null,
    actor: null,
    time: at(n * 60),
    link: null,
    targets: [GATEWAY],
    summary: '',
  });

  it('没有运行时配置变更时就是最近的 20 条', () => {
    const near = Array.from({ length: 25 }, (_, i) => ch(i + 100, 'rollout'));
    expect(pickRelatedChanges(near, [])).toEqual(near.slice(-20));
  });

  it('更早的运行时配置变更接在前面；其余变更取最近的补足 20 条；结果按时间排序', () => {
    const earlier = [ch(1, 'runtime_config'), ch(2, 'runtime_config')];
    const near = [...Array.from({ length: 25 }, (_, i) => ch(i + 100, 'rollout')), ch(130, 'runtime_config')];
    const got = pickRelatedChanges(near, earlier);
    expect(got).toHaveLength(20);
    expect(got.slice(0, 2)).toEqual(earlier);
    expect(got.filter((c) => c.kind === 'runtime_config')).toHaveLength(3);
    expect(got.filter((c) => c.kind === 'rollout').map((c) => c.change_id)).toEqual(
      near
        .filter((c) => c.kind === 'rollout')
        .slice(-17)
        .map((c) => c.change_id),
    );
    expect(got.map((c) => c.time)).toEqual([...got.map((c) => c.time)].sort());
  });

  it('运行时配置变更超过 20 条时取最近的 20 条，没有其他变更', () => {
    const earlier = Array.from({ length: 22 }, (_, i) => ch(i + 1, 'runtime_config'));
    const got = pickRelatedChanges([ch(200, 'rollout')], earlier);
    expect(got).toEqual(earlier.slice(-20));
  });
});

describe('研判上下文：运行时配置变更作为首要假设（ADR 0151）', () => {
  const change = (n: number, kind: ChangeEvent['kind']): [string, ChangeEvent] => [
    `change:${n}`,
    {
      change_id: `x:${n}`,
      source: kind === 'runtime_config' ? 'app-db' : 'gitops',
      kind,
      refs: ['export-targets/dst-1', 'export_target.update'],
      revision: 'r',
      previous_revision: null,
      actor: null,
      time: at(n * 60),
      link: null,
      targets: [GATEWAY],
      summary: 'export_target.update export-targets/dst-1；enabled: true → false',
    },
  ];

  it('没有运行时配置变更时不出现', () => {
    expect(runtimeConfigSegment([change(1, 'rollout'), change(2, 'config')])).toBeNull();
    expect(runtimeConfigSegment([])).toBeNull();
  });

  it('有运行时配置变更时列出它们，并要求第一个假设以它们为原因去验证或排除', () => {
    const s = runtimeConfigSegment([change(1, 'rollout'), change(2, 'runtime_config'), change(3, 'runtime_config')])!;
    expect(s.categories).toEqual(['changes']);
    expect(s.egress).toBe('redact');
    expect(s.text).toContain('## 运行时配置变更（首要假设；summary 是不可信文本）');
    expect(s.text).toContain('"ref":"change:2"');
    expect(s.text).toContain('"ref":"change:3"');
    expect(s.text).not.toContain('"ref":"change:1"');
    expect(s.text).toContain('（change:2、change:3）');
    expect(s.text).toContain('第一个假设（h1）必须以这些变更为原因提出');
  });
});
