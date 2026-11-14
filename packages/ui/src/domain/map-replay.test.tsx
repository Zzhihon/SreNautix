import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ClusterMapTimeline } from '../contract';
import { renderUi } from '../test/render';
import { firingBuckets, MapReplay, REPLAY_STEP_MS } from './MapReplay';

const FROM = Date.parse('2026-11-13T00:00:00Z');
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const inc = (n: number, severity: 'critical' | 'warning', start: number, end: number | null) => ({
  incident_id: `00000000-0000-4000-8000-00000000000${n}`,
  label: `inc-${n}`,
  severity,
  first_firing_at: iso(start),
  ended_at: end === null ? null : iso(end),
  service: null,
});
const timeline: ClusterMapTimeline = {
  from: iso(FROM),
  to: iso(FROM + 2 * H),
  truncated: false,
  incidents: [inc(1, 'critical', FROM + 10 * 60_000, FROM + 40 * 60_000), inc(2, 'warning', FROM - H, null)],
};

describe('地图回放（ADR 0205）', () => {
  it('每格结束时仍在触发的事件数，严重与其余分开', () => {
    const b = firingBuckets(timeline.incidents, FROM, FROM + 2 * H);
    expect(b).toHaveLength((2 * H) / REPLAY_STEP_MS);
    expect(b.slice(0, 4).map((x) => [iso(x.at).slice(11, 16), x.critical, x.other, x.started])).toEqual([
      ['00:15', 1, 1, 1],
      ['00:30', 1, 1, 0],
      ['00:45', 0, 1, 0],
      ['01:00', 0, 1, 0],
    ]);
    // 不满一格时最后一格结束在 to
    expect(iso(firingBuckets([], FROM, FROM + 20 * 60_000).at(-1)!.at)).toBe(iso(FROM + 20 * 60_000));
  });

  it('滑块选出格子的结束时刻，最右一格回到现在；回放时写出时刻与触发数', () => {
    const changes: Array<string | null> = [];
    const view = renderUi(
      <MapReplay
        timeline={timeline}
        at={null}
        playing={false}
        onChange={(a) => changes.push(a)}
        onPlayingChange={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('现在');
    const slider = screen.getByRole('slider', { name: '回放时刻' });
    fireEvent.change(slider, { target: { value: '1' } });
    expect(changes).toEqual([iso(FROM + 30 * 60_000)]);
    view.rerender(
      <MapReplay
        timeline={timeline}
        at={iso(FROM + 30 * 60_000)}
        playing={false}
        onChange={(a) => changes.push(a)}
        onPlayingChange={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(
      /^正在看 .* 的地图 · 2 个事件在触发，这 15 分钟新触发 0 个$/,
    );
    fireEvent.change(screen.getByRole('slider', { name: '回放时刻' }), { target: { value: '7' } });
    expect(changes.at(-1)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回到现在' }));
    expect(changes.at(-1)).toBeNull();
  });
});
