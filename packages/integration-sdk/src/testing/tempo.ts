// 测试用的真实 Tempo：单进程模式、本地存储，经 OTLP/HTTP 写入夹具链路。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { backendsDir, ensureBackend } from './backends.js';
import { freePort, startProcess, type RunningProcess } from './process.js';

export interface FixtureSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service: string;
  name: string;
  /** unix 毫秒 */
  start: number;
  duration_ms: number;
  error?: boolean;
  attributes?: Record<string, string>;
}

export async function startTempo(spans: FixtureSpan[]): Promise<RunningProcess> {
  const bins = await ensureBackend('tempo');
  const root = join(backendsDir(), 'runs');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'tempo-'));
  const [http, grpc, otlp] = [await freePort(), await freePort(), await freePort()];
  const config = {
    server: {
      http_listen_address: '127.0.0.1',
      http_listen_port: http,
      grpc_listen_address: '127.0.0.1',
      grpc_listen_port: grpc,
      log_level: 'warn',
    },
    distributor: { receivers: { otlp: { protocols: { http: { endpoint: `127.0.0.1:${otlp}` } } } } },
    storage: { trace: { backend: 'local', local: { path: join(dir, 'traces') }, wal: { path: join(dir, 'wal') } } },
    usage_report: { reporting_enabled: false },
  };
  const cfgPath = join(dir, 'tempo.yaml');
  writeFileSync(cfgPath, stringify(config));
  const proc = await startProcess({
    name: 'tempo',
    bin: bins['tempo']!,
    // 这些路径的默认值在 /var/tempo 下；backend-scheduler 的参数名在 Tempo 3.1 中带重复的前缀
    args: [
      `-config.file=${cfgPath}`,
      `-backend-schedulerbackend-scheduler.local-work-path=${join(dir, 'scheduler')}`,
      `-block-builder.wal.path=${join(dir, 'block-builder')}`,
      `-live-store.shutdown_marker_dir=${join(dir, 'shutdown-marker')}`,
      `-live-store.wal.path=${join(dir, 'live-store')}`,
    ],
    url: `http://127.0.0.1:${http}`,
    readyPath: '/ready',
    timeoutMs: 120_000,
  });
  if (spans.length) {
    const byService = new Map<string, FixtureSpan[]>();
    for (const s of spans) {
      byService.set(s.service, [...(byService.get(s.service) ?? []), s]);
    }
    // OTLP/JSON 中 trace id 与 span id 用十六进制
    const hexToB64 = (h: string) => h;
    const body = {
      resourceSpans: [...byService.entries()].map(([service, list]) => ({
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            scope: { name: 'srenautix-fixtures' },
            spans: list.map((s) => ({
              traceId: hexToB64(s.trace_id),
              spanId: hexToB64(s.span_id),
              ...(s.parent_span_id ? { parentSpanId: hexToB64(s.parent_span_id) } : {}),
              name: s.name,
              kind: 2,
              startTimeUnixNano: String(BigInt(s.start) * 1_000_000n),
              endTimeUnixNano: String(BigInt(s.start) * 1_000_000n + BigInt(Math.round(s.duration_ms * 1e6))),
              status: { code: s.error ? 2 : 1 },
              attributes: Object.entries(s.attributes ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
            })),
          },
        ],
      })),
    };
    const res = await fetch(`http://127.0.0.1:${otlp}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Tempo OTLP 写入失败：HTTP ${res.status} ${await res.text()}\n${proc.tail()}`);
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
