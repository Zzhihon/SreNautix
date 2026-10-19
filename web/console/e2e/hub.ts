// 控制台 e2e 的真实后端：一次性 PostgreSQL、envtest（真实 etcd 与 kube-apiserver）、真实的 server 角色
// （apps/srenautix 的入口，按生产方式用配置文件启动），以及 vite preview 提供构建后的控制台并把 /v1 转发到 server。
// 种子数据全部经真实接口写入：Kubernetes 对象写进 apiserver 由 server 的 informer 读到；告警经 Alertmanager
// webhook 接入；提议由 worker 身份经 /v1/research/claim 与 /v1/proposals 提交；集群状态由 gateway 心跳上报。

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { stringify } from 'yaml';
import { hashPassword } from '../../../apps/srenautix/src/identity/password.ts';
import { ADMIN_TOKEN, startEnvTest, type EnvTest } from '../../../apps/srenautix/test/support/envtest.ts';
import { startCluster, type TestCluster } from '../../../apps/srenautix/test/support/pg-cluster.ts';

export const REPO = resolve(import.meta.dirname, '../../..');
export const SCRATCH = join(REPO, '.scratch', 'console-e2e');
export const STATE_FILE = join(SCRATCH, 'state.json');

export const CLUSTER = 'e2e';
export const ADMIN = { username: 'admin', password: 'console e2e password' };
export const TOKENS = {
  ingest: 'ingest-token-console-e2e-0123456789',
  worker: 'worker-token-console-e2e-0123456789',
  gateway: 'gateway-token-console-e2e-0123456789',
};

