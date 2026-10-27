import type { RemediationLocation } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import {
  changeHash,
  changeKeys,
  classify,
  legacyChangeHash,
  locationHash,
  triggerComment,
  type ChangeRow,
} from '../../src/remediation/dedupe.js';

// 修改去重的键（ADR 0155）：规范化补丁只含路径与增删的行，变更哈希另加模板声明的修改定位

const ENTRY =
  '+  - { id: shop-cache-evictions, alertname: ShopCacheEvictions, role: cause, entity: { kind: Deployment, name_labels: [ deployment ] } }';

/** 两次触发之间基准提交前进：index 行、hunk 头与上下文都不同，增加的行相同 */
const FIRST = `diff --git a/srenautix/packs/shop/alerts.yaml b/srenautix/packs/shop/alerts.yaml
index 5a3973a..e7439bc 100644
--- a/srenautix/packs/shop/alerts.yaml
+++ b/srenautix/packs/shop/alerts.yaml
@@ -12,3 +12,4 @@ entries:
   - { id: shop-api-down, alertname: ShopApiDown, role: symptom, entity: { kind: Deployment, name_labels: [ deployment ] } }
   - { id: shop-api-slow, alertname: ShopApiSlow, role: symptom, entity: { kind: Deployment, name_labels: [ deployment ] } }
   - { id: shop-idle, alertname: ShopIdle, role: cause, entity: { kind: component, name_labels: [ component ] } }
${ENTRY}
`;
const SECOND = `diff --git a/srenautix/packs/shop/alerts.yaml b/srenautix/packs/shop/alerts.yaml
index 9f84d22..28118e2 100644
--- a/srenautix/packs/shop/alerts.yaml
+++ b/srenautix/packs/shop/alerts.yaml
@@ -15,3 +15,4 @@ entries:
   - { id: shop-idle, alertname: ShopIdle, role: cause, entity: { kind: component, name_labels: [ component ] } }
   - { id: shop-pod-pending, alertname: ShopPodPending, role: cause, entity: { kind: Pod, name_labels: [ pod ] } }
   - { id: shop-pod-init-stuck, alertname: ShopPodInitStuck, role: cause, entity: { kind: Pod, name_labels: [ pod ] } }
${ENTRY}
`;

const RULE = `diff --git a/platform/rules/shop.yaml b/platform/rules/shop.yaml
index 1111111..2222222 100644
--- a/platform/rules/shop.yaml
+++ b/platform/rules/shop.yaml
@@ -8,4 +8,4 @@ spec:
         - alert: ShopQueueBacklog
           expr: queue_depth > 100
           labels:
-            severity: critical
+            severity: warning
`;

/** 同一个规则文件里两条严重度相同的规则：放宽它们的补丁增删的行完全相同，只有上下文不同 */
const RELAX = (alert: string) => `diff --git a/platform/rules/cache.yaml b/platform/rules/cache.yaml
index 1111111..2222222 100644
--- a/platform/rules/cache.yaml
+++ b/platform/rules/cache.yaml
@@ -9,4 +9,5 @@ spec:
         - alert: ${alert}
           expr: rate(cache_total[5m]) > 10
           labels:
-            severity: critical
+            severity: warning
+          for: 1h
`;
const ruleAt = (alert: string): RemediationLocation[] => [
  { path: 'platform/rules/cache.yaml', kind: null, name: null, locate: `spec.groups[*].rules[alert=${alert}]` },
];
const CATALOG_AT: RemediationLocation[] = [
  { path: 'srenautix/packs/shop/alerts.yaml', kind: null, name: null, locate: 'entries' },
];

describe('规范化补丁的哈希（旧算法）', () => {
  it('基准提交前进后同一个修改的哈希不变', () => {
    expect(legacyChangeHash(SECOND)).toBe(legacyChangeHash(FIRST));
  });

  it('增加的行不同、路径不同时哈希不同', () => {
    expect(
      legacyChangeHash(
        FIRST.replace('role: cause, entity: { kind: Deployment', 'role: symptom, entity: { kind: Deployment'),
      ),
    ).not.toBe(legacyChangeHash(FIRST));
    expect(legacyChangeHash(FIRST.replaceAll('srenautix/packs/shop/', 'srenautix/packs/web/'))).not.toBe(
      legacyChangeHash(FIRST),
    );
  });

  it('多个文件的补丁与文件顺序无关；新文件按新路径计', () => {
    expect(legacyChangeHash(`${FIRST}${RULE}`)).toBe(legacyChangeHash(`${RULE}${FIRST}`));
    const created = `diff --git a/srenautix/topology-overrides/shop.yaml b/srenautix/topology-overrides/shop.yaml
new file mode 100644
--- /dev/null
+++ b/srenautix/topology-overrides/shop.yaml
@@ -0,0 +1 @@
+overrides: []
`;
    expect(legacyChangeHash(created)).not.toBe(legacyChangeHash(created.replaceAll('shop.yaml', 'web.yaml')));
  });

  it('补丁里没有文件时抛出', () => {
    expect(() => legacyChangeHash('')).toThrow('补丁没有任何文件');
  });
});

