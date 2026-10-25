import { describe, expect, it } from 'vitest';
import { changeHash, triggerComment } from '../../src/remediation/dedupe.js';

// 修改去重的键（ADR 0155）：规范化补丁只含路径与增删的行

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

describe('规范化补丁的哈希', () => {
  it('基准提交前进后同一个修改的哈希不变', () => {
    expect(changeHash(SECOND)).toBe(changeHash(FIRST));
  });

  it('增加的行不同、路径不同时哈希不同', () => {
    expect(
      changeHash(FIRST.replace('role: cause, entity: { kind: Deployment', 'role: symptom, entity: { kind: Deployment')),
    ).not.toBe(changeHash(FIRST));
    expect(changeHash(FIRST.replaceAll('srenautix/packs/shop/', 'srenautix/packs/web/'))).not.toBe(changeHash(FIRST));
  });

  it('多个文件的补丁与文件顺序无关；新文件按新路径计', () => {
    expect(changeHash(`${FIRST}${RULE}`)).toBe(changeHash(`${RULE}${FIRST}`));
    const created = `diff --git a/srenautix/topology-overrides/shop.yaml b/srenautix/topology-overrides/shop.yaml
new file mode 100644
--- /dev/null
+++ b/srenautix/topology-overrides/shop.yaml
@@ -0,0 +1 @@
+overrides: []
`;
    expect(changeHash(created)).not.toBe(changeHash(created.replaceAll('shop.yaml', 'web.yaml')));
  });

  it('补丁里没有文件时抛出', () => {
    expect(() => changeHash('')).toThrow('补丁没有任何文件');
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
