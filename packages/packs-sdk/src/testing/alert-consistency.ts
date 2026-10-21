// 主卡与告警规则的一致性（pack test 的一部分）：告警目录条目声明了 primary_card、并且提供了该告警的规则文件时，
// 主卡的每个夹具测试在同一份夹具数据上再求一次告警规则：告警在卡片窗口内触发 ⇔ 主卡判为异常。
// 规则文件是 Prometheus 规则文件（groups）或 PrometheusRule / VMRule（spec.groups），与线上加载的是同一份，
// 阈值因此只有一个来源。

import { readFileSync } from 'node:fs';
import type { AlertCatalogEntry } from '@srenautix/contract';
import { QuerySyntaxError, toIso, type PromqlEngine } from '@srenautix/integration-sdk';
import { parseAllDocuments } from 'yaml';
import type { PackSet } from '../pack/compile.js';
import { primaryCardKey } from '../pack/compile.js';
import type { EvidenceDataSource } from '../runtime/datasource.js';
import { durationSeconds } from '../runtime/run-card.js';

export interface AlertRule {
  alert: string;
  expr: string;
  /** 能按 PromQL 解析时为 promql，否则为 metricsql（vmalert 的 tlast_over_time 等） */
  dialect: 'promql' | 'metricsql';
  for_seconds: number;
  /** 规则的静态标签（不含模板），用于按条目的 match_labels 选规则 */
  labels: Record<string, string>;
  /** 规则所在的文件 */
  file: string;
}

type RuleDoc = { rules?: Array<{ alert?: string; expr?: string; for?: string; labels?: Record<string, string> }> };

/** 读规则文件中的告警规则：告警名 → 规则（同名告警可以有多条，例如 warning 与 critical） */
export function loadAlertRules(files: string[], engine: PromqlEngine): Map<string, AlertRule[]> {
  const out = new Map<string, AlertRule[]>();
  for (const file of files) {
    for (const d of parseAllDocuments(readFileSync(file, 'utf8'))) {
      if (d.errors.length) {
        throw new Error(`${file}：${d.errors[0]!.message}`);
      }
      const doc = d.toJS() as { groups?: RuleDoc[]; spec?: { groups?: RuleDoc[] } } | null;
      for (const g of doc?.spec?.groups ?? doc?.groups ?? []) {
        for (const r of g.rules ?? []) {
          if (!r.alert) {
            continue;
          }
          if (!r.expr) {
            throw new Error(`${file}：告警 ${r.alert} 没有 expr`);
          }
          const labels = Object.fromEntries(
            Object.entries(r.labels ?? {}).filter(([, v]) => !String(v).includes('{{')),
          );
          out.set(r.alert, [
            ...(out.get(r.alert) ?? []),
            {
              alert: r.alert,
              expr: r.expr,
              dialect: dialectOf(engine, r.expr),
              for_seconds: r.for ? durationSeconds(r.for) : 0,
              labels,
              file,
            },
          ]);
        }
      }
    }
  }
  return out;
}

function dialectOf(engine: PromqlEngine, expr: string): 'promql' | 'metricsql' {
  try {
    engine.analyze(expr, 'promql');
    return 'promql';
  } catch (err) {
    if (!(err instanceof QuerySyntaxError)) {
      throw err;
    }
    engine.analyze(expr, 'metricsql');
    return 'metricsql';
  }
}

/** 条目对应的规则：告警名相同、match_labels 是规则静态标签的子集；没有时为 null，多于一条时报错 */
export function ruleForEntry(rules: Map<string, AlertRule[]>, entry: AlertCatalogEntry): AlertRule | null {
  const hits = (rules.get(entry.alertname) ?? []).filter((r) =>
    Object.entries(entry.match_labels ?? {}).every(([k, v]) => r.labels[k] === v),
  );
  if (hits.length > 1) {
    throw new Error(`告警目录条目 ${entry.id} 对应 ${hits.length} 条 ${entry.alertname} 规则，用 match_labels 区分`);
  }
  return hits[0] ?? null;
}

/** 主卡全局键 → 声明它的告警目录条目 */
export function primaryCardIndex(set: PackSet): Map<string, Array<{ pack: string; entry: AlertCatalogEntry }>> {
  const out = new Map<string, Array<{ pack: string; entry: AlertCatalogEntry }>>();
  for (const p of set.packs) {
    for (const entry of p.content.alerts.entries) {
      if (!entry.primary_card) {
        continue;
      }
      const key = primaryCardKey(p.name, entry.primary_card);
      out.set(key, [...(out.get(key) ?? []), { pack: p.name, entry }]);
    }
  }
  return out;
}

/**
 * 告警在 [from, to] 内是否触发：表达式在某个时刻 t 有结果，并且 [t - for, t] 的每个求值步都有结果。
 * 只看与实体对应的序列：条目 name_labels 中第一个出现在序列上的标签必须等于实体名；
 * 序列上没有任何 name_labels（例如以 component 标签为实体、表达式不保留它）时整条序列都算。
 * 后端不支持规则的方言时为 null（不核对）。
 */
export async function alertFires(
  ds: EvidenceDataSource,
  rule: AlertRule,
  nameLabels: string[],
  entityName: string,
  window: { from: number; to: number },
  stepSeconds: number,
  clock: { from: string; to: string },
): Promise<boolean | null> {
  if (!ds.metricsDialects.has(rule.dialect)) {
    return null;
  }
  const stepMs = stepSeconds * 1000;
  const start = window.from - rule.for_seconds * 1000;
  const res = await ds.queryRange({
    expr: rule.expr,
    dialect: rule.dialect,
    window: { from: toIso(start), to: toIso(window.to) },
    step_seconds: stepSeconds,
    clock_window: clock,
    timeout_ms: 10_000,
    max_series: 1000,
  });
  const need = Math.round(rule.for_seconds / stepSeconds);
  const first = Math.round((window.from - start) / stepMs);
  const last = Math.round((window.to - start) / stepMs);
  for (const s of res.series) {
    const label = nameLabels.find((n) => n in s.labels);
    if (label !== undefined && s.labels[label] !== entityName) {
      continue;
    }
    const present = new Set(
      s.times.filter((_, i) => s.values[i] !== null).map((t) => Math.round((t - start) / stepMs)),
    );
    for (let k = first; k <= last; k++) {
      let held = true;
      for (let j = k - need; j <= k && held; j++) {
        held = present.has(j);
      }
      if (held) {
        return true;
      }
    }
  }
  return false;
}
