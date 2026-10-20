import { resolve } from 'node:path';
import { changeInputFrom, DEFAULT_RCA_PARAMS, MAX_CHANGE_LOOKBACK_MS } from '@srenautix/core';
import { describe, expect, it } from 'vitest';
import { readBundle } from '../../src/eval/bundle.js';
import { discoveryCase } from '../../src/eval/discovery.js';
import { loadLabels } from '../../src/eval/labels.js';
import { replay } from '../../src/eval/reconstruct.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackRuntime } from '../../src/stage-a/packs.js';
import { PACKS } from '../support/packs.js';

/**
 * 发布收敛的回归（ADR 0104）：一次真实发布事故的重建包（脱敏、只保留发布涉及的命名空间，test/fixtures/eval/），
 * 按 eval 的重建方式每 30 秒重算事件。发布在 16:24:25 回退，回退出的 Pod 卡在等待迁移，18:37 再次发布替换了 Pod。
 * 之前的结果是 3 个事件：发布一小时后离开了变更输入，已经归到它的无对象发布告警被拆出去；新版本替换 Pod 之后，
 * 旧 Pod 上仍在回看窗口内的告警找不到属主，也被拆出去。
 */
const FIXTURES = resolve(import.meta.dirname, '../fixtures/eval');

describe('发布事故的重建', () => {
  it('收敛为一个事件，根因是发布的目标，发布告警与回退出的 Pod 告警都在其中', async () => {
    const label = loadLabels(resolve(FIXTURES, 'labels.yaml')).labels[0]!;
    const rt = await PackRuntime.load({
      dirs: [PACKS],
      only: null,
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
    });
    const r = await replay(
      readBundle(FIXTURES, label.id),
      Date.parse(label.window.to),
      {
        rt,
        params: rt.rcaParams(),
        revisionLabels: ['app.kubernetes.io/version', 'helm.sh/chart', 'acme.io/release-id'],
        groupWithinMs: 120_000,
        stepMs: 30_000,
      },
      Date.parse(label.as_of),
    );
    const d = discoveryCase(r, label);
    expect(d.incidents).toBe(1);
    expect(d.main_root).toBe('Application.argoproj.io:argocd/acme-prod');
    expect(d.root_hit).toBe(true);
  }, 120_000);
});

describe('变更输入的起点', () => {
  const now = Date.parse('2026-10-20T17:30:00Z');
  const p = DEFAULT_RCA_PARAMS;
  const reach = p.changeWindowMs + p.adjacencyMs;

  it('从最早的可见告警往前一个窗口；没有更早的告警时就是现在往前一个窗口', () => {
    expect(changeInputFrom([], now, p)).toBe(now - reach);
    expect(changeInputFrom([{ starts_at: '2026-10-20T16:50:00Z' }], now, p)).toBe(
      Date.parse('2026-10-20T16:50:00Z') - reach,
    );
  });

  it('长期触发的告警不会让输入回看超过 24 小时', () => {
    expect(changeInputFrom([{ starts_at: '2026-10-18T00:00:00Z' }], now, p)).toBe(now - MAX_CHANGE_LOOKBACK_MS);
  });
});
