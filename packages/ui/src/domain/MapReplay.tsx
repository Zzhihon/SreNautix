// 地图回放（ADR 0205）：画在地图上方的时间轴。直方图是每一格结束时仍在触发的事件数（严重与其余分开叠放），上方一行标出
// 这一格里新触发的事件（长期不恢复的事件让直方图几乎是平的，新触发的事件才是值得回放的时刻），
// 下方一行是这一格里的变更，按发布、配置、容量、其他着色（ADR 0206）：先变更、后出事的时刻在两行之间一眼对得上。
// 拖动滑块、点直方图或逐格播放选出时刻，宿主按这个时刻取 /v1/topology/map?at 并照常画地图；选到最右一格即回到"现在"。
// 时刻对齐到格子边界，同一时刻的地图请求可以命中缓存。

import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useMemo, type MouseEvent } from 'react';
import type { ClusterMapTimeline } from '../contract';
import { useI18n } from '../i18n';
import { CHANGE_GROUPS, changeGroup, type ChangeGroup } from './cluster-map-model';
import { MapChangeList } from './MapChanges';
import styles from './MapReplay.module.css';

type TimelineIncident = ClusterMapTimeline['incidents'][number];

/** 一格的时长：24 小时 96 格 */
export const REPLAY_STEP_MS = 15 * 60_000;
/** 播放时每格停留的时长 */
export const REPLAY_FRAME_MS = 1200;

export interface ReplayBucket {
  /** 格子结束的时刻（毫秒） */
  at: number;
  critical: number;
  other: number;
  /** 这一格里新触发的事件数，与其中严重的个数 */
  started: number;
  startedCritical: number;
  /** 这一格里的变更，按分组计数 */
  changes: Record<ChangeGroup, number>;
}

/** [from, to] 按 step 切格，每格结束时仍在触发的事件数与这一格里的变更；最后一格结束在 to */
export function firingBuckets(
  incidents: readonly TimelineIncident[],
  changes: ClusterMapTimeline['changes'],
  from: number,
  to: number,
  step = REPLAY_STEP_MS,
): ReplayBucket[] {
  const n = Math.max(1, Math.ceil((to - from) / step));
  const out: ReplayBucket[] = [];
  for (let i = 1; i <= n; i++) {
    const at = Math.min(to, from + i * step);
    out.push({
      at,
      critical: 0,
      other: 0,
      started: 0,
      startedCritical: 0,
      changes: { release: 0, config: 0, capacity: 0, other: 0 },
    });
  }
  for (const c of changes) {
    const t = Date.parse(c.time);
    const i = Math.ceil((t - from) / step) - 1;
    if (t > from && t <= to) {
      out[Math.min(out.length - 1, Math.max(0, i))]!.changes[changeGroup(c.kind)]++;
    }
  }
  for (const inc of incidents) {
    const start = Date.parse(inc.first_firing_at);
    const end = inc.ended_at ? Date.parse(inc.ended_at) : Number.POSITIVE_INFINITY;
    for (const [i, b] of out.entries()) {
      const begin = i === 0 ? from : out[i - 1]!.at;
      if (start > begin && start <= b.at) {
        b.started++;
        if (inc.severity === 'critical') {
          b.startedCritical++;
        }
      }
      if (start <= b.at && end > b.at) {
        if (inc.severity === 'critical') {
          b.critical++;
        } else {
          b.other++;
        }
      }
    }
  }
  return out;
}

export interface MapReplayProps {
  timeline: ClusterMapTimeline;
  /** 正在看的时刻；null 为现在 */
  at: string | null;
  playing: boolean;
  onChange: (at: string | null) => void;
  onPlayingChange: (playing: boolean) => void;
}

