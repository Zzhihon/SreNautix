// 测试用的真实 Loki：单进程、本地文件存储，接受任意时间的历史日志，启动后经 push API 写入夹具。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { backendsDir, ensureBackend } from './backends.js';
import { startProcess, withFreePorts, type RunningProcess } from './process.js';

export interface FixtureLogStream {
  labels: Record<string, string>;
  /** unix 毫秒与日志行 */
  lines: Array<{ t: number; line: string }>;
}

export async function startLoki(streams: FixtureLogStream[]): Promise<RunningProcess> {
  const bins = await ensureBackend('loki');
  const root = join(backendsDir(), 'runs');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'loki-'));
  const proc = await withFreePorts(2, ([http, grpc]) => startOn(http!, grpc!));
  async function startOn(http: number, grpc: number): Promise<RunningProcess> {
    const config = {
      auth_enabled: false,
      server: {
        http_listen_address: '127.0.0.1',
        http_listen_port: http,
        grpc_listen_address: '127.0.0.1',
        grpc_listen_port: grpc,
        log_level: 'warn',
      },
      common: {
        instance_addr: '127.0.0.1',
        path_prefix: dir,
        storage: { filesystem: { chunks_directory: join(dir, 'chunks'), rules_directory: join(dir, 'rules') } },
        replication_factor: 1,
        ring: { kvstore: { store: 'inmemory' } },
      },
      schema_config: {
        configs: [
          {
            from: '2020-01-01',
            store: 'tsdb',
            object_store: 'filesystem',
            schema: 'v13',
            index: { prefix: 'index_', period: '24h' },
          },
        ],
      },
      limits_config: {
        reject_old_samples: false,
        allow_structured_metadata: true,
        volume_enabled: false,
        // 夹具里的历史日志可能跨越很长时间
        max_query_length: '0',
        creation_grace_period: '87600h',
      },
      // 测试实例不需要 WAL；关闭后也不受本机磁盘水位的写入限流影响
      ingester: { max_chunk_age: '87600h', wal: { enabled: false } },
      query_range: { results_cache: { cache: { embedded_cache: { enabled: false } } } },
      analytics: { reporting_enabled: false },
    };
    const cfgPath = join(dir, 'loki.yaml');
    writeFileSync(cfgPath, stringify(config));
    return startProcess({
      name: 'loki',
      bin: bins['loki']!,
      args: [`-config.file=${cfgPath}`],
      url: `http://127.0.0.1:${http}`,
      readyPath: '/ready',
      timeoutMs: 120_000,
    });
  }
  if (streams.length) {
    const res = await fetch(`${proc.url}/loki/api/v1/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streams: streams.map((s) => ({
          stream: s.labels,
          values: [...s.lines].sort((a, b) => a.t - b.t).map((l) => [`${BigInt(l.t) * 1_000_000n}`, l.line]),
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Loki push 失败：HTTP ${res.status} ${await res.text()}\n${proc.tail()}`);
    }
  }
  return {
    ...proc,
    stop: async () => {
      await proc.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
