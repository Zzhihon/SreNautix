import {
  AppsV1Api,
  AuthorizationV1Api,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
} from '@kubernetes/client-node';
import type { TopologyEdge } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { startInformerTopology, type InformerTopology } from '../../src/topology/informer.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { startEnvTest, type EnvTest } from '../support/envtest.js';
import { until } from '../support/monitoring.js';

/**
 * 真实的 kube-apiserver（envtest）→ server 内置 informer → PG 中的事件溯源拓扑。
 * informer 使用只有只读 ClusterRole 的身份（与 docs/server/topology.md 中的 RBAC 一致），不能读 Secret。
 */
let env: EnvTest;
let db: TestDb;
let store: TopologyStore;
let topo: InformerTopology;
let core: CoreV1Api;
let apps: AppsV1Api;
const abort = new AbortController();

const READ_RULES = [
  {
    apiGroups: [''],
    resources: [
      'namespaces',
      'nodes',
      'pods',
      'persistentvolumeclaims',
      'persistentvolumes',
      'services',
      'endpoints',
      'configmaps',
    ],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['apps'],
    resources: ['deployments', 'replicasets', 'statefulsets', 'daemonsets'],
    verbs: ['get', 'list', 'watch'],
  },
  { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
];

const container = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  image: 'registry.example/app:1',
  ...extra,
});

const hasEdge = (edges: TopologyEdge[], from: string, relation: string, to: string) =>
  edges.find((e) => e.from === from && e.relation === relation && e.to === to);

beforeAll(async () => {
  env = await startEnvTest();
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack]);
  store = new TopologyStore(db.server);
  const kc = new KubeConfig();
  kc.loadFromFile(env.adminKubeconfig);
  core = kc.makeApiClient(CoreV1Api);
  apps = kc.makeApiClient(AppsV1Api);
  const rbac = kc.makeApiClient(RbacAuthorizationV1Api);
  const net = kc.makeApiClient(NetworkingV1Api);
  await rbac.createClusterRole({ body: { metadata: { name: 'srenautix-topology' }, rules: READ_RULES } });
  await rbac.createClusterRoleBinding({
    body: {
      metadata: { name: 'srenautix-topology' },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'srenautix-topology' },
      subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'topology-reader' }],
    },
  });

  await core.createNamespace({ body: { metadata: { name: 'shop', labels: { team: 'shop' } } } });
  await core.createNode({ body: { metadata: { name: 'n1', labels: { 'kubernetes.io/hostname': 'n1' } } } });
  const dep = await apps.createNamespacedDeployment({
    namespace: 'shop',
    body: {
      metadata: { name: 'api', labels: { app: 'api' } },
      spec: {
        selector: { matchLabels: { app: 'api' } },
        template: { metadata: { labels: { app: 'api' } }, spec: { containers: [container('api')] } },
      },
    },
  });
  const rs = await apps.createNamespacedReplicaSet({
    namespace: 'shop',
    body: {
      metadata: {
        name: 'api-7d9f8',
        labels: { app: 'api' },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: 'api',
            uid: dep.metadata?.uid as string,
            controller: true,
          },
        ],
      },
      spec: {
        selector: { matchLabels: { app: 'api' } },
        template: { metadata: { labels: { app: 'api' } }, spec: { containers: [container('api')] } },
      },
    },
  });
  await core.createNamespacedConfigMap({
    namespace: 'shop',
    body: { metadata: { name: 'api-config' }, data: { REDIS_URL: 'redis://cache:6379/0' } },
  });
  for (const name of ['api-7d9f8-a', 'api-7d9f8-b']) {
    await core.createNamespacedPod({
      namespace: 'shop',
      body: {
        metadata: {
          name,
          labels: { app: 'api' },
          ownerReferences: [
            {
              apiVersion: 'apps/v1',
              kind: 'ReplicaSet',
              name: 'api-7d9f8',
              uid: rs.metadata?.uid as string,
              controller: true,
            },
          ],
        },
        spec: {
          nodeName: 'n1',
          containers: [
            container('api', {
              env: [
                { name: 'DB_HOST', value: 'db.shop.svc.cluster.local' },
                { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'db-password', key: 'password' } } },
              ],
              envFrom: [{ configMapRef: { name: 'api-config' } }],
            }),
          ],
        },
      },
    });
  }
  await core.createPersistentVolume({
    body: {
      metadata: { name: 'pv-db-0' },
      spec: {
        capacity: { storage: '1Gi' },
        accessModes: ['ReadWriteOnce'],
        csi: { driver: 'ebs.csi.example.com', volumeHandle: 'vol-1' },
      },
    },
  });
  await core.createNamespacedPersistentVolumeClaim({
    namespace: 'shop',
    body: {
      metadata: { name: 'data-db-0' },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, volumeName: 'pv-db-0' },
    },
  });
  await core.createNamespacedPod({
    namespace: 'shop',
    body: {
      metadata: { name: 'db-0', labels: { app: 'db' } },
      spec: {
        nodeName: 'n1',
        containers: [container('db')],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-db-0' } }],
      },
    },
  });
  await core.createNamespacedPod({
    namespace: 'shop',
    body: {
      metadata: { name: 'cache-0', labels: { app: 'cache' } },
      spec: { nodeName: 'n1', containers: [container('cache')] },
    },
  });
  for (const [name, app] of [
    ['api', 'api'],
    ['db', 'db'],
    ['cache', 'cache'],
  ] as const) {
    await core.createNamespacedService({
      namespace: 'shop',
      body: { metadata: { name }, spec: { selector: { app }, ports: [{ port: 80 }] } },
    });
  }
  await net.createNamespacedNetworkPolicy({
    namespace: 'shop',
    body: {
      metadata: { name: 'api-egress' },
      spec: {
        podSelector: { matchLabels: { app: 'api' } },
        policyTypes: ['Egress'],
        egress: [{ to: [{ podSelector: { matchLabels: { app: 'db' } } }] }],
      },
    },
  });
  await net.createNamespacedIngress({
    namespace: 'shop',
    body: {
      metadata: { name: 'web' },
      spec: {
        rules: [
          {
            host: 'shop.example',
            http: {
              paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'api', port: { number: 80 } } } }],
            },
          },
        ],
      },
    },
  });

  topo = startInformerTopology({
    store,
    clusterId: 'c1',
    kubeconfigPath: env.readerKubeconfig,
    signal: abort.signal,
    flushMs: 200,
  });
  await topo.ready;
}, 180_000);

