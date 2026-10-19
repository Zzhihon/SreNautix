import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * 测试用的真实 etcd 与 kube-apiserver（controller-runtime envtest 的二进制，放在 worktree 的 .scratch/envtest）。
 * 两个静态 token：admin 属于 system:masters；topology-reader 没有任何组，权限只来自测试里创建的 ClusterRole，
 * 用来验证 docs/server/topology.md 写明的只读 RBAC 足够 informer 使用。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch');

export const ADMIN_TOKEN = 'envtest-admin-token-0123456789';
export const READER_TOKEN = 'envtest-topology-reader-token-0123456789';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

/**
 * envtest 二进制目录（<版本>-<系统>-<架构> 的上一级）：SRENAUTIX_ENVTEST_DIR 优先；其次是仓库根目录
 * `make envtest-assets` 下载的 .envtest/k8s；最后是 worktree 的 .scratch/envtest/k8s。
 */
function binDir(): string {
  const candidates = [
    process.env.SRENAUTIX_ENVTEST_DIR,
    resolve(ROOT, '..', '.envtest', 'k8s'),
    join(ROOT, 'envtest', 'k8s'),
  ].filter((x): x is string => !!x);
  const base = candidates.find((x) => existsSync(x));
  if (!base) {
    throw new Error(`找不到 envtest 二进制目录（${candidates.join('、')}）；在仓库根目录执行 make envtest-assets`);
  }
  const versions = readdirSync(base).sort();
  const v = versions[versions.length - 1];
  if (!v) {
    throw new Error(`${base} 下没有 envtest 版本目录`);
  }
  return join(base, v);
}

async function waitHttp(url: string, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 自签名的服务端证书：只在测试进程内对本地 apiserver 关闭证书校验
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    for (;;) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          return;
        }
      } catch {
        // 尚未监听
      }
      if (Date.now() > deadline) {
        throw new Error(`${url} 在 ${timeoutMs} ms 内没有就绪`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

export interface EnvTest {
  server: string;
  /** 管理员 kubeconfig 文件路径。 */
  adminKubeconfig: string;
  /** 只有 topology-reader 只读权限的 kubeconfig 文件路径。 */
  readerKubeconfig: string;
  stop(): Promise<void>;
}

function kubeconfig(server: string, token: string): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'envtest', cluster: { server, 'insecure-skip-tls-verify': true } }],
    users: [{ name: 'u', user: { token } }],
    contexts: [{ name: 'envtest', context: { cluster: 'envtest', user: 'u' } }],
    'current-context': 'envtest',
  });
}

export async function startEnvTest(): Promise<EnvTest> {
  const bin = binDir();
  const dir = join(ROOT, `envtest-run-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const etcdPort = await freePort();
  const peerPort = await freePort();
  const apiPort = await freePort();
  const procs: ChildProcess[] = [];
  const etcd = spawn(
    join(bin, 'etcd'),
    [
      `--data-dir=${join(dir, 'etcd')}`,
      `--listen-client-urls=http://127.0.0.1:${etcdPort}`,
      `--advertise-client-urls=http://127.0.0.1:${etcdPort}`,
      `--listen-peer-urls=http://127.0.0.1:${peerPort}`,
      '--unsafe-no-fsync=true',
      '--log-level=error',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  etcd.stderr?.resume();
  procs.push(etcd);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(join(dir, 'sa.key'), privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(join(dir, 'sa.pub'), publicKey.export({ format: 'pem', type: 'spki' }));
  writeFileSync(
    join(dir, 'tokens.csv'),
    `${ADMIN_TOKEN},admin,admin,"system:masters"\n${READER_TOKEN},topology-reader,topology-reader\n`,
  );
  const api = spawn(
    join(bin, 'kube-apiserver'),
    [
      `--etcd-servers=http://127.0.0.1:${etcdPort}`,
      `--cert-dir=${join(dir, 'certs')}`,
      `--secure-port=${apiPort}`,
      '--bind-address=127.0.0.1',
      '--advertise-address=127.0.0.1',
      '--service-cluster-ip-range=10.0.0.0/24',
      '--allow-privileged=true',
      '--authorization-mode=RBAC',
      `--token-auth-file=${join(dir, 'tokens.csv')}`,
      '--disable-admission-plugins=ServiceAccount',
      '--service-account-issuer=https://kubernetes.default.svc',
      `--service-account-key-file=${join(dir, 'sa.pub')}`,
      `--service-account-signing-key-file=${join(dir, 'sa.key')}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  api.stderr?.resume();
  procs.push(api);
  const server = `https://127.0.0.1:${apiPort}`;
  await waitHttp(`${server}/readyz`, { authorization: `Bearer ${ADMIN_TOKEN}` }, 60_000);
  const adminKubeconfig = join(dir, 'admin.kubeconfig');
  const readerKubeconfig = join(dir, 'reader.kubeconfig');
  writeFileSync(adminKubeconfig, kubeconfig(server, ADMIN_TOKEN));
  writeFileSync(readerKubeconfig, kubeconfig(server, READER_TOKEN));
  return {
    server,
    adminKubeconfig,
    readerKubeconfig,
    async stop() {
      for (const p of procs.reverse()) {
        await new Promise<void>((res) => {
          if (p.exitCode !== null) {
            res();
            return;
          }
          p.once('exit', () => res());
          p.kill('SIGTERM');
        });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
