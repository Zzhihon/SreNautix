import { AppsV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finish, KubeToolError, KubeTools } from '../../src/research/kube-tools.js';
import { startEnvTest, type EnvTest } from '../support/envtest.js';

// 阶段 B 的 Kubernetes 只读检查（ADR 0106），对真实的 kube-apiserver（envtest，没有 kubelet 与控制器）：
// Pod 状态、工作负载的 Pod 列表、对象事件；只允许事件涉及的命名空间；日志读取失败时给出 API 的原因

let env: EnvTest;
let tools: KubeTools;
const ALLOWED = new Set(['shop']);

beforeAll(async () => {
  env = await startEnvTest();
  const kc = new KubeConfig();
  kc.loadFromFile(env.adminKubeconfig);
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  await core.createNamespace({ body: { metadata: { name: 'shop' } } });
  await core.createNamespace({ body: { metadata: { name: 'other' } } });
  const labels = { app: 'api' };
  await apps.createNamespacedDeployment({
    namespace: 'shop',
    body: {
      metadata: { name: 'api' },
      spec: {
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'api',
                image: 'registry.example/api:1',
                env: [{ name: 'DB_PASSWORD', value: 'hunter2-should-not-leak' }],
              },
            ],
          },
        },
      },
    },
  });
  await core.createNamespacedPod({
    namespace: 'shop',
    body: {
      metadata: { name: 'api-1', labels },
      spec: {
        initContainers: [{ name: 'wait-migrations', image: 'registry.example/migrate:1' }],
        containers: [
          {
            name: 'api',
            image: 'registry.example/api:1',
            env: [{ name: 'DB_PASSWORD', value: 'hunter2-should-not-leak' }],
          },
        ],
      },
    },
  });
  await core.createNamespacedEvent({
    namespace: 'shop',
    body: {
      metadata: { name: 'api-1.wait' },
      involvedObject: { kind: 'Pod', name: 'api-1', namespace: 'shop' },
      type: 'Warning',
      reason: 'BackOff',
      message: 'init container wait-migrations is waiting for schema version 42',
      count: 3,
      lastTimestamp: new Date('2026-10-20T16:40:00Z'),
      firstTimestamp: new Date('2026-10-20T16:30:00Z'),
      source: { component: 'kubelet' },
    },
  });
  // 管理员身份（envtest 里只读身份没有 pods/log 与 events 的权限设置）；server 在 chart 里用只读 ClusterRole
  tools = new KubeTools(env.adminKubeconfig, { tailLines: 100, maxBytes: 4096 });
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe('Kubernetes 只读检查', () => {
  it('Pod 状态：phase、init 容器与容器、属主；不含环境变量', async () => {
    const r = await tools.run('kube_pod_status', { namespace: 'shop', pod: 'api-1' }, ALLOWED);
    const body = JSON.parse(r.text) as { name: string; phase: unknown; init_containers: unknown[] };
    expect(body.name).toBe('api-1');
    expect(r.text).not.toContain('hunter2-should-not-leak');
    expect(r.text).not.toContain('DB_PASSWORD');
  });

  it('工作负载的 Pod 列表按 Deployment 的选择器取', async () => {
    const r = await tools.run('kube_workload_pods', { namespace: 'shop', kind: 'Deployment', name: 'api' }, ALLOWED);
    const body = JSON.parse(r.text) as { selector: string; pods: Array<{ name: string }> };
    expect(body.selector).toBe('app=api');
    expect(body.pods.map((p) => p.name)).toEqual(['api-1']);
  });

  it('对象事件：新的在前，带原因与次数', async () => {
    const r = await tools.run('kube_events', { namespace: 'shop', kind: 'Pod', name: 'api-1' }, ALLOWED);
    expect(JSON.parse(r.text)).toEqual([
      {
        type: 'Warning',
        reason: 'BackOff',
        message: 'init container wait-migrations is waiting for schema version 42',
        count: 3,
        last: expect.stringMatching(/^2026-10-20T16:40:00/),
      },
    ]);
  });

  it('事件涉及范围之外的命名空间被拒绝；对象不存在时给出 API 的原因', async () => {
    await expect(tools.run('kube_pod_status', { namespace: 'other', pod: 'x' }, ALLOWED)).rejects.toThrow(
      /命名空间 other 不在本次事件涉及的范围内/,
    );
    await expect(tools.run('kube_pod_status', { namespace: 'shop', pod: 'missing' }, ALLOWED)).rejects.toBeInstanceOf(
      KubeToolError,
    );
    // envtest 没有 kubelet，日志读不到：作为工具错误返回，研判照常继续
    await expect(
      tools.run('kube_logs', { namespace: 'shop', pod: 'api-1', container: 'wait-migrations' }, ALLOWED),
    ).rejects.toBeInstanceOf(KubeToolError);
  });

  it('结果脱敏并按字节截断', () => {
    const r = finish(`token=ghp_${'a'.repeat(36)}\n${'x'.repeat(5000)}`, 1024);
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(1024);
    expect(r.text).not.toContain(`ghp_${'a'.repeat(36)}`);
  });
});
