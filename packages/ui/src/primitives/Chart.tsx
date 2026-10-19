// 时间序列图（uPlot）。证据卡的迷你图与成本趋势都用它；阈值画成虚线，无数据区间画成斜纹，
// 注解不叠加在图上（放在 TimelineLane 的单独泳道里）。

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Tone } from './Status';
import styles from './Chart.module.css';

export interface Series {
  /** 秒级时间戳，升序。 */
  t: readonly number[];
  v: ReadonlyArray<number | null>;
}

const TONE_VAR: Record<Tone, string> = {
  ok: '--sn-ok',
  warn: '--sn-warn',
  bad: '--sn-bad',
  info: '--sn-info',
  neutral: '--sn-dim',
  nodata: '--sn-faint',
  model: '--sn-model',
};

const TONE_FILL: Record<Tone, string> = {
  ok: '--sn-ok-soft',
  warn: '--sn-warn-soft',
  bad: '--sn-bad-soft',
  info: '--sn-info-soft',
  neutral: '--sn-raise',
  nodata: '--sn-raise',
  model: '--sn-model-soft',
};

function cssVar(el: HTMLElement, name: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  if (!v) {
    throw new Error(`设计令牌 ${name} 未定义：Chart 必须放在 ThemeRoot 内`);
  }
  return v;
}

/** 无数据区间：相邻两个非空点之间全是 null 的部分。 */
export function gaps(s: Series): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < s.t.length; i++) {
    const missing = s.v[i] === null;
    if (missing && start === null) {
      start = s.t[i]!;
    }
    if (!missing && start !== null) {
      out.push([start, s.t[i]!]);
      start = null;
    }
  }
  if (start !== null) {
    out.push([start, s.t[s.t.length - 1]!]);
  }
  return out;
}

export function Chart({
  series,
  tone = 'info',
  threshold,
  height = 48,
  label,
  axes = false,
}: {
  series: Series;
  tone?: Tone;
  threshold?: number | null;
  height?: number;
  /** 读屏用的一句话描述（图本身对读屏不可见）。 */
  label: string;
  axes?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) {
      return;
    }
    const color = cssVar(el, TONE_VAR[tone]);
    const fill = cssVar(el, TONE_FILL[tone]);
    const line = cssVar(el, '--sn-line');
    const dim = cssVar(el, '--sn-dim');
    const hatch = cssVar(el, '--sn-hatch');
    const blank = gaps(series);
    const opts: uPlot.Options = {
      width: Math.max(80, el.clientWidth),
      height,
      legend: { show: false },
      cursor: { show: axes },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: { x: { time: true } },
      axes: axes
        ? [
            { stroke: dim, grid: { stroke: line, width: 1 }, ticks: { stroke: line } },
            { stroke: dim, grid: { stroke: line, width: 1 }, ticks: { stroke: line }, size: 48 },
          ]
        : [{ show: false }, { show: false }],
      series: [{}, { stroke: color, width: 1.5, fill, spanGaps: false, points: { show: false } }],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            ctx.save();
            for (const [a, b] of blank) {
              const x0 = u.valToPos(a, 'x', true);
              const x1 = u.valToPos(b, 'x', true);
              ctx.fillStyle = hatch;
              ctx.globalAlpha = 0.35;
              ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height);
            }
            ctx.globalAlpha = 1;
            if (threshold !== undefined && threshold !== null) {
              const y = u.valToPos(threshold, 'y', true);
              ctx.strokeStyle = dim;
              ctx.setLineDash([4, 3]);
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, y);
              ctx.lineTo(u.bbox.left + u.bbox.width, y);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
      },
    };
    const data: uPlot.AlignedData = [series.t as number[], series.v as Array<number | null>];
    const plot = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => plot.setSize({ width: Math.max(80, el.clientWidth), height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [series, tone, threshold, height, axes]);
  return <div ref={host} className={styles.chart} role="img" aria-label={label} style={{ minHeight: height }} />;
}
