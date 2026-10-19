// 测试用的真实 Prometheus：用 promtool 把 OpenMetrics 回填成 TSDB 块，再启动 prometheus 读取。
// 两个二进制从 PATH 中查找（CI 安装固定版本），找不到时测试直接失败
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetricSeries } from '@srenautix/contract';

const WORK = fileURLToPath(new URL('../../../.work/', import.meta.url));

export interface Sample {
  metric: string;
  labels: Record<string, string>;
  /** unix 毫秒 */
  from: number;
  to: number;
  stepMs: number;
}

function openMetrics(samples: readonly Sample[]): string {
  const byMetric = new Map<string, Sample[]>();
  for (const s of samples) {
    byMetric.set(s.metric, [...(byMetric.get(s.metric) ?? []), s]);
  }
  const lines: string[] = [];
  for (const [metric, list] of byMetric) {
    lines.push(`# TYPE ${metric} gauge`);
    for (const s of list) {
      const labels = Object.entries(s.labels)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(',');
      for (let t = s.from; t < s.to; t += s.stepMs) {
        lines.push(`${metric}{${labels}} 1 ${t / 1000}`);
      }
    }
  }
  lines.push('# EOF');
  return lines.join('\n') + '\n';
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('没有拿到端口'))));
    });
  });
}

export class TestPrometheus {
  private constructor(
    private readonly proc: ChildProcess,
    private readonly dir: string,
    readonly url: string,
  ) {}

  static async start(name: string, samples: readonly Sample[]): Promise<TestPrometheus> {
    const dir = join(WORK, `${name}-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'input.om'), openMetrics(samples));
    writeFileSync(join(dir, 'prometheus.yml'), 'global:\n  scrape_interval: 30s\n');
    execFileSync('promtool', ['tsdb', 'create-blocks-from', 'openmetrics', join(dir, 'input.om'), join(dir, 'data')], {
      stdio: 'pipe',
    });
    const port = await freePort();
    const proc = spawn(
      'prometheus',
      [
        `--config.file=${join(dir, 'prometheus.yml')}`,
        `--storage.tsdb.path=${join(dir, 'data')}`,
        '--storage.tsdb.retention.time=100y',
        `--web.listen-address=127.0.0.1:${port}`,
      ],
      { stdio: 'ignore' },
    );
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(`prometheus 退出，退出码 ${proc.exitCode}`);
      }
      const ok = await fetch(`${url}/-/ready`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) {
        break;
      }
      if (Date.now() > deadline) {
        proc.kill('SIGKILL');
        throw new Error('prometheus 30 秒内没有就绪');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return new TestPrometheus(proc, dir, url);
  }

  async stop(): Promise<void> {
    const exited = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill('SIGTERM');
    await exited;
    rmSync(this.dir, { recursive: true, force: true });
  }

  private async get(path: string, params: Record<string, string>): Promise<MetricSeries[]> {
    const res = await fetch(`${this.url}${path}?${new URLSearchParams(params)}`);
    const body = (await res.json()) as {
      status: string;
      error?: string;
      data: {
        resultType: string;
        result: Array<{ metric: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }>;
      };
    };
    if (body.status !== 'success') {
      throw new Error(`Prometheus 查询失败：${body.error}`);
    }
    return body.data.result.map((r) => {
      const points = r.values ?? (r.value ? [r.value] : []);
      return {
        labels: r.metric,
        times: points.map(([t]) => Math.round(t * 1000)),
        values: points.map(([, v]) => Number(v)),
      };
    });
  }

  query(expr: string, at: number): Promise<MetricSeries[]> {
    return this.get('/api/v1/query', { query: expr, time: String(at / 1000) });
  }

  queryRange(expr: string, from: number, to: number, stepMs: number): Promise<MetricSeries[]> {
    return this.get('/api/v1/query_range', {
      query: expr,
      start: String(from / 1000),
      end: String(to / 1000),
      step: String(stepMs / 1000),
    });
  }
}
