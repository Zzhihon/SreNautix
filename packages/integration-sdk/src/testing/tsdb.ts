// 把夹具序列装进真实的 Prometheus 与 VictoriaMetrics：
// - Prometheus：写成 OpenMetrics 文本，用 promtool tsdb create-blocks-from openmetrics 回填成块，再启动服务；
// - VictoriaMetrics：启动后用 /api/v1/import/prometheus 导入带时间戳的样本，再 /internal/force_flush。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir, ensureBackend } from './backends.js';
import { startProcess, withFreePorts, type RunningProcess } from './process.js';

export interface FixturePoint {
  /** unix 毫秒 */
  t: number;
  v: number;
}

export interface FixtureMetricSeries {
  labels: Record<string, string>;
  points: FixturePoint[];
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sampleValue(v: number): string {
  if (Number.isNaN(v)) {
    return 'NaN';
  }
  if (v === Infinity) {
    return '+Inf';
  }
  if (v === -Infinity) {
    return '-Inf';
  }
  return String(v);
}

function seriesKey(labels: Record<string, string>): string {
  const name = labels['__name__'];
  if (!name) {
    throw new Error(`夹具序列缺少指标名：${JSON.stringify(labels)}`);
  }
  const rest = Object.entries(labels)
    .filter(([k]) => k !== '__name__')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return rest.length ? `${name}{${rest.join(',')}}` : name;
}

/** 文本格式的样本行；timeUnit 决定时间戳单位（OpenMetrics 为秒，VictoriaMetrics 导入为毫秒） */
function exposition(series: FixtureMetricSeries[], timeUnit: 's' | 'ms', eof: boolean): string {
  const sorted = [...series].sort((a, b) => {
    const ka = seriesKey(a.labels);
    const kb = seriesKey(b.labels);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const lines: string[] = [];
  for (const s of sorted) {
    const key = seriesKey(s.labels);
    for (const p of [...s.points].sort((a, b) => a.t - b.t)) {
      const ts = timeUnit === 's' ? (p.t / 1000).toFixed(3) : String(p.t);
      lines.push(`${key} ${sampleValue(p.v)} ${ts}`);
    }
  }
  if (eof) {
    lines.push('# EOF');
  }
  return lines.join('\n') + '\n';
}

function workDir(prefix: string): string {
  const root = join(backendsDir(), 'runs');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${prefix}-`));
}

export interface TsdbInstance extends RunningProcess {
  readonly kind: 'prometheus' | 'victoria-metrics';
}

export async function startPrometheus(series: FixtureMetricSeries[]): Promise<TsdbInstance> {
  const bins = await ensureBackend('prometheus');
  const dir = workDir('prometheus');
  const data = join(dir, 'data');
  mkdirSync(data);
  if (series.length) {
    const om = join(dir, 'fixtures.om');
    writeFileSync(om, exposition(series, 's', true));
    execFileSync(bins['promtool']!, ['tsdb', 'create-blocks-from', 'openmetrics', om, data], { stdio: 'pipe' });
  }
  const cfg = join(dir, 'prometheus.yml');
  writeFileSync(cfg, 'global:\n  evaluation_interval: 1m\n');
  const proc = await withFreePorts(1, ([port]) =>
    startProcess({
      name: 'prometheus',
      bin: bins['prometheus']!,
      args: [
        `--config.file=${cfg}`,
        `--storage.tsdb.path=${data}`,
        '--storage.tsdb.retention.time=100y',
        `--web.listen-address=127.0.0.1:${port}`,
      ],
      url: `http://127.0.0.1:${port}`,
      readyPath: '/-/ready',
    }),
  );
  return {
    ...proc,
    kind: 'prometheus',
    stop: async () => {
      await proc.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function startVictoriaMetrics(series: FixtureMetricSeries[]): Promise<TsdbInstance> {
  const bins = await ensureBackend('victoria-metrics');
  const dir = workDir('victoria-metrics');
  const proc = await withFreePorts(1, ([port]) =>
    startProcess({
      name: 'victoria-metrics',
      bin: bins['victoria-metrics']!,
      args: [
        `-storageDataPath=${join(dir, 'data')}`,
        `-httpListenAddr=127.0.0.1:${port}`,
        '-retentionPeriod=100y',
        '-search.disableCache',
        '-search.latencyOffset=0s',
        '-loggerLevel=ERROR',
      ],
      url: `http://127.0.0.1:${port}`,
      readyPath: '/health',
    }),
  );
  if (series.length) {
    const res = await fetch(`${proc.url}/api/v1/import/prometheus`, {
      method: 'POST',
      body: exposition(series, 'ms', false),
    });
    if (!res.ok) {
      throw new Error(`VictoriaMetrics 导入失败：HTTP ${res.status} ${await res.text()}`);
    }
    const flush = await fetch(`${proc.url}/internal/force_flush`);
    if (!flush.ok) {
      throw new Error(`VictoriaMetrics force_flush 失败：HTTP ${flush.status}`);
    }
  }
  return {
    ...proc,
    kind: 'victoria-metrics',
    stop: async () => {
      await proc.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
