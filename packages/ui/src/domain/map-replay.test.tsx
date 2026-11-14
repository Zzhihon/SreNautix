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
const change = (n: number, kind: ClusterMapTimeline['changes'][number]['kind'], at: number) => ({
  change_id: `kubernetes:c${n}`,
  kind,
  source: 'kubernetes',
  time: iso(at),
  summary: `change ${n} <b>raw</b>`,
  link: n === 1 ? 'https://github.com/o/r/commit/abc' : 'javascript:alert(1)',
  revision: 'abcdef0123456789',
  actor: null,
  components: ['Deployment:shop/api'],
});
const timeline: ClusterMapTimeline = {
  from: iso(FROM),
  to: iso(FROM + 2 * H),
  truncated: false,
  incidents: [inc(1, 'critical', FROM + 10 * 60_000, FROM + 40 * 60_000), inc(2, 'warning', FROM - H, null)],
  changes_status: 'ok',
  changes: [
    change(1, 'rollout', FROM + 5 * 60_000),
    change(2, 'config', FROM + 8 * 60_000),
    change(3, 'scale', FROM + 50 * 60_000),
  ],
};

describe('地图回放（ADR 0205）', () => {
  it('每格结束时仍在触发的事件数，严重与其余分开', () => {
    const b = firingBuckets(timeline.incidents, timeline.changes, FROM, FROM + 2 * H);
    expect(b).toHaveLength((2 * H) / REPLAY_STEP_MS);
    expect(b.slice(0, 4).map((x) => [iso(x.at).slice(11, 16), x.critical, x.other, x.started])).toEqual([
      ['00:15', 1, 1, 1],
      ['00:30', 1, 1, 0],
      ['00:45', 0, 1, 0],
      ['01:00', 0, 1, 0],
    ]);
    // 不满一格时最后一格结束在 to
    expect(iso(firingBuckets([], [], FROM, FROM + 20 * 60_000).at(-1)!.at)).toBe(iso(FROM + 20 * 60_000));
    // 变更行：按格、按分组计数
    expect(b[0]!.changes).toEqual({ release: 1, config: 1, capacity: 0, other: 0 });
    expect(b[3]!.changes).toEqual({ release: 0, config: 0, capacity: 1, other: 0 });
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
      /^正在看 .* 的地图 · 2 个事件在触发，这 15 分钟新触发 0 个、变更 0 个$/,
    );
    fireEvent.change(screen.getByRole('slider', { name: '回放时刻' }), { target: { value: '7' } });
    expect(changes.at(-1)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回到现在' }));
    expect(changes.at(-1)).toBeNull();
  });
});

describe('时间轴上的变更（ADR 0206）', () => {
  it('选中的一格列出它的变更：摘要只作文本，只有 http(s) 链接可点', () => {
    renderUi(
      <MapReplay
        timeline={timeline}
        at={iso(FROM + 15 * 60_000)}
        playing={false}
        onChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/新触发 1 个、变更 2 个$/);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('配置change 2 <b>raw</b>abcdef012345'),
      expect.stringContaining('发布change 1 <b>raw</b>abcdef012345打开'),
    ]);
    expect(screen.getAllByRole('link', { name: '打开' }).map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/o/r/commit/abc',
    ]);
  });

  it('读取变更失败时说明', () => {
    renderUi(
      <MapReplay
        timeline={{ ...timeline, changes: [], changes_status: 'unavailable' }}
        at={null}
        playing={false}
        onChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );
    expect(screen.getByText('读取变更失败，时间轴上没有变更行')).toBeTruthy();
  });
});
