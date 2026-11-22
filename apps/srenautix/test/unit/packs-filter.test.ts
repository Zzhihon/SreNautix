import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/config/server.js';
import { evidenceCapabilities, PackRuntime } from '../../src/stage-a/packs.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const PACKS_DIR = resolve(REPO_ROOT, 'packs');
const CATALOG_PATH = resolve(REPO_ROOT, 'contract/gateway/v1/action-catalog.yaml');

const minimalConfig = (extra: Record<string, unknown> = {}) => ({
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

describe('packs.disabled 与 stage_a.generic_alert_condition 配置校验', () => {
  it('默认 packs.disabled 为空、stage_a.generic_alert_condition 为 true', () => {
    const c = parseServerConfig(minimalConfig());
    expect(c.packs.disabled).toEqual([]);
    expect(c.packs.only).toBeUndefined();
    expect(c.stage_a.generic_alert_condition).toBe(true);
  });

  it('允许单独配置 packs.disabled 或 packs.only，同时配置时拒绝启动', () => {
    const withDisabled = parseServerConfig(
      minimalConfig({
        packs: { dirs: ['/packs'], disabled: ['kafka', 'mysql', 'nacos'] },
        stage_a: { generic_alert_condition: false },
      }),
    );
    expect(withDisabled.packs.disabled).toEqual(['kafka', 'mysql', 'nacos']);
    expect(withDisabled.stage_a.generic_alert_condition).toBe(false);

    const withOnly = parseServerConfig(
      minimalConfig({
        packs: { dirs: ['/packs'], only: ['kubernetes', 'node'] },
      }),
    );
    expect(withOnly.packs.only).toEqual(['kubernetes', 'node']);

    expect(() =>
      parseServerConfig(
        minimalConfig({
          packs: { dirs: ['/packs'], only: ['kubernetes'], disabled: ['kafka'] },
        }),
      ),
    ).toThrow(/packs\.only 与 packs\.disabled 不能同时设置/);
  });
});

describe('PackRuntime.load 跳过 packs.disabled 中的内置包', () => {
  const CAPS = evidenceCapabilities(true);

  it('跳过未使用的中间件与 KPS 内置包时零失败、零 set.disabled（不触发 PackLoadFailed）', async () => {
    const disabled = ['kafka', 'mysql', 'nacos', 'rocketmq', 'flux', 'ingress-nginx', 'alerts-kps', 'kps-conditions'];
    const rt = await PackRuntime.load({
      dirs: [PACKS_DIR],
      only: null,
      disabled,
      lockFile: null,
      catalogPath: CATALOG_PATH,
      capabilities: CAPS,
    });

    expect(rt.failures).toEqual([]);
    expect(rt.set.disabled).toEqual([]);
    expect(rt.skippedDisabled).toEqual([...disabled].sort());

    const loadedNames = rt.set.packs.map((p) => p.name);
    for (const d of disabled) {
      expect(loadedNames).not.toContain(d);
    }
    for (const kept of [
      'kubernetes-core',
      'workload',
      'node',
      'postgres',
      'redis',
      'longhorn',
      'argocd',
      'cert-manager',
    ]) {
      expect(loadedNames).toContain(kept);
    }
    const statusNames = rt.statuses().map((s) => s.name);
    for (const d of disabled) {
      expect(statusNames).not.toContain(d);
    }
  }, 60_000);

  it('未知的 disabled 包名被忽略而不报错', async () => {
    const rt = await PackRuntime.load({
      dirs: [PACKS_DIR],
      only: null,
      disabled: ['kafka', 'nonexistent-pack-xyz'],
      lockFile: null,
      catalogPath: CATALOG_PATH,
      capabilities: CAPS,
    });
    expect(rt.failures).toEqual([]);
    expect(rt.skippedDisabled).toEqual(['kafka']);
  }, 60_000);

  it('同时传入 only 与 disabled 时抛出错误', async () => {
    await expect(
      PackRuntime.load({
        dirs: [PACKS_DIR],
        only: ['kubernetes'],
        disabled: ['kafka'],
        lockFile: null,
        catalogPath: CATALOG_PATH,
        capabilities: CAPS,
      }),
    ).rejects.toThrow(/packs\.only 与 packs\.disabled 不能同时设置/);
  });

  it('禁用被其他启用包依赖的基础包时，依赖方作为校验失败包隔离禁用而不崩溃', async () => {
    // alerts-kps 依赖 kps-conditions；单独禁用 kps-conditions 而保留 alerts-kps 时，
    // alerts-kps 因缺少跨包卡片引用进入 failures，其余无关包照常加载。
    const rt = await PackRuntime.load({
      dirs: [PACKS_DIR],
      only: null,
      disabled: ['kps-conditions'],
      lockFile: null,
      catalogPath: CATALOG_PATH,
      capabilities: CAPS,
    });
    expect(rt.skippedDisabled).toEqual(['kps-conditions']);
    expect(rt.failures.some((f) => f.name === 'alerts-kps')).toBe(true);
    expect(rt.set.packs.some((p) => p.name === 'kubernetes-core')).toBe(true);
  }, 60_000);
});
