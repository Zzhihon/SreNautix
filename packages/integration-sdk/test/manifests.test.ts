import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  availableCapabilities,
  loadIntegrationManifest,
  loadIntegrationManifests,
  ManifestError,
} from '../src/manifest.js';
import { backendsDir } from '../src/testing/backends.js';

const ROOT = resolve(import.meta.dirname, '../../../integrations');

// DESIGN §10.5 的首发核心级集合；内置 informer 属于 reader，不经过集成契约
const CORE = [
  'alertmanager',
  'generic-webhook',
  'prometheus-api',
  'loki',
  'tempo',
  'kubernetes',
  'argocd',
  'git',
  'telegram',
  'feishu',
  'console',
  'openai-compatible-responses',
  'openai-compatible-chat',
  'deepseek',
  'qwen-vllm',
  'oidc',
  'local-admin',
];

const CANDIDATES = [
  'grafana-alerting',
  'nightingale',
  'mimir',
  'thanos',
  'victorialogs',
  'elasticsearch',
  'skywalking',
  'jaeger',
  'flux',
  'gitlab',
  'jenkins',
  'dingtalk',
  'wecom',
  'slack',
  'email',
  'dex',
];

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

function writeManifest(id: string, body: string): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'manifest-'));
  scratch.push(root);
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'integration.yaml'), body);
  return dir;
}

const HEAD = `api_version: srenautix.io/integration/v1
owner: test
required_scopes: []
`;

describe('integrations/ 下的清单', () => {
  const all = loadIntegrationManifests(ROOT);
  const byId = new Map(all.map((l) => [l.manifest.id, l]));

  it('首发核心级全部存在且为 core，官方候选全部为 official_candidate', () => {
    for (const id of CORE) {
      expect(byId.get(id)?.manifest.tier, id).toBe('core');
    }
    for (const id of CANDIDATES) {
      expect(byId.get(id)?.manifest.tier, id).toBe('official_candidate');
    }
    expect(all.length).toBe(CORE.length + CANDIDATES.length);
  });

  it('录制夹具都是可解析的 JSON', () => {
    for (const l of all) {
      for (const f of l.fixtures) {
        expect(f.endsWith('.json'), `${l.manifest.id}/${f}`).toBe(true);
        expect(
          () => JSON.parse(readFileSync(join(l.dir, 'fixtures', f), 'utf8')),
          `${l.manifest.id}/${f}`,
        ).not.toThrow();
      }
    }
  });

  it('核心级审批渠道带有回调夹具，飞书带有签名测试向量', () => {
    for (const id of ['telegram', 'feishu']) {
      expect(
        byId.get(id)!.fixtures.some((f) => /callback|card-action/.test(f)),
        id,
      ).toBe(true);
    }
    expect(byId.get('feishu')!.fixtures).toContain('signature-vectors.json');
  });
});

describe('清单规则', () => {
  it('approve 方向不能是社区级', () => {
    const dir = writeManifest(
      'x-approve',
      `${HEAD}id: x-approve
category: approve
direction: approve
tier: community
contract: approve/v1
capabilities: [{ name: notify.send, stability: beta }]
tested_versions: [{ backend: x, versions: ['1'], verification: recorded_fixtures }]
config_schema: { type: object }
`,
    );
    expect(() => loadIntegrationManifest(dir)).toThrow(/只能是 core 或 official/);
  });

  it('official 没有部署报告时被拒绝', () => {
    const dir = writeManifest(
      'x-official',
      `${HEAD}id: x-official
category: metrics
direction: read
tier: official
contract: metrics/v1
capabilities: [{ name: metrics.query, stability: beta }]
tested_versions: [{ backend: x, versions: ['1'], verification: testcontainers }]
config_schema: { type: object }
`,
    );
    expect(() => loadIntegrationManifest(dir)).toThrow(/部署报告/);
  });

  it('密钥字段必须是文件引用', () => {
    const dir = writeManifest(
      'x-secret',
      `${HEAD}id: x-secret
category: metrics
direction: read
tier: community
contract: metrics/v1
capabilities: [{ name: metrics.query, stability: beta }]
tested_versions: [{ backend: x, versions: ['1'], verification: testcontainers }]
config_schema: { type: object, properties: { api_token: { type: string } } }
`,
    );
    expect(() => loadIntegrationManifest(dir)).toThrow(ManifestError);
  });

  it('日志集成必须实现 logs.match', () => {
    const dir = writeManifest(
      'x-logs',
      `${HEAD}id: x-logs
category: logs
direction: read
tier: community
contract: logs/v1
capabilities: [{ name: logs.query, stability: beta }]
tested_versions: [{ backend: x, versions: ['1'], verification: testcontainers }]
config_schema: { type: object }
`,
    );
    expect(() => loadIntegrationManifest(dir)).toThrow(/logs\.match/);
  });

  it('能力名必须属于实现的契约', () => {
    const dir = writeManifest(
      'x-cap',
      `${HEAD}id: x-cap
category: metrics
direction: read
tier: community
contract: metrics/v1
capabilities: [{ name: logs.match, stability: beta }]
tested_versions: [{ backend: x, versions: ['1'], verification: testcontainers }]
config_schema: { type: object }
`,
    );
    expect(() => loadIntegrationManifest(dir)).toThrow(/不属于契约/);
  });

  it('core 只有录制夹具时被拒绝', () => {
    const dir = writeManifest(
      'x-core',
      `${HEAD}id: x-core
category: metrics
direction: read
tier: core
contract: metrics/v1
capabilities: [{ name: metrics.query, stability: stable }]
tested_versions: [{ backend: x, versions: ['1'], verification: recorded_fixtures }]
config_schema: { type: object }
`,
    );
    expect(() => loadIntegrationManifest(dir)).toThrow(/core 需要/);
  });

  it('只有声明过且 verify() 通过的能力可用', () => {
    const m = loadIntegrationManifest(join(ROOT, 'prometheus-api')).manifest;
    const r = availableCapabilities(m, {
      'metrics.query': { ok: true, detail: '' },
      'metrics.query_range': { ok: true, detail: '' },
      'metrics.series': { ok: false, detail: '403' },
      'metrics.exemplars': { ok: true, detail: '' },
    });
    expect(r.available).toEqual(['metrics.query', 'metrics.query_range']);
    expect(r.unavailable.map((u) => u.capability).sort()).toEqual(
      ['metrics.exemplars', 'metrics.label_profile', 'metrics.rules', 'metrics.series'].sort(),
    );
  });
});