afterAll(async () => {
  abort.abort();
  await topo?.stop();
  await db?.close();
  await env?.stop();
});

describe('只读 RBAC', () => {
  it('informer 的身份不能读取 Secret', async () => {
    const kc = new KubeConfig();
    kc.loadFromFile(env.readerKubeconfig);
    const authz = kc.makeApiClient(AuthorizationV1Api);
    const r = await authz.createSelfSubjectAccessReview({
      body: { spec: { resourceAttributes: { verb: 'list', resource: 'secrets' } } },
    });
    expect(r.status?.allowed).toBe(false);
    const p = await authz.createSelfSubjectAccessReview({
      body: { spec: { resourceAttributes: { verb: 'watch', resource: 'pods' } } },
    });
    expect(p.status?.allowed).toBe(true);
  });
});

describe('内置 informer 拓扑', () => {
  it('结构关系、配置引用、NetworkPolicy 出站规则的边带正确的来源、置信度与作用范围', async () => {
    const t = await store.at('c1', new Date());
    const e = t.edges;
    expect(hasEdge(e, 'Pod:shop/api-7d9f8-a', 'owned_by', 'ReplicaSet:shop/api-7d9f8')).toMatchObject({
      provenance: 'structural',
      confidence: 1,
    });
    expect(hasEdge(e, 'ReplicaSet:shop/api-7d9f8', 'owned_by', 'Deployment:shop/api')).toBeTruthy();
    expect(hasEdge(e, 'Pod:shop/api-7d9f8-a', 'runs_on', 'Node:n1')).toMatchObject({
      scope: 'instance',
      confidence: 1,
    });
    expect(hasEdge(e, 'Service:shop/api', 'selects', 'Pod:shop/api-7d9f8-b')).toMatchObject({ scope: 'service' });
    expect(hasEdge(e, 'Pod:shop/db-0', 'mounts', 'PersistentVolumeClaim:shop/data-db-0')).toMatchObject({
      scope: 'instance',
    });
    expect(hasEdge(e, 'PersistentVolumeClaim:shop/data-db-0', 'bound_to', 'PersistentVolume:pv-db-0')).toBeTruthy();
    expect(hasEdge(e, 'PersistentVolume:pv-db-0', 'provisioned_by', 'CSIDriver:ebs.csi.example.com')).toBeTruthy();
    expect(t.nodes.find((n) => n.key === 'CSIDriver:ebs.csi.example.com')?.hub).toBe(true);
    expect(hasEdge(e, 'Pod:shop/api-7d9f8-a', 'references', 'Service:shop/db')).toMatchObject({
      provenance: 'config_ref',
      confidence: 0.7,
    });
    expect(hasEdge(e, 'Pod:shop/api-7d9f8-a', 'references', 'Service:shop/cache')).toMatchObject({
      provenance: 'config_ref',
    });
    expect(hasEdge(e, 'Pod:shop/api-7d9f8-a', 'references', 'Secret:shop/db-password')).toMatchObject({
      provenance: 'config_ref',
    });
    expect(hasEdge(e, 'Pod:shop/api-7d9f8-a', 'egress_to', 'Pod:shop/db-0')).toMatchObject({
      provenance: 'network_policy',
      confidence: 0.6,
    });
    expect(hasEdge(e, 'Ingress:shop/web', 'routes_to', 'Service:shop/api')).toBeTruthy();
    expect(t.nodes.find((n) => n.key === 'Pod:shop/api-7d9f8-a')?.uid).toMatch(/^[0-9a-f-]{36}$/);
    // ConfigMap 的值不进入拓扑
    expect(JSON.stringify(t)).not.toContain('redis://');
  });

  it('没有变化时不产生新的拓扑事件', async () => {
    const v = await store.version('c1');
    await new Promise((r) => setTimeout(r, 800));
    expect(await store.version('c1')).toBe(v);
  });

  it('删除 Pod 后关闭它的行：当前视图没有它，删除前的时刻仍能查到，24 小时内作为墓碑可解析', async () => {
    const before = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await core.deleteNamespacedPod({ name: 'api-7d9f8-b', namespace: 'shop', gracePeriodSeconds: 0 });
    await until('Pod 从当前拓扑中消失', async () => {
      const t = await store.at('c1', new Date());
      return !t.nodes.some((n) => n.key === 'Pod:shop/api-7d9f8-b');
    });
    const now = await store.at('c1', new Date());
    expect(hasEdge(now.edges, 'Service:shop/api', 'selects', 'Pod:shop/api-7d9f8-b')).toBeUndefined();
    const then = await store.at('c1', before);
    expect(then.nodes.some((n) => n.key === 'Pod:shop/api-7d9f8-b')).toBe(true);
    expect(hasEdge(then.edges, 'Service:shop/api', 'selects', 'Pod:shop/api-7d9f8-b')).toBeTruthy();
    const found = await store.find('c1', 'Pod', 'shop', 'api-7d9f8-b', new Date());
    expect(found).toMatchObject({ key: 'Pod:shop/api-7d9f8-b', tombstone: true });
    expect(await store.find('c1', 'Pod', 'shop', 'api-7d9f8-a', new Date())).toMatchObject({ tombstone: false });
  });

  it('两跳邻域从根因出发包含依赖它的工作负载', async () => {
    const n = await store.neighborhood('c1', ['Service:shop/db'], new Date());
    expect(n.nodes.map((x) => x.key)).toEqual(
      expect.arrayContaining(['Pod:shop/db-0', 'Pod:shop/api-7d9f8-a', 'ReplicaSet:shop/api-7d9f8']),
    );
  });
});
