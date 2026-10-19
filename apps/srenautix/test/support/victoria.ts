import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';

// 测试用的真实 VictoriaMetrics 单机版：版本与 sha256 与 packages/integration-sdk/backends.json 一致，
// 下载到仓库的 .scratch/backends/，每个测试文件启动一个实例，数据目录在 .scratch/ 下，测试结束后删除。

const REPO = resolve(import.meta.dirname, '../../../..');
const BACKENDS = join(REPO, 'packages/integration-sdk/backends.json');
const VERSION = '1.154.0';
const SHA256: Record<string, string> = {
  'darwin-amd64': '8356724c5c02d46f07f6b8dc353ca50e4a4cdf951caedb13f5e20d248b6fde83',
  'darwin-arm64': '8599fe6254c2601666f729b98abffea4892762c91e1f67e421590e2d64566797',
  'linux-amd64': '2ba3edae969a4b52a55e78d2721067541b0ee94774190dbd87fea0602aa57b8f',
  'linux-arm64': '6dbeb72f924007ebb9abadfd8a555a420950af13631bb32143c5f4e5010dec2d',
};

function osArch(): string {
  const os = platform();
  const a = arch() === 'x64' ? 'amd64' : arch();
  return `${os}-${a}`;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? res(addr.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

/**
 * 取得 victoria-metrics-prod 的路径：CI 由 .github/scripts/install-test-binaries.sh 安装到 SRENAUTIX_TEST_BIN；
 * 本地不存在时下载并校验 sha256
 */
export async function victoriaBinary(): Promise<string> {
  const ci = process.env.SRENAUTIX_TEST_BIN;
  if (ci) {
    const bin = join(ci, 'victoria-metrics-prod');
    if (!existsSync(bin)) {
      throw new Error(`SRENAUTIX_TEST_BIN 中没有 victoria-metrics-prod：${bin}`);
    }
    return bin;
  }
  if (existsSync(BACKENDS)) {
    const pinned = (JSON.parse(readFileSync(BACKENDS, 'utf8')) as Record<string, { version: string }>)[
      'victoria-metrics'
    ];
    if (pinned && pinned.version !== VERSION) {
      throw new Error(`backends.json 中 VictoriaMetrics 版本为 ${pinned.version}，本测试固定为 ${VERSION}，请同步`);
    }
  }
  const oa = osArch();
  const sha = SHA256[oa];
  if (!sha) {
    throw new Error(`没有 ${oa} 的 VictoriaMetrics 二进制`);
  }
  const dir = join(REPO, '.scratch/backends', `victoria-metrics-${VERSION}-${oa}`);
  const bin = join(dir, 'victoria-metrics-prod');
  if (existsSync(bin)) {
    return bin;
  }
  mkdirSync(dir, { recursive: true });
  const [os, a] = oa.split('-');
  const url = `https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/v${VERSION}/victoria-metrics-${os}-${a}-v${VERSION}.tar.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载 ${url} 失败：HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== sha) {
    throw new Error(`VictoriaMetrics 压缩包 sha256 不符：${got}`);
  }
  const tgz = join(dir, 'vm.tar.gz');
  writeFileSync(tgz, buf);
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  rmSync(tgz);
  return bin;
}

export interface Victoria {
  url: string;
  /** 以 Prometheus 文本格式导入样本（时间戳为毫秒） */
  importLines(lines: string[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startVictoria(): Promise<Victoria> {
  const bin = await victoriaBinary();
  const port = await freePort();
  const data = join(REPO, '.scratch', `vm-${process.pid}-${Date.now()}`);
  mkdirSync(data, { recursive: true });
  const proc: ChildProcess = spawn(
    bin,
    [
      `-storageDataPath=${data}`,
      `-httpListenAddr=127.0.0.1:${port}`,
      '-retentionPeriod=100y',
      '-search.disableCache',
      '-loggerLevel=ERROR',
    ],
    { stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    const ok = await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) {
      break;
    }
    if (i > 100) {
      proc.kill('SIGKILL');
      throw new Error('VictoriaMetrics 没有在 10 秒内就绪');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    async importLines(lines) {
      const r = await fetch(`${url}/api/v1/import/prometheus`, { method: 'POST', body: lines.join('\n') });
      if (!r.ok) {
        throw new Error(`导入失败：HTTP ${r.status} ${await r.text()}`);
      }
      const f = await fetch(`${url}/internal/force_flush`);
      if (!f.ok) {
        throw new Error(`force_flush 失败：HTTP ${f.status}`);
      }
    },
    async stop() {
      await new Promise<void>((r) => {
        proc.once('exit', () => r());
        proc.kill('SIGTERM');
      });
      rmSync(data, { recursive: true, force: true });
    },
  };
}