/** 写给测试进程的运行信息。 */
export interface HubState {
  consoleUrl: string;
  apiUrl: string;
  totpSecret: string;
  incidentId: string;
  label: string;
  proposals: { low: string; high: string };
  pids: number[];
  pgDir: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

function file(name: string, content: string): string {
  const p = join(SCRATCH, name);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) {
        return v;
      }
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what}：${timeoutMs} ms 内没有完成${last ? `（${String(last)}）` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 管理员身份调用 envtest 的 apiserver（自签名证书）。 */
async function kube(env: EnvTest, method: string, path: string, body: unknown): Promise<{ metadata: { uid: string } }> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const r = await fetch(`${env.server}${path}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`${method} ${path}: ${r.status} ${text}`);
    }
    return JSON.parse(text) as { metadata: { uid: string } };
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

/** shop 命名空间里的 api Deployment、它的 ReplicaSet 与一个 Pod（envtest 没有控制器，Pod 停在 Pending）。 */
async function seedKube(env: EnvTest): Promise<void> {
  await kube(env, 'POST', '/api/v1/namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } });
  const labels = { app: 'api' };
  const container = [{ name: 'api', image: 'registry.example/api:1.0.0' }];
  const deploy = await kube(env, 'POST', '/apis/apps/v1/namespaces/shop/deployments', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'shop', labels },
    spec: {
      replicas: 2,
      selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: { containers: container } },
    },
  });
  const rs = await kube(env, 'POST', '/apis/apps/v1/namespaces/shop/replicasets', {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: 'api-7d9f8',
      namespace: 'shop',
      labels,
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api', uid: deploy.metadata.uid, controller: true },
      ],
    },
    spec: {
      replicas: 2,
      selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: { containers: container } },
    },
  });
  // SreNautix 自己的工作负载：对它的动作属于自身依赖，按不可逆加 H 档处理（DESIGN §9.1）
  await kube(env, 'POST', '/api/v1/namespaces', {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'srenautix' },
  });
  const self = { app: 'srenautix-worker' };
  await kube(env, 'POST', '/apis/apps/v1/namespaces/srenautix/deployments', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'srenautix-worker', namespace: 'srenautix', labels: self },
    spec: {
      replicas: 1,
      selector: { matchLabels: self },
      template: { metadata: { labels: self }, spec: { containers: container } },
    },
  });
  await kube(env, 'POST', '/api/v1/namespaces/shop/pods', {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'api-7d9f8-x2k4p',
      namespace: 'shop',
      labels,
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api-7d9f8', uid: rs.metadata.uid, controller: true },
      ],
    },
    spec: { containers: container },
  });
}

function spawnLogged(
  name: string,
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): ChildProcess {
  const log = join(SCRATCH, `${name}.log`);
  writeFileSync(log, '');
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const append = (b: Buffer) => writeFileSync(log, b, { flag: 'a' });
  p.stdout?.on('data', append);
  p.stderr?.on('data', append);
  return p;
}

async function waitOk(url: string, what: string, timeoutMs = 120_000): Promise<void> {
  await until(what, async () => (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok, timeoutMs);
}

interface Api {
  (
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    body: unknown;
  }>;
}

function apiClient(base: string): Api {
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) {
      headers.authorization = `Bearer ${opts.token}`;
    }
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
}

function expectStatus(what: string, r: { status: number; body: unknown }, ...ok: number[]): void {
  if (!ok.includes(r.status)) {
    throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

export interface Running {
  state: HubState;
  stop(): Promise<void>;
}

export async function startHub(): Promise<Running> {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const procs: ChildProcess[] = [];
  let pg: TestCluster | null = null;
  let kubeEnv: EnvTest | null = null;
  const stop = async () => {
    for (const p of procs.reverse()) {
      if (p.exitCode === null) {
        await new Promise<void>((res) => {
          p.once('exit', () => res());
          p.kill('SIGTERM');
        });
      }
    }
    await kubeEnv?.stop();
    if (pg) {
      // 同步停止并删除数据目录：Playwright 在全局清理返回后立即退出，异步的停止回调来不及执行
      const bin = process.env.SRENAUTIX_PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
      execFileSync(join(bin, 'pg_ctl'), ['-D', pg.dir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
      rmSync(pg.dir, { recursive: true, force: true });
    }
  };
  try {
    pg = await startCluster();
    kubeEnv = await startEnvTest();
    await seedKube(kubeEnv);

    const apiPort = await freePort();
    const consolePort = await freePort();
    const consoleUrl = `http://localhost:${consolePort}`;
    const totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
    const signing = generateKeyPairSync('ed25519');
    const checkpoint = generateKeyPairSync('ed25519');
    const config = {
      cluster_id: CLUSTER,
      profile: 'standard',
      log_level: 'info',
      public_url: consoleUrl,
      listen: {
        api: `127.0.0.1:${apiPort}`,
        metrics: `127.0.0.1:${await freePort()}`,
        probes: `127.0.0.1:${await freePort()}`,
      },
      database: { password_file: file('db-password', pg.password), pool_size: 10 },
      policies_dir: resolve(
        file(
          `policies/${CLUSTER}.yaml`,
          stringify({
            version: 1,
            cluster: CLUSTER,
            actions: [{ id: 'workload_scale', namespaces: ['shop', 'srenautix'] }],
            self_dependencies: { namespaces: ['srenautix'] },
            approvers: [{ principal: 'local:admin', namespaces: ['*'], max_tier: 'H' }],
          }),
        ),
        '..',
      ),
      ingest: {
        sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', TOKENS.ingest) }],
        reconcile: { enabled: false },
      },
      packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: { source: 'informer', kubeconfig: kubeEnv.adminKubeconfig },
      approvals: {
        signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
        key_id: 'console-e2e',
      },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({
            callers: [
              { id: 'worker', kind: 'worker', token_sha256: sha(TOKENS.worker) },
              {
                id: `gw-${CLUSTER}`,
                kind: 'spoke',
                role: 'gateway',
                cluster_id: CLUSTER,
                token_sha256: sha(TOKENS.gateway),
              },
            ],
          }),
        ),
      },
      identity: {
        local_admin: {
          username: ADMIN.username,
          password_hash_file: file('admin.hash', await hashPassword(ADMIN.password)),
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
          checkpoint.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        ),
      },
    };
    const configPath = file('config.yaml', stringify(config));

    // server 角色：与镜像相同的入口，源码经 tsx 运行，按 PG 标准环境变量连接 server 库角色
    const app = join(REPO, 'apps', 'srenautix');
    const server = spawnLogged(
      'server',
      process.execPath,
      ['--conditions=@srenautix/source', '--import', 'tsx', 'src/main.ts', '--role=server', `--config=${configPath}`],
      {
        PGHOST: '127.0.0.1',
        PGPORT: String(pg.port),
        PGDATABASE: pg.database,
        PGUSER: 'srenautix_server',
        PGSSLMODE: 'disable',
      },
      app,
    );
    procs.push(server);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitOk(`${apiUrl}/readyz`, 'server 就绪');

    // 构建后的控制台由 vite preview 提供，/v1 转发到 server（与同源部署等价：cookie 与 Origin 都是控制台地址）
    const web = join(REPO, 'web', 'console');
    const preview = spawnLogged(
      'preview',
      process.execPath,
      [
        join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
        'preview',
        '--port',
        String(consolePort),
        '--strictPort',
        '--host',
        'localhost',
      ],
      { SRENAUTIX_HUB_URL: apiUrl },
      web,
    );
    procs.push(preview);
    await waitOk(`${consoleUrl}/`, 'vite preview 就绪');

    // ---- 经真实接口写入种子数据 ----
    const api = apiClient(apiUrl);
    const now = new Date();
    const webhook = {
      receiver: 'srenautix',
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'api-7d9f8-x2k4p', severity: 'critical' },
          annotations: {
            summary: 'api 反复重启',
            description: '<b>容器</b> api 在 10 分钟内重启 5 次 {{ $labels.pod }}',
          },
          startsAt: new Date(now.getTime() - 120_000).toISOString(),
          endsAt: '0001-01-01T00:00:00Z',
          generatorURL: 'http://prometheus.example:9090/graph',
          fingerprint: '6c1f0a2b3c4d5e6f',
        },
      ],
      groupLabels: { alertname: 'KubePodCrashLooping' },
      commonLabels: {},
      commonAnnotations: {},
      externalURL: 'http://alertmanager.example:9093',
      version: '4',
      groupKey: '{}:{alertname="KubePodCrashLooping"}',
      truncatedAlerts: 0,
    };
    expectStatus('写入告警', await api('POST', '/v1/ingest/am', { token: TOKENS.ingest, body: webhook }), 200);

    // gateway 心跳：集群出现在集群页，准入自检通过
    const hb = await api('POST', '/v1/spoke/heartbeat', {
      token: TOKENS.gateway,
      headers: { 'x-srenautix-cluster': CLUSTER },
      body: {
        gateway_id: 'gw-0',
        version: '0.1.0',
        leader: true,
        propose_only: false,
        conditions: [
          {
            type: 'AdmissionSelfCheck',
            status: 'True',
            reason: 'Denied',
            since: now.toISOString().replace(/\.\d+Z$/, 'Z'),
          },
        ],
        queue: [],
        clock_skew_seconds: { apiserver: 0.1 },
      },
    });
    expectStatus('gateway 心跳', hb, 200);

    // worker 身份认领阶段 B 任务并提交两个提议：扩容 shop/api（L 档）与扩容 SreNautix 自己的 worker（自身依赖，H 档）
    const claim = await until('认领研判任务', async () => {
      const r = await api('POST', '/v1/research/claim', { token: TOKENS.worker, body: { worker_id: 'e2e-worker' } });
      return r.status === 200 ? r : null;
    });
    const task = (claim.body as { task: { run_id: string; incident_id: string; worker_id: string } }).task;
    const ctx = await api('GET', `/v1/research/tasks/${task.run_id}/context`, { token: TOKENS.worker });
    expectStatus('读取研判输入', ctx, 200);
    const c = ctx.body as {
      incident: { incident_id: string; label: string; incident_version: number; root: { component: string } };
      stage_a: { evidence_fingerprint: string };
    };
    const propose = async (namespace: string, name: string, replicas: number, key: string) => {
      const r = await api('POST', '/v1/proposals', {
        token: TOKENS.worker,
        headers: { 'idempotency-key': key },
        body: {
          incident_id: c.incident.incident_id,
          binding: {
            incident_version: c.incident.incident_version,
            root_component: c.incident.root.component,
            evidence_fingerprint: c.stage_a.evidence_fingerprint,
          },
          action: 'workload_scale',
          params: { namespace, kind: 'Deployment', name, replicas },
          research_run_id: task.run_id,
          rule_id: null,
          hypothesis_id: 'h1',
          evidence_refs: [],
          expected_effect: `副本数调整到 ${replicas}`,
        },
      });
      expectStatus(`提交提议（replicas=${replicas}）`, r, 201);
      return (r.body as { proposal_id: string }).proposal_id;
    };
    // 目标 UID 由 informer 写入的拓扑解析；informer 首次同步之前提议会因目标未解析被拒绝，重试到同步完成
    const low = await until('提交 L 档提议', () => propose('shop', 'api', 3, 'console-e2e-low'));
    const high = await until('提交 H 档提议', () => propose('srenautix', 'srenautix-worker', 2, 'console-e2e-high'));
    expectStatus(
      '结束研判任务',
      await api('POST', `/v1/research/tasks/${task.run_id}/finish`, {
        token: TOKENS.worker,
        body: { worker_id: task.worker_id, state: 'stage_a_only' },
      }),
      204,
    );

    const state: HubState = {
      consoleUrl,
      apiUrl,
      totpSecret: totp.secret.base32,
      incidentId: c.incident.incident_id,
      label: c.incident.label,
      proposals: { low, high },
      pids: procs.map((p) => p.pid ?? 0),
      pgDir: pg.dir,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return { state, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
