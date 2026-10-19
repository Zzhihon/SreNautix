// 测试用的真实 OCI 仓库：zot（OCI Distribution 1.1），只监听本机，数据目录在 .scratch/backends/runs 下，停止时删除。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir, ensureBackend } from './backends.js';
import { freePort, startProcess, type RunningProcess } from './process.js';

export interface OciRegistry extends RunningProcess {
  /** host:port，用于镜像引用 */
  host: string;
}

export async function startOciRegistry(): Promise<OciRegistry> {
  const { zot } = await ensureBackend('zot');
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'zot-'));
  const port = await freePort();
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      distSpecVersion: '1.1.1',
      storage: { rootDirectory: join(dir, 'data'), gc: false, dedupe: false },
      http: { address: '127.0.0.1', port: String(port) },
      log: { level: 'warn' },
    }),
  );
  const proc = await startProcess({
    name: 'zot',
    bin: zot!,
    args: ['serve', config],
    url: `http://127.0.0.1:${port}`,
    readyPath: '/v2/',
  });
  return {
    name: proc.name,
    url: proc.url,
    host: `127.0.0.1:${port}`,
    tail: () => proc.tail(),
    stop: async () => {
      await proc.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
