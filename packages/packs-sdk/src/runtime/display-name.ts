// 组件的可读名称（契约 2.10.0 的 ComponentType.display_name）：只影响显示，组件键不变。
// 按声明顺序尝试，取第一个非空且不等于实体名的值；都没有时返回 null，由调用方显示组件键。
// - alert_annotation、alert_label：实体所在告警的注解或标签；
// - signal + label：在 at 时刻对本包的 metrics 信号做 instant 查询，备选按顺序尝试，取第一条序列的 label 标签。
// 数据源错误只让这一个来源落空，不抛出；名称只用于显示，不能影响研判。

import { ClockWindowViolation, DatasourceError, loadPromqlEngine, toIso } from '@srenautix/integration-sdk';
import type { PackSet } from '../pack/compile.js';
import { renderMetrics, RenderError, type RenderEntity } from '../signals/render.js';
import type { EvidenceDataSource } from './datasource.js';

export interface DisplayNameInput {
  /** 组件类型匹配到的实体 */
  entity: RenderEntity;
  /** 实体所在告警的标签与注解；没有告警时为空对象 */
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** instant 查询的超时 */
const QUERY_TIMEOUT_MS = 5000;
/** 名称查询的回放时钟窗口：at 之前 2 小时 */
const CLOCK_BEFORE_MS = 2 * 3600_000;

export async function resolveDisplayName(
  set: PackSet,
  componentTypeId: string,
  input: DisplayNameInput,
  ds: EvidenceDataSource,
  at: number,
): Promise<string | null> {
  for (const p of set.packs) {
    const ct = p.content.components.component_types.find((t) => t.id === componentTypeId);
    if (!ct) {
      continue;
    }
    const usable = (v: string | undefined): v is string =>
      v !== undefined && v.trim() !== '' && v.trim() !== input.entity.name;
    for (const src of ct.display_name ?? []) {
      if ('alert_annotation' in src) {
        const v = input.annotations[src.alert_annotation];
        if (usable(v)) {
          return v.trim();
        }
      } else if ('alert_label' in src) {
        const v = input.labels[src.alert_label];
        if (usable(v)) {
          return v.trim();
        }
      } else {
        const v = await fromSignal(set, `${p.name}/${src.signal}`, src.label, input.entity, ds, at);
        if (usable(v)) {
          return v.trim();
        }
      }
    }
    return null;
  }
  return null;
}

async function fromSignal(
  set: PackSet,
  key: string,
  label: string,
  entity: RenderEntity,
  ds: EvidenceDataSource,
  at: number,
): Promise<string | undefined> {
  const sig = set.signals.get(key)?.signal;
  const profile = ds.labelProfile;
  if (!sig || sig.kind !== 'metrics' || !profile) {
    return undefined;
  }
  const engine = await loadPromqlEngine();
  const clock = { from: toIso(at - CLOCK_BEFORE_MS), to: toIso(at) };
  for (const alt of sig.alternatives) {
    const dialect = alt.dialect === 'metricsql' ? 'metricsql' : 'promql';
    if (!ds.metricsDialects.has(dialect)) {
      continue;
    }
    try {
      const expr = renderMetrics(engine, alt, { entity, params: {}, windowSeconds: 1800, profile });
      const out = await ds.query({ expr, dialect, time: toIso(at), clock_window: clock, timeout_ms: QUERY_TIMEOUT_MS });
      const v = out.series.map((s) => s.labels[label]).find((x) => x !== undefined && x !== '');
      if (v !== undefined) {
        return v;
      }
    } catch (err) {
      // 数据源错误与渲染失败只让这个备选落空，尝试下一个；其余错误是代码缺陷，照常抛出
      if (!(err instanceof DatasourceError || err instanceof RenderError || err instanceof ClockWindowViolation)) {
        throw err;
      }
    }
  }
  return undefined;
}
