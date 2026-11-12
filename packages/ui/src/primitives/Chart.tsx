// 时间序列图（uPlot）。一张图画同一个量的一条或多条序列：单条按语气着色并填充，多条按固定顺序取分类色并带图例。
// 阈值画成带数值的虚线，异常时段画成底色，时刻标记（例如告警触发）画成竖线，无数据区间画成斜纹；悬停时十字线对齐到
// 最近的采样点，读数列出该时刻每条序列的值。syncKey 相同的图共用十字线，方便在同一时刻对照几张图。

import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useI18n } from '../i18n';
import { SERIES_SLOTS } from '../theme/tokens';
import type { Tone } from './Status';
import styles from './Chart.module.css';

export interface Series {
  /** 秒级时间戳，升序。 */
  t: readonly number[];
  v: ReadonlyArray<number | null>;
  /** 图例与读数里的名称；只有一条序列时可以不给。 */
  label?: string;
}

/** 图上的时刻标记：一条竖线加一个短标签。 */
export interface ChartMark {
  /** 秒级时间戳。 */
  t: number;
  tone: Tone;
  label: string;
}

/** 图上的时段底色（例如异常起点到窗口结束）；to 为 null 时画到右边界。 */
export interface ChartBand {
  from: number;
  to: number | null;
  tone: Tone;
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

/** 几条序列对齐到同一组时间戳；时间戳本来就相同时不改动（没有采到的点保持 null，画成断开）。 */
function align(list: readonly Series[]): { data: uPlot.AlignedData; joined: boolean } {
  const first = list[0]!;
  const same = list.every((s) => s.t.length === first.t.length && s.t.every((x, i) => x === first.t[i]));
  if (same) {
    return { data: [first.t as number[], ...list.map((s) => s.v as Array<number | null>)], joined: false };
  }
  return {
    data: uPlot.join(list.map((s) => [s.t as number[], s.v as Array<number | null>])),
    joined: true,
  };
}

/** y 轴范围：包含阈值，非负的量从 0 起，上方留一点空。 */
function yRange(min: number | null, max: number | null, threshold: number | null): [number, number] {
  let lo = Math.min(min ?? 0, threshold ?? min ?? 0);
  let hi = Math.max(max ?? 1, threshold ?? max ?? 1);
  if (lo >= 0) {
    lo = 0;
  }
  if (hi <= lo) {
    hi = lo + 1;
  }
  return [lo, hi + (hi - lo) * 0.12];
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

export function Chart({
  series,
  tone = 'info',
  threshold,
  height = 48,
  label,
  axes = false,
  format,
  marks,
  band,
  range,
  syncKey,
}: {
  series: Series | readonly Series[];
  /** 只有一条序列时的颜色；多条序列用分类色。 */
  tone?: Tone;
  threshold?: number | null;
  height?: number;
  /** 读屏用的一句话描述（图本身对读屏不可见）。 */
  label: string;
  axes?: boolean;
  /** 数值的写法（y 轴刻度、阈值、图例与读数）；不给时用紧凑的数字。 */
  format?: (v: number) => string;
  marks?: readonly ChartMark[];
  band?: ChartBand | null;
  /** x 轴范围（秒）；不给时取数据的范围。 */
  range?: readonly [number, number];
  /** 同一个 key 的图共用十字线。 */
  syncKey?: string;
}) {
  const { fmt } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const list = useMemo(() => (Array.isArray(series) ? (series as readonly Series[]) : [series as Series]), [series]);
  const lines = list.slice(0, SERIES_SLOTS);
  const multi = lines.length > 1;
  const show = format ?? ((v: number) => compact.format(v));
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    const el = host.current;
    if (!el || !lines.length) {
      return;
    }
    const colors = multi ? lines.map((_, i) => cssVar(el, `--sn-series-${i + 1}`)) : [cssVar(el, TONE_VAR[tone])];
    const fill = cssVar(el, TONE_FILL[tone]);
    const line = cssVar(el, '--sn-line-soft');
    const dim = cssVar(el, '--sn-dim');
    const hatch = cssVar(el, '--sn-hatch');
    const font = `11px ${cssVar(el, '--sn-font-sans')}`;
    const { data, joined } = align(lines);
    const xs = data[0] as number[];
    // 斜纹只画所有序列都没有数据的区间
    const blank = gaps({ t: xs, v: xs.map((_, i) => (lines.every((_s, k) => data[k + 1]![i] == null) ? null : 1)) });
    const day0 = (range?.[0] ?? xs[0] ?? 0) * 1000;
    const clock = (sec: number) => fmt.clock(sec * 1000, day0);
    const px = (n: number) => Math.round(n * uPlot.pxRatio);

    const tip = document.createElement('div');
    tip.className = styles.tip!;
    tip.hidden = true;
    let inside = false;
    const renderTip = (u: uPlot) => {
      const { idx, left } = u.cursor;
      if (!inside || idx == null || left == null || left < 0) {
        tip.hidden = true;
        return;
      }
      const when = document.createElement('div');
      when.className = styles.tipTime!;
      when.textContent = fmt.dateTime(xs[idx]! * 1000);
      const rows = lines.map((s, i) => {
        const row = document.createElement('div');
        row.className = styles.tipRow!;
        const key = document.createElement('span');
        key.className = styles.key!;
        key.style.background = colors[i] ?? dim;
        const val = document.createElement('strong');
        const v = data[i + 1]![idx];
        val.textContent = v == null ? '–' : showRef.current(v);
        row.append(key, val);
        if (multi) {
          const name = document.createElement('span');
          name.textContent = s.label ?? '';
          row.append(name);
        }
        return row;
      });
      tip.replaceChildren(when, ...rows);
      tip.hidden = false;
      const x = u.over.offsetLeft + left;
      const flip = x + 12 + tip.offsetWidth > el.clientWidth;
      tip.style.left = `${Math.max(0, flip ? x - 12 - tip.offsetWidth : x + 12)}px`;
      tip.style.top = `${u.over.offsetTop + 4}px`;
    };

    const opts: uPlot.Options = {
      width: Math.max(80, el.clientWidth),
      height,
      legend: { show: false },
      cursor: {
        show: axes,
        y: false,
        points: { size: 7 },
        drag: { x: false, y: false },
        ...(syncKey ? { sync: { key: syncKey } } : {}),
      },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: {
        x: { time: true, ...(range ? { range: () => [range[0], range[1]] as uPlot.Range.MinMax } : {}) },
        y: { range: (_u, min, max) => yRange(min, max, threshold ?? null) },
      },
      axes: axes
        ? [
            {
              stroke: dim,
              font,
              grid: { show: false },
              ticks: { stroke: line, width: 1, size: 4 },
              values: (_u, splits) => splits.map(clock),
              space: 72,
              size: 26,
            },
            {
              stroke: dim,
              font,
              grid: { stroke: line, width: 1 },
              ticks: { show: false },
              values: (_u, splits) => splits.map((v) => showRef.current(v)),
              size: 52,
              space: 28,
            },
          ]
        : [{ show: false }, { show: false }],
      series: [
        {},
        ...lines.map((_, i) => ({
          stroke: colors[i]!,
          width: 1.5,
          ...(multi ? {} : { fill }),
          spanGaps: joined,
          points: { show: xs.length < 3 },
        })),
      ],
      hooks: {
        drawClear: [
          (u) => {
            const ctx = u.ctx;
            const { left, top, width, height: h } = u.bbox;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, h);
            ctx.clip();
            if (band) {
              const x0 = Math.max(left, u.valToPos(band.from, 'x', true));
              const x1 = band.to === null ? left + width : Math.min(left + width, u.valToPos(band.to, 'x', true));
              ctx.fillStyle = cssVar(el, TONE_FILL[band.tone]);
              ctx.fillRect(x0, top, Math.max(px(1), x1 - x0), h);
            }
            ctx.fillStyle = hatch;
            ctx.globalAlpha = 0.35;
            for (const [a, b] of blank) {
              const x0 = u.valToPos(a, 'x', true);
              const x1 = u.valToPos(b, 'x', true);
              ctx.fillRect(x0, top, Math.max(1, x1 - x0), h);
            }
            ctx.restore();
          },
        ],
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { left, top, width, height: h } = u.bbox;
            ctx.save();
            ctx.font = `${px(10.5)}px ${cssVar(el, '--sn-font-sans')}`;
            ctx.lineWidth = px(1);
            if (threshold !== undefined && threshold !== null) {
              const y = u.valToPos(threshold, 'y', true);
              ctx.strokeStyle = dim;
              ctx.setLineDash([px(4), px(3)]);
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + width, y);
              ctx.stroke();
              if (axes) {
                ctx.fillStyle = dim;
                ctx.textAlign = 'left';
                ctx.textBaseline = y - top > px(14) ? 'bottom' : 'top';
                ctx.fillText(showRef.current(threshold), left + px(3), y + (y - top > px(14) ? -px(2) : px(2)));
              }
            }
            for (const m of marks ?? []) {
              const x = u.valToPos(m.t, 'x', true);
              if (x < left || x > left + width) {
                continue;
              }
              const c = cssVar(el, TONE_VAR[m.tone]);
              ctx.strokeStyle = c;
              ctx.setLineDash([px(2), px(2)]);
              ctx.beginPath();
              ctx.moveTo(x, top);
              ctx.lineTo(x, top + h);
              ctx.stroke();
              if (axes) {
                const right = x + px(4) + ctx.measureText(m.label).width > left + width;
                ctx.fillStyle = c;
                ctx.textAlign = right ? 'right' : 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(m.label, x + (right ? -px(4) : px(4)), top + px(1));
              }
            }
            ctx.restore();
          },
        ],
        setCursor: [renderTip],
      },
    };
    const plot = new uPlot(opts, data, el);
    el.append(tip);
    const enter = () => {
      inside = true;
    };
    const leave = () => {
      inside = false;
      tip.hidden = true;
    };
    plot.over.addEventListener('pointerenter', enter);
    plot.over.addEventListener('pointerleave', leave);
    const ro = new ResizeObserver(() => plot.setSize({ width: Math.max(80, el.clientWidth), height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
      tip.remove();
    };
    // lines 由 list 派生；show 经 showRef 读取，换格式函数不重建图
  }, [list, tone, threshold, height, axes, marks, band, range, syncKey, fmt]);

  return (
    <figure className={styles.figure}>
      <div ref={host} className={styles.chart} role="img" aria-label={label} style={{ minHeight: height }} />
      {multi && (
        <ul className={styles.legend}>
          {lines.map((s, i) => {
            const peak = s.v.reduce<number | null>((m, v) => (v === null ? m : m === null ? v : Math.max(m, v)), null);
            return (
              <li key={i}>
                <span className={styles.key} style={{ background: `var(--sn-series-${i + 1})` }} />
                <span className={styles.legendName}>{s.label}</span>
                {peak !== null && <span className={styles.legendValue}>{show(peak)}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </figure>
  );
}
