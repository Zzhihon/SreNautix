import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { openapiValidator } from '../../src/api/openapi-schemas.js';
import {
  buildOntologyGlossary,
  etagMatches,
  inferComponentLayer,
  registerOntologyRoutes,
} from '../../src/console-bff/routes-ontology.js';
import type { Auth } from '../../src/identity/auth.js';
import type { PackRuntime } from '../../src/stage-a/packs.js';

function fakePacks(): PackRuntime {
  return {
    set: {
      lockDigest: 'sha256:abcdef1234567890',
      packs: [
        {
          name: 'cchp',
          content: {
            components: {
              component_types: [
                {
                  id: 'cchp.archive-exporter',
                  description: {
                    'zh-CN': '异步归档导出工作负载，消费 NATS 并写入衍生分析平台',
                    en: 'Async archive exporter consuming NATS and writing to derived analytics sinks',
                  },
                  layer: 'L1',
                  match: { kind: 'Deployment', namespaces: ['cchp-prod'], name_pattern: '^archive-exporter$' },
                  chains: ['archive'],
                },
                {
                  id: 'cchp.provider',
                  external: true,
                  match: { kind: 'provider' },
                  chains: ['provider'],
                },
                {
                  id: 'cchp.postgres',
                  match: { kind: 'Cluster', api_group: 'postgresql.cnpg.io', namespaces: ['cchp-data'] },
                  chains: ['db-failover'],
                },
                {
                  id: 'cchp.edge-route',
                  match: { kind: 'HTTPRoute', namespaces: ['cchp-prod'] },
                },
                {
                  id: 'cchp.node',
                  match: { kind: 'Node' },
                },
                {
                  id: 'weird.constructor',
                  match: { kind: 'Pod', labels: { app: 'ctor' } },
                },
              ],
            },
          },
        },
      ],
      cards: new Map([
        [
          'cchp/storage/archive-budget',
          {
            key: 'cchp/storage/archive-budget',
            pack: 'cchp',
            chain: 'storage',
            def: {
              id: 'archive-budget',
              title: { 'zh-CN': '归档本地磁盘有效预算', en: 'Archive effective local disk budget' },
              description: {
                'zh-CN': '检查 volume_reserve_bytes 扣除后的有效本地归档预算是否低于阈值',
                en: 'Checks whether effective local archive budget after volume_reserve_bytes drops below threshold',
              },
              display: { unit: 'bytes' },
              category: 'storage',
            },
          },
        ],
        [
          'postgres/memory/working-set',
          {
            key: 'postgres/memory/working-set',
            pack: 'postgres',
            chain: 'memory',
            def: {
              id: 'working-set',
              title: { 'zh-CN': '主库常驻内存', en: 'Primary memory working set' },
              note: { 'zh-CN': '接近 cgroup limit 时可能触发 OOMKilled', en: 'May trigger OOMKilled near limit' },
              display: { unit: 'percent' },
              category: 'memory',
            },
          },
        ],
      ]),
    },
  } as unknown as PackRuntime;
}