export function MapReplay({ timeline, at, playing, onChange, onPlayingChange }: MapReplayProps) {
  const { t, fmt } = useI18n();
  const from = Date.parse(timeline.from);
  const to = Date.parse(timeline.to);
  const buckets = useMemo(
    () => firingBuckets(timeline.incidents, timeline.changes, from, to),
    [timeline.incidents, timeline.changes, from, to],
  );
  const last = buckets.length - 1;
  const atMs = at ? Date.parse(at) : null;
  // 当前格：时刻落在哪一格的结束上；现在是最后一格
  const index =
    atMs === null
      ? last
      : Math.max(
          0,
          Math.min(
            last,
            buckets.findIndex((b) => b.at >= atMs),
          ),
        );
  const select = (i: number) => onChange(i >= last ? null : new Date(buckets[i]!.at).toISOString());

  // 播放：每 REPLAY_FRAME_MS 前进一格，到现在为止；从现在开始播放时从最左一格开始。只随播放状态与当前格重新计时，
  // 宿主取地图引起的重绘不推迟下一格
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setTimeout(() => {
      if (index >= last) {
        onPlayingChange(false);
        return;
      }
      select(index + 1);
    }, REPLAY_FRAME_MS);
    return () => clearTimeout(timer);
  }, [playing, index]);

  const peak = Math.max(1, ...buckets.map((b) => b.critical + b.other));
  const W = 960;
  /** 上方新触发标记、中间直方图、下方变更行的高度 */
  const MARK = 8;
  const LANE = 12;
  const H = 48 + LANE;
  const BARS = H - LANE - 2;
  const bw = W / buckets.length;
  const onBars = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    select(Math.max(0, Math.min(last, Math.floor(((e.clientX - r.left) / r.width) * buckets.length))));
  };
  const cur = buckets[index]!;
  const slotStart = index === 0 ? from : buckets[index - 1]!.at;
  const slotChanges = timeline.changes
    .filter((c) => Date.parse(c.time) > slotStart && Date.parse(c.time) <= cur.at)
    .reverse();
  return (
    <div className={styles.replay} data-live={atMs === null ? '' : undefined}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.btn}
          aria-pressed={playing}
          onClick={() => {
            if (!playing && index >= last) {
              select(0);
            }
            onPlayingChange(!playing);
          }}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {playing ? t('map.replay.pause') : t('map.replay.play')}
        </button>
        <button
          type="button"
          className={styles.btn}
          aria-label={t('map.replay.back')}
          disabled={index === 0}
          onClick={() => select(index - 1)}
        >
          <SkipBack aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.btn}
          aria-label={t('map.replay.forward')}
          disabled={index >= last}
          onClick={() => select(index + 1)}
        >
          <SkipForward aria-hidden="true" />
        </button>
        <span className={styles.at} role="status">
          {atMs === null
            ? t('map.replay.live')
            : t('map.replay.at', {
                at: fmt.clock(cur.at),
                n: cur.critical + cur.other,
                started: cur.started,
                changes: CHANGE_GROUPS.reduce((n, g) => n + cur.changes[g], 0),
              })}
        </span>
        {atMs !== null && (
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              onPlayingChange(false);
              onChange(null);
            }}
          >
            {t('map.replay.now')}
          </button>
        )}
        {timeline.truncated && <span className={styles.note}>{t('map.replay.truncated')}</span>}
        {timeline.changes_status !== 'ok' && (
          <span className={styles.note}>{t(`map.replay.changes_${timeline.changes_status}`)}</span>
        )}
        <span className={styles.groups} aria-hidden="true">
          {CHANGE_GROUPS.map((g) => (
            <span key={g}>
              <i data-group={g} />
              {t(`map.change_group.${g}`)}
            </span>
          ))}
        </span>
      </div>
      <svg
        className={styles.bars}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        onClick={onBars}
      >
        {buckets.map((b, i) => {
          const hc = (b.critical / peak) * (BARS - MARK - 2);
          const ho = (b.other / peak) * (BARS - MARK - 2);
          const groups = CHANGE_GROUPS.filter((g) => b.changes[g] > 0);
          return (
            <g key={b.at}>
              {b.started > 0 && (
                <rect
                  className={b.startedCritical > 0 ? styles.critical : styles.other}
                  x={i * bw + bw / 2 - 2}
                  y={0}
                  width={4}
                  height={MARK - 2}
                  rx={1}
                />
              )}
              {ho > 0 && <rect className={styles.other} x={i * bw + 0.5} y={BARS - ho} width={bw - 1} height={ho} />}
              {hc > 0 && (
                <rect className={styles.critical} x={i * bw + 0.5} y={BARS - ho - hc} width={bw - 1} height={hc} />
              )}
              {groups.map((g, j) => (
                <rect
                  key={g}
                  className={styles.change}
                  data-group={g}
                  x={i * bw + 0.5}
                  y={BARS + 2 + (j * LANE) / groups.length}
                  width={bw - 1}
                  height={LANE / groups.length - 0.5}
                />
              ))}
            </g>
          );
        })}
        <rect className={styles.cursor} x={index * bw} y={0} width={Math.max(bw, 2)} height={H} />
      </svg>
      <input
        type="range"
        className={styles.range}
        min={0}
        max={last}
        step={1}
        value={index}
        aria-label={t('map.replay.slider')}
        aria-valuetext={atMs === null ? t('map.replay.live') : fmt.dateTime(cur.at)}
        onChange={(e) => {
          onPlayingChange(false);
          select(Number(e.target.value));
        }}
      />
      <div className={styles.ticks} aria-hidden="true">
        <span>{fmt.clock(from)}</span>
        <span>{fmt.clock(from + (to - from) / 2)}</span>
        <span>{t('map.replay.live')}</span>
      </div>
      {slotChanges.length > 0 && (
        <div className={styles.slot}>
          <span className={styles.slotTitle}>
            {t('map.replay.slot_changes', { from: fmt.clock(slotStart), to: fmt.clock(cur.at) })}
          </span>
          <MapChangeList changes={slotChanges} />
        </div>
      )}
    </div>
  );
}
