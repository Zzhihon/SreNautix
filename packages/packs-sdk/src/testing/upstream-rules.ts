// 告警目录的覆盖检查（DESIGN §3.2）：按固定版本渲染上游 chart，取出全部 PrometheusRule 告警规则，
// 与领域包的 alerts.yaml 比对：
// - 每个上游告警名至少有一个目录条目；目录中没有上游不存在的告警名；
// - 按规则自己的标签选出的条目，角色为 forecast 当且仅当规则表达式（经官方解析器解析）调用了 predict_linear。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertCatalogEntry } from '@srenautix/contract';
import {
  backendsDir,
  ensureBackend,
  fetchVerified,
  loadPromqlEngine,
  placeAtomically,
} from '@srenautix/integration-sdk';
import { parseAllDocuments } from 'yaml';

interface ChartPin {
  name: string;
  version: string;
  url: string;
  sha256: string;
}

export interface UpstreamRule {
  group: string;
  alert: string;
  expr: string;
  labels: Record<string, string>;
}

export function loadChartPin(path: string): ChartPin {
  return JSON.parse(readFileSync(path, 'utf8')) as ChartPin;
}

/** 下载（校验 sha256）并用固定版本的 Helm 以默认 values 渲染 chart，返回全部告警规则 */
export async function renderUpstreamRules(pin: ChartPin): Promise<UpstreamRule[]> {
  // 与后端二进制相同：下载到临时目录，带完整标记原子落位，并发安全
  const target = join(backendsDir(), 'charts', `${pin.name}-${pin.version}`);
  const tgz = join(target, 'chart.tgz');
  await placeAtomically(target, async (staging) => {
    writeFileSync(join(staging, 'chart.tgz'), await fetchVerified(pin.url, pin.sha256));
  });
  const { helm } = await ensureBackend('helm');
  const rendered = execFileSync(helm!, ['template', 'kps', tgz, '--namespace', 'monitoring'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out: UpstreamRule[] = [];
  for (const doc of parseAllDocuments(rendered)) {
    if (doc.errors.length) {
      throw new Error(`渲染结果不是合法的 YAML：${doc.errors[0]!.message}`);
    }
    const obj = doc.toJS() as {
      kind?: string;
      spec?: { groups?: Array<{ name: string; rules?: Array<Record<string, unknown>> }> };
    } | null;
    if (obj?.kind !== 'PrometheusRule') {
      continue;
    }
    for (const g of obj.spec?.groups ?? []) {
      for (const r of g.rules ?? []) {
        if (typeof r['alert'] !== 'string') {
          continue;
        }
        out.push({
          group: g.name,
          alert: r['alert'],
          expr: String(r['expr']),
          labels: (r['labels'] as Record<string, string> | undefined) ?? {},
        });
      }
    }
  }
  if (!out.length) {
    throw new Error(`${pin.name} ${pin.version} 渲染结果中没有告警规则`);
  }
  return out;
}

export interface CoverageReport {
  upstreamAlertnames: number;
  /** 上游有、目录没有的告警名 */
  missing: string[];
  /** 目录有、上游没有的告警名 */
  stale: string[];
  /** 规则与选中的目录条目在 forecast 上不一致 */
  forecastMismatch: Array<{
    alert: string;
    labels: Record<string, string>;
    entry: string | null;
    role: string | null;
    predictLinear: boolean;
  }>;
}

/** 与 packages/core 的目录查找相同：同名条目中 match_labels 全部满足、条件数最多的一条，同样多时取先声明的 */
function lookup(entries: AlertCatalogEntry[], alert: string, labels: Record<string, string>): AlertCatalogEntry | null {
  const candidates = entries
    .filter((e) => e.alertname === alert)
    .map((e, i) => ({ e, i, n: Object.keys(e.match_labels ?? {}).length }))
    .filter(({ e }) => Object.entries(e.match_labels ?? {}).every(([k, v]) => labels[k] === v))
    .sort((a, b) => b.n - a.n || a.i - b.i);
  return candidates[0]?.e ?? null;
}

export async function checkCoverage(rules: UpstreamRule[], entries: AlertCatalogEntry[]): Promise<CoverageReport> {
  const engine = await loadPromqlEngine();
  const upstream = new Set(rules.map((r) => r.alert));
  const catalog = new Set(entries.map((e) => e.alertname));
  const forecastMismatch: CoverageReport['forecastMismatch'] = [];
  for (const r of rules) {
    const e = lookup(entries, r.alert, { alertname: r.alert, ...r.labels });
    const predictLinear = engine.analyze(r.expr, 'promql').functions.includes('predict_linear');
    if (!e || (e.role === 'forecast') !== predictLinear) {
      forecastMismatch.push({
        alert: r.alert,
        labels: r.labels,
        entry: e?.id ?? null,
        role: e?.role ?? null,
        predictLinear,
      });
    }
  }
  return {
    upstreamAlertnames: upstream.size,
    missing: [...upstream].filter((a) => !catalog.has(a)).sort(),
    stale: [...catalog].filter((a) => !upstream.has(a)).sort(),
    forecastMismatch,
  };
}