describe('GET /v1/ontology/glossary（本体与指标悬停词汇表）', () => {
  const validate = openapiValidator('openapi.yaml', 'OntologyGlossary');

  it('构建词汇表时提取显式 description/layer、透出 match 规则、防止原型链键污染，且完全符合 OpenAPI schema', () => {
    const zh = buildOntologyGlossary(fakePacks(), 'zh-CN');
    expect(validate(zh)).toBe(true);
    expect(zh.pack_lock).toBe('sha256:abcdef1234567890');
    expect(zh.component_types['cchp.archive-exporter']).toEqual({
      title: '归档导出器（archive-exporter）',
      description: '异步归档导出工作负载，消费 NATS 并写入衍生分析平台',
      layer: 'L1',
      external: false,
      hub: false,
      match: { kind: 'Deployment', namespaces: ['cchp-prod'], name_pattern: '^archive-exporter$' },
    });
    expect(zh.component_types['cchp.provider']?.layer).toBe('external');
    expect(zh.component_types['cchp.provider']?.external).toBe(true);
    expect(zh.component_types['cchp.postgres']?.layer).toBe('L2');
    expect(zh.component_types['cchp.postgres']?.match).toEqual({
      kind: 'Cluster',
      api_group: 'postgresql.cnpg.io',
      namespaces: ['cchp-data'],
    });
    expect(zh.component_types['cchp.edge-route']?.layer).toBe('L0');
    expect(zh.component_types['cchp.node']?.layer).toBe('L3');
    // constructor 不会误命中 Object.prototype.constructor，且 labels 约束标为 has_labels: true
    expect(zh.component_types['weird.constructor']?.title).toBe('weird.constructor');
    expect(zh.component_types['weird.constructor']?.match).toEqual({ kind: 'Pod', has_labels: true });
    expect(zh.cards['cchp/storage/archive-budget']).toEqual({
      title: '归档本地磁盘有效预算',
      description: '检查 volume_reserve_bytes 扣除后的有效本地归档预算是否低于阈值',
      unit: 'bytes',
      category: 'storage',
    });
    expect(zh.cards['postgres/memory/working-set']?.description).toBe('接近 cgroup limit 时可能触发 OOMKilled');
    expect(zh.concepts.volume_reserve_bytes?.description).toContain('effective_budget');
    expect(zh.concepts['archive-exporter']?.description).toContain('NATS');

    const en = buildOntologyGlossary(fakePacks(), 'en');
    expect(validate(en)).toBe(true);
    expect(en.component_types['cchp.archive-exporter']?.description).toContain('Async archive exporter');
    expect(en.concepts.volume_reserve_bytes?.description).toContain('volume_reserve_bytes');
  });

  it('路由使用 auth.user(req, "read") 拒绝外部服务调用方，返回内容哈希 ETag 并支持弱前缀与多值 If-None-Match', async () => {
    const app = Fastify();
    const user = vi.fn().mockResolvedValue({ kind: 'user', subject: { id: 'alice', groups: [] } });
    const auth = { user } as unknown as Auth;
    registerOntologyRoutes(app, { auth, packs: fakePacks() });

    const r1 = await app.inject({ method: 'GET', url: '/v1/ontology/glossary?lang=zh-CN' });
    expect(r1.statusCode).toBe(200);
    expect(user).toHaveBeenCalledWith(expect.anything(), 'read');
    expect(r1.headers['cache-control']).toBe('private, max-age=60');
    const etag = r1.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(validate(r1.json())).toBe(true);

    // 精确 ETag、W/ 弱前缀、逗号分隔多值均返回 304
    const r2 = await app.inject({
      method: 'GET',
      url: '/v1/ontology/glossary?lang=zh-CN',
      headers: { 'if-none-match': etag },
    });
    expect(r2.statusCode).toBe(304);

    const r2Weak = await app.inject({
      method: 'GET',
      url: '/v1/ontology/glossary?lang=zh-CN',
      headers: { 'if-none-match': `"stale", W/${etag}` },
    });
    expect(r2Weak.statusCode).toBe(304);

    const r3 = await app.inject({
      method: 'GET',
      url: '/v1/ontology/glossary?lang=en',
      headers: { 'if-none-match': etag },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.headers.etag).not.toBe(etag);
    expect(r3.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(validate(r3.json())).toBe(true);
    await app.close();
  });

  it('etagMatches 支持通配符、弱比较与逗号分隔列表', () => {
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc", "y"', '"abc"')).toBe(true);
    expect(etagMatches('"other"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });

  it('inferComponentLayer 对外部备份 host 归入 L2、普通 edge host 归入 L0', () => {
    expect(
      inferComponentLayer({
        id: 'cchp.backup-store-host',
        match: { kind: 'host', name_pattern: '^https://s3\\.ccx/' },
      }),
    ).toBe('L2');
    expect(inferComponentLayer({ id: 'cchp.edge-host', match: { kind: 'host' } })).toBe('L0');
  });
});
