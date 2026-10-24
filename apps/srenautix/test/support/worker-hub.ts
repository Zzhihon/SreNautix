import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { resolveWorkerConfig, workerConfigSchema, type WorkerConfig } from '../../src/research/config.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import type { TestDb } from './db.js';

/** server 与 worker 端到端用例共用的环境：一个 server（真实 HTTP 与 PG）与 worker 的配置。 */

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface WorkerHubTokens {
  ingest: string;
  worker: string;
  inbound: string;
}

export function fileWriter(root: string): (name: string, content: string) => string {
  return (name, content) => {
    const p = join(root, name);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, content);
    return p;
  };
}

/** 拓扑：Deployment:shop/api 与它的 Pod（Alertmanager webhook 夹具里的实体） */
export async function seedShopTopology(db: TestDb): Promise<void> {
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const at = new Date(Date.now() - 3600_000);
  const node = (kind: string, ns: string | null, name: string, uid: string) => ({
    key: ns ? `${kind}:${ns}/${name}` : `${kind}:${name}`,
    kind,
    namespace: ns,
    name,
    uid,
    labels: {},
    component_type: null,
    hub: false,
  });
  await topo.apply('c1', [
    { op: 'node_upsert', at, source: 'informer', node: node('Deployment', 'shop', 'api', 'uid-deploy-api') },
    { op: 'node_upsert', at, source: 'informer', node: node('Pod', 'shop', 'api-7d9f8-x2k4p', 'uid-pod-api') },
    {
      op: 'edge_upsert',
      at,
      source: 'informer',
      edge: {
        from: 'Pod:shop/api-7d9f8-x2k4p',
        to: 'Deployment:shop/api',
        relation: 'owned_by',
        provenance: 'structural',
        confidence: 1,
        scope: 'instance',
        evidence: 'ownerReference',
      },
    },
  ]);
}

/** 集群 c1 的 server：Alertmanager 入口 am、worker 调用方、worker 的内部 API 在 workerPort */
export async function startHubForWorker(
  db: TestDb,
  file: (name: string, content: string) => string,
  tokens: WorkerHubTokens,
  workerPort: number,
): Promise<ServerHandle> {
  const signing = generateKeyPairSync('ed25519');
  const checkpoint = generateKeyPairSync('ed25519');
  return buildServer({
    config: parseServerConfig({
      cluster_id: 'c1',
      profile: 'standard',
      log_level: 'warn',
      public_url: 'https://srenautix.example.test',
      worker: { url: `http://127.0.0.1:${workerPort}`, token_file: file('worker-inbound', tokens.inbound) },
      policies_dir: resolve(
        file(
          'policies/c1.yaml',
          stringify({
            version: 1,
            cluster: 'c1',
            actions: [{ id: 'workload_scale', namespaces: ['shop'] }],
            approvers: [],
          }),
        ),
        '..',
      ),
      ingest: {
        sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', tokens.ingest) }],
        reconcile: { enabled: false },
      },
      packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
      // 空的集成清单目录：清单缺失时集成页不列出这些实例，server 照常启动（镜像缺少 integrations/ 时同样如此）
      integrations: { dir: resolve(file('integrations/.keep', ''), '..') },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: { source: 'off' },
      approvals: {
        signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
        key_id: 'e2e',
      },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({ callers: [{ id: 'worker', kind: 'worker', token_sha256: sha256(tokens.worker) }] }),
        ),
      },
      identity: {
        local_admin: {
          username: 'admin',
          password_hash_file: file('admin.hash', await hashPassword('correct horse battery')),
          totp_secret_file: file('admin.totp', 'JBSWY3DPEHPK3PXP'),
        },
        bindings_dir: resolve(file('bindings/admin.yaml', stringify({ bindings: [] })), '..'),
      },
      audit: {
        checkpoint_key_file: file(
          'checkpoint.pem',
          checkpoint.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        ),
      },
    }),
    pg: db.serverConfig,
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: 0 },
  });
}

/** worker w1 的配置；llm 与 listen 由用例给出 */
export function workerConfigFor(
  hubUrl: string,
  file: (name: string, content: string) => string,
  tokens: WorkerHubTokens,
  over: { llm: Record<string, unknown>; listen?: Record<string, string>; budget?: Record<string, unknown> },
): WorkerConfig {
  return resolveWorkerConfig(
    workerConfigSchema.parse({
      cluster_id: 'c1',
      worker_id: 'w1',
      code_sha: 'a'.repeat(40),
      log_level: 'warn',
      ...(over.listen ? { listen: over.listen } : {}),
      hub: { url: hubUrl, token_file: file('worker-token', tokens.worker) },
      inbound: { token_sha256_file: file('inbound-sha', `${sha256(tokens.inbound)}\n`) },
      language: 'zh',
      llm: over.llm,
      budget: { daily_tokens: 15_000_000, ...over.budget },
      research: { deadline: '20m', claim_wait: '1s' },
    }),
  );
}
