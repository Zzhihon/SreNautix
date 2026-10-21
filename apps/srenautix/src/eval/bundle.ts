import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import pg from 'pg';
import { z } from 'zod';
import type { ChangeEvent, MetricSeries, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { ksmTopologyIntervals, ksmTopologyQueries, type KsmTopologyResults } from '@srenautix/core';
import { PrometheusApiAdapter } from '@srenautix/integration-sdk';
import { readSecretFile } from '../config/files.js';
import { fingerprint, identityLabels } from '../ingest/normalize.js';
import { logger } from '../log.js';
import type { Label } from './labels.js';

// 重建包（ADR 0110）：重建一次故障需要的全部输入，按标注逐个从数据源只读导出，保存在用例目录的 bundles/ 下。
// - 告警：ALERTS_FOR_STATE（取值为 pending 开始时刻）与 ALERTS{alertstate="firing"} 的区间查询，30 秒步长，
//   按标签与 pending 开始时刻切成告警实例（同一组标签再次触发是新的实例），与 server 的 60 秒对账接入相同；
// - 拓扑：kube-state-metrics 历史（ADR 0033，5 分钟步长），另可从 SreNautix 状态库只读导出 topology_events
//   （informer 或 reader 写入的完整拓扑，含 Argo 应用、属主与管理关系、版本标签）；同一个键两者都有时以状态库为准；
// - 变更：状态库的 change_events（变更源写入的）。发布变更由重建时从拓扑事件推导（changes/kubernetes.ts）。
// 时间范围：告警为 [窗口起点 − 归并相邻时间, 窗口终点]；拓扑与变更再往前 24 小时（墓碑查找与版本比较需要之前的状态）。

export const BUNDLE_FORMAT = 'srenautix-eval-bundle';
const STEP_S = 30;
const KSM_STEP_S = 300;
const LOOKBACK_MS = 30 * 60_000;
const TOPOLOGY_LOOKBACK_MS = 24 * 3600_000;

export interface AlertInstance {
  alertname: string;
  labels: Record<string, string>;
  fingerprint: string;
  /** ALERTS_FOR_STATE 的取值：条件第一次成立（pending 开始）的时刻 */
  active_at: string;
  /** 第一次观察到 firing 的时刻 */
  firing_from: string;
  /** 最后一次观察到 firing 之后的时刻；导出范围结束时仍在触发为 null */
  firing_to: string | null;
}

export interface TopologyRow {
  seq: number;
  op: 'node_upsert' | 'node_delete' | 'edge_upsert' | 'edge_delete';
  item: 'node' | 'edge';
  key: string;
  valid_from: string;
  valid_to: string | null;
  source: string;
  body: TopologyNode | TopologyEdge;
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  label_id: string;
  cluster_id: string;
  range: { from: string; to: string };
  alerts: AlertInstance[];
  topology: TopologyRow[];
  changes: ChangeEvent[];
  sources: { metrics: string; state: string | null };
  exported_at: string;
}

const pgFile = z
  .object({
    host: z.string().min(1),
    port: z.number().int(),
    database: z.string().min(1),
    user: z.string().min(1),
    password_file: z.string().min(1),
    ssl_mode: z.enum(['disable', 'require']).default('require'),
  })
  .strict();

export type StateDbConfig = z.infer<typeof pgFile>;

export function loadStateDbConfig(path: string): StateDbConfig {
  return pgFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** 只读连接：会话默认只读，语句超时 120 秒 */
export async function readOnlyClient(c: StateDbConfig): Promise<pg.Client> {
  const client = new pg.Client({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: readSecretFile('状态库口令', c.password_file),
    ssl: c.ssl_mode === 'require' ? { rejectUnauthorized: false } : undefined,
    application_name: 'srenautix-eval',
    options: '-c default_transaction_read_only=on -c statement_timeout=120000',
    connectionTimeoutMillis: 20_000,
  });
  await client.connect();
  const r = await client.query<{ ro: string }>("SELECT current_setting('default_transaction_read_only') AS ro");
  if (r.rows[0]?.ro !== 'on') {
    await client.end();
    throw new Error('状态库会话不是只读');
  }
  return client;
}

const iso = (ms: number) => new Date(ms).toISOString();

function seriesKey(labels: Record<string, string>): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** ALERTS_FOR_STATE 与 firing 序列 → 告警实例 */
export function alertInstances(forState: MetricSeries[], firing: MetricSeries[], rangeEnd: number): AlertInstance[] {
  const firingTimes = new Map<string, number[]>();
  for (const s of firing) {
    const labels = identityLabels(s.labels);
    const ts = s.times.filter((_, i) => s.values[i] !== null);
    const k = seriesKey(labels);
    firingTimes.set(
      k,
      [...(firingTimes.get(k) ?? []), ...ts].sort((a, b) => a - b),
    );
  }
  const out: AlertInstance[] = [];
  for (const s of forState) {
    const labels = identityLabels(s.labels);
    const alertname = labels.alertname;
    if (!alertname || alertname === 'Watchdog') {
      continue;
    }
    const fts = firingTimes.get(seriesKey(labels)) ?? [];
    // 取值（pending 开始时刻，秒）相同的连续样本是同一个实例
    const spans: Array<{ active: number; from: number; to: number }> = [];
    s.times.forEach((t, i) => {
      const v = s.values[i];
      if (v === null || v === undefined) {
        return;
      }
      const active = Math.round(v * 1000);
      const last = spans[spans.length - 1];
      if (last && last.active === active) {
        last.to = t;
      } else {
        spans.push({ active, from: t, to: t });
      }
    });
    for (const sp of spans) {
      const inSpan = fts.filter((t) => t >= sp.from && t <= sp.to);
      if (!inSpan.length) {
        continue;
      }
      const lastFiring = inSpan[inSpan.length - 1] as number;
      out.push({
        alertname,
        labels,
        fingerprint: fingerprint(labels),
        active_at: iso(sp.active),
        firing_from: iso(inSpan[0] as number),
        firing_to: lastFiring >= rangeEnd ? null : iso(lastFiring + STEP_S * 1000),
      });
    }
  }
  return out.sort((a, b) => a.firing_from.localeCompare(b.firing_from) || a.fingerprint.localeCompare(b.fingerprint));
}

async function range(
  m: PrometheusApiAdapter,
  expr: string,
  from: number,
  to: number,
  step: number,
): Promise<MetricSeries[]> {
  const window = { from: iso(from), to: iso(to) };
  const r = await m.queryRange({
    expr,
    dialect: 'promql',
    window,
    step_seconds: step,
    // 瞬时选择器带默认回看（5 分钟），时钟窗口从区间起点再往前留出这段
    clock_window: { from: iso(from - 10 * 60_000), to: window.to },
    timeout_ms: 120_000,
    max_series: 200_000,
  });
  if (r.truncated) {
    throw new Error(`查询结果被截断：${expr}`);
  }
  return r.series;
}

/**
 * kube-state-metrics 历史 → 拓扑行（source ksm_history，seq 为负数，排在状态库的行之前）。配置了 pre_step_labels 时，
 * 同时导出 Job、ReplicaSet、Deployment、StatefulSet 上这些 key 的标签（ADR 0104 §13），回放用同一份配置
 */
async function ksmRows(
  m: PrometheusApiAdapter,
  from: number,
  to: number,
  preStepLabels: readonly string[],
): Promise<TopologyRow[]> {
  const entries: Array<[string, MetricSeries[]]> = [];
  for (const [k, q] of Object.entries(ksmTopologyQueries(preStepLabels))) {
    entries.push([k, await range(m, q, from, to, KSM_STEP_S)]);
  }
  const results = Object.fromEntries(entries) as KsmTopologyResults;
  const intervals = ksmTopologyIntervals(results, KSM_STEP_S * 1000, undefined, preStepLabels);
  return intervals.map((iv, i): TopologyRow => {
    const node = 'node' in iv.item ? iv.item.node : null;
    const edge = 'edge' in iv.item ? iv.item.edge : null;
    return {
      seq: -(intervals.length - i),
      op: node ? 'node_upsert' : 'edge_upsert',
      item: node ? 'node' : 'edge',
      key: node ? node.key : `${edge!.from}|${edge!.relation}|${edge!.to}`,
      valid_from: iso(iv.from),
      // 区间延续到导出范围的终点时视为仍然存在
      valid_to: iv.to >= to ? null : iso(iv.to),
      source: 'ksm_history',
      body: (node ?? edge) as TopologyNode | TopologyEdge,
    };
  });
}

async function stateRows(
  c: pg.Client,
  clusterId: string,
  from: number,
  to: number,
): Promise<{ topology: TopologyRow[]; changes: ChangeEvent[] }> {
  const t = await c.query<{
    seq: string;
    op: TopologyRow['op'];
    item: 'node' | 'edge';
    key: string;
    valid_from: Date;
    valid_to: Date | null;
    source: string;
    body: TopologyNode | TopologyEdge;
  }>(
    `SELECT seq, op, item, key, valid_from, valid_to, source, body FROM server.topology_events
      WHERE cluster_id = $1 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to >= $2)
      ORDER BY seq`,
    [clusterId, new Date(from), new Date(to)],
  );
  const ch = await c.query<{ body: ChangeEvent }>(
    'SELECT body FROM server.change_events WHERE cluster_id = $1 AND time BETWEEN $2 AND $3 ORDER BY time, change_id',
    [clusterId, new Date(from), new Date(to)],
  );
  return {
    topology: t.rows.map((r) => ({
      seq: Number(r.seq),
      op: r.op,
      item: r.item,
      key: r.key,
      valid_from: r.valid_from.toISOString(),
      // 状态库中仍然打开、但在导出范围之后才关闭的区间，在范围内视为打开
      valid_to: r.valid_to === null || r.valid_to.getTime() > to ? null : r.valid_to.toISOString(),
      source: r.source,
      body: r.body,
    })),
    changes: ch.rows.map((r) => r.body),
  };
}

export interface ExportOptions {
  clusterId: string;
  metrics: { url: string; bearerTokenFile: string | null };
  state: pg.Client | null;
  stateId: string | null;
  /** 与 server 的 changes.kubernetes.pre_step_labels 相同；为空时不导出对象标签 */
  preStepLabels?: readonly string[];
  now?: () => Date;
}

export async function exportBundle(l: Label, o: ExportOptions): Promise<Bundle> {
  const from = Date.parse(l.window.from) - LOOKBACK_MS;
  const to = Date.parse(l.window.to);
  const topoFrom = from - TOPOLOGY_LOOKBACK_MS;
  const m = new PrometheusApiAdapter({
    id: 'eval-metrics',
    url: o.metrics.url,
    dialects: ['promql'],
    bearer_token_file: o.metrics.bearerTokenFile,
  });
  const forState = await range(m, 'ALERTS_FOR_STATE', from, to, STEP_S);
  const firing = await range(m, 'ALERTS{alertstate="firing"}', from, to, STEP_S);
  // 区间查询的最后一个点不晚于 to，按步长对齐
  const lastPoint = Math.max(0, ...[...forState, ...firing].flatMap((s) => s.times));
  const alerts = alertInstances(forState, firing, lastPoint);
  const ksm = await ksmRows(m, topoFrom, to, o.preStepLabels ?? []);
  const state = o.state ? await stateRows(o.state, o.clusterId, topoFrom, to) : { topology: [], changes: [] };
  logger.info('重建包已导出', {
    label: l.id,
    alerts: alerts.length,
    ksm_rows: ksm.length,
    state_rows: state.topology.length,
    changes: state.changes.length,
  });
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    label_id: l.id,
    cluster_id: o.clusterId,
    range: { from: iso(from), to: iso(to) },
    alerts,
    topology: [...ksm, ...state.topology],
    changes: state.changes,
    sources: { metrics: 'eval-metrics', state: o.stateId },
    exported_at: (o.now ?? (() => new Date()))().toISOString(),
  };
}

const bundlePath = (dir: string, labelId: string) => join(dir, 'bundles', `${encodeURIComponent(labelId)}.json.zst`);

export function writeBundle(dir: string, b: Bundle): string {
  mkdirSync(join(dir, 'bundles'), { recursive: true });
  const p = bundlePath(dir, b.label_id);
  writeFileSync(p, zstdCompressSync(Buffer.from(JSON.stringify(b))));
  return p;
}

export function hasBundle(dir: string, labelId: string): boolean {
  return existsSync(bundlePath(dir, labelId));
}

export function readBundle(dir: string, labelId: string): Bundle {
  const b = JSON.parse(zstdDecompressSync(readFileSync(bundlePath(dir, labelId))).toString('utf8')) as Bundle;
  if (b.format !== BUNDLE_FORMAT || b.version !== 1) {
    throw new Error(`${labelId} 的重建包格式不对：${b.format}@${b.version}`);
  }
  return b;
}