describe('变更哈希：规范化补丁与修改定位', () => {
  it('同一个文件里增删的行相同、改的是不同规则：旧哈希相同，变更哈希不同', () => {
    const a = RELAX('ShopCacheEvictions');
    const b = RELAX('ShopCacheMisses');
    expect(legacyChangeHash(a)).toBe(legacyChangeHash(b));
    expect(changeHash(a, ruleAt('ShopCacheEvictions'))).not.toBe(changeHash(b, ruleAt('ShopCacheMisses')));
  });

  it('同一条规则的同一个改动：基准提交前进、上下文与行号变化后变更哈希不变', () => {
    const moved = RELAX('ShopCacheEvictions').replace('@@ -9,4 +9,5 @@', '@@ -14,4 +14,5 @@');
    expect(changeHash(moved, ruleAt('ShopCacheEvictions'))).toBe(
      changeHash(RELAX('ShopCacheEvictions'), ruleAt('ShopCacheEvictions')),
    );
    expect(changeHash(SECOND, CATALOG_AT)).toBe(changeHash(FIRST, CATALOG_AT));
  });

  it('定位与顺序和重复无关；与旧哈希不同；没有定位时抛出', () => {
    const two = [...ruleAt('A'), ...CATALOG_AT];
    expect(locationHash([...two].reverse())).toBe(locationHash([...two, ...two]));
    expect(changeHash(FIRST, CATALOG_AT)).not.toBe(legacyChangeHash(FIRST));
    expect(() => changeHash(FIRST, [])).toThrow('修改没有任何定位');
  });
});

describe('去重结论与过渡规则', () => {
  const NOW = Date.UTC(2026, 9, 28, 12);
  const DAY = 86_400_000;
  const keys = (alert: string) =>
    changeKeys({
      repository: 'acme/gitops',
      patch: RELAX(alert),
      locations: ruleAt(alert),
      key: 'gitops/noisy-alert-relax',
      files: ['platform/rules/cache.yaml'],
    });
  const row = (over: Partial<ChangeRow>): ChangeRow => ({
    proposal_id: 'p',
    repository: 'acme/gitops',
    change_hash: '',
    hash_version: 2,
    location_hash: null,
    key: 'gitops/noisy-alert-relax',
    files: ['platform/rules/cache.yaml'],
    incident_id: 'i',
    state: 'pending',
    pr_number: null,
    pr_url: null,
    closed_at: null,
    created_at: new Date(NOW - DAY),
    ...over,
  });
  const evictions = keys('ShopCacheEvictions');
  const misses = keys('ShopCacheMisses');
  /** 新算法记录的 ShopCacheEvictions 修改 */
  const located = (over: Partial<ChangeRow>) =>
    row({ change_hash: evictions.hash, location_hash: evictions.location, ...over });
  /** 旧算法记录的 ShopCacheEvictions 修改 */
  const legacy = (over: Partial<ChangeRow>) => row({ hash_version: 1, change_hash: evictions.legacy, ...over });

  it('新算法的行：同一条规则的修改去重，另一条规则的修改不受影响', () => {
    const open = located({ state: 'open', pr_number: 900 });
    expect(classify([open], evictions, NOW, 7 * DAY)).toMatchObject({ code: 'duplicate_open' });
    expect(classify([open], misses, NOW, 7 * DAY)).toBeNull();
    expect(classify([located({})], misses, NOW, 7 * DAY)).toBeNull();
    const rejected = located({ state: 'rejected', closed_at: new Date(NOW - DAY) });
    expect(classify([rejected], evictions, NOW, 0)).toMatchObject({ code: 'rejected_before' });
    expect(classify([rejected], misses, NOW, 0)).toBeNull();
    // 冷却期按（模板，文件）计，与定位无关
    expect(classify([rejected], misses, NOW, 7 * DAY)).toMatchObject({ code: 'rejected_cooldown' });
  });

  it('旧算法的行按旧哈希参与 duplicate_open 与 duplicate_pending', () => {
    expect(classify([legacy({ state: 'open' })], misses, NOW, 0)).toMatchObject({ code: 'duplicate_open' });
    expect(classify([legacy({})], misses, NOW, 0)).toMatchObject({ code: 'duplicate_pending' });
  });

  it('旧算法被拒绝的行：只有定位确认相同时 rejected_before', () => {
    const closed = { state: 'rejected' as const, closed_at: new Date(NOW - DAY) };
    expect(classify([legacy(closed)], evictions, NOW, 0)).toBeNull();
    expect(classify([legacy({ ...closed, location_hash: evictions.location })], evictions, NOW, 0)).toMatchObject({
      code: 'rejected_before',
    });
    expect(classify([legacy({ ...closed, location_hash: evictions.location })], misses, NOW, 0)).toBeNull();
  });
});

describe('重复触发的 PR 评论', () => {
  it('带事件标记、控制台链接与新事件 issue 的 Refs；没有 issue 时省略 Refs', () => {
    const t = {
      lang: 'zh' as const,
      consoleUrl: 'https://srenautix.example.test/',
      incidentId: 'b5c1e1a4-0000-4000-8000-000000000001',
      incidentLabel: 'component:shop:2026-10-24T17:30:00Z',
      runId: 'b5c1e1a4-0000-4000-8000-000000000002',
      level: 'likely',
      issueRef: '#296',
    };
    expect(triggerComment(t)).toBe(
      [
        '<!-- srenautix:trigger=b5c1e1a4-0000-4000-8000-000000000001 -->',
        '同一个修改再次被触发：事件 [component:shop:2026-10-24T17:30:00Z](https://srenautix.example.test/incidents/b5c1e1a4-0000-4000-8000-000000000001)，' +
          '研判运行 [b5c1e1a4-0000-4000-8000-000000000002](https://srenautix.example.test/runs/b5c1e1a4-0000-4000-8000-000000000002)（likely）。' +
          'SreNautix 不为它另开 PR，触发记录在这里。',
        '',
        'Refs #296',
      ].join('\n'),
    );
    expect(triggerComment({ ...t, lang: 'en', issueRef: null })).not.toContain('Refs');
  });
});
