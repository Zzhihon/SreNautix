import type { ChangeEvent, MetricSeries, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { TopologyGraph } from '@srenautix/core';
import { describe, expect, it } from 'vitest';
import { changeNotes } from '../../src/changes/notes.js';
import {
  ARGOCD_REFRESH_TOLERANCE_MS,
  mergeChanges,
  outOfSyncApplications,
  pendingSyncChanges,
} from '../../src/changes/pending-sync.js';
import { deriveRetirements, RETIRE_STEP_MS, type RetireContext, type RetireSeries } from '../../src/changes/retire.js';
import { composeMessage } from '../../src/notify/compose.js';
import { issueMarkdown } from '../../src/notify/markdown.js';
import { incidentBook } from '../../src/research/incident.js';
import { judgeLadder } from '../../src/research/ladder.js';
import { Ledger } from '../../src/research/ledger.js';
import { timeline } from '../../src/stage-a/report.js';
import { releaseRolloutInput } from '../support/report-fixture.js';
import { incident, researchCase } from '../support/scenario.js';

// 退役与已合并、尚未同步的提交（ADR 0161）：从副本数与 up 序列推导退役、找出失去目标的抓取 job 与计划依据；
// 从 argocd_app_info 找出未同步的应用并标出提交；阶段 A 时间线与通知写明计划内退役与尚未同步。
// 序列按 2026-10-25 的形状搭建（名称换成 shop）：store 的三个 StatefulSet 02:51 删除，抓取 job store 的 8 个目标随之消失；
// 02:44 合并了删除 store 定义的提交。

const T = (s: string) => Date.parse(s);
const STEP = RETIRE_STEP_MS;
const FROM = T('2026-10-25T01:00:00Z');
const APP = 'Application.argoproj.io:argocd/store';
const PARENT = 'Application.argoproj.io:argocd/platform-definitions';
const sts = (n: string) => `StatefulSet:shop-data/store-${n}`;

/** [from, to] 上每个步长一个点，取值由 f 给出；f 返回 null 的点没有样本 */
function series(labels: Record<string, string>, to: number, f: (t: number) => number | null): MetricSeries {
  const times: number[] = [];
  const values: Array<number | null> = [];
  for (let t = FROM; t <= to; t += STEP) {
    times.push(t);
    values.push(f(t));
  }
  return { labels, times, values };
}

const node = (key: string): TopologyNode => {
  const kind = key.slice(0, key.indexOf(':'));
  const [ns, name] = key.slice(key.indexOf(':') + 1).split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const edge = (from: string, to: string, relation: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: relation === 'owned_by' ? 'instance' : 'service',
  evidence: 'test',
});

const DELETED = T('2026-10-25T02:51:00Z');
const NOW = T('2026-10-25T03:10:00Z');
const PODS = [
  ['master', 3],
  ['volume', 3],
  ['filer', 2],
] as const;

function retireSeries(o: { other?: boolean; gap?: boolean } = {}): RetireSeries {
  const alive = (t: number) => (t < DELETED ? 1 : null);
  // gap：kube-state-metrics 自己 02:50 之后没有数据，全部副本数序列一起中断
  const ksm = (v: (t: number) => number | null) => (t: number) =>
    o.gap && t > T('2026-10-25T02:50:00Z') ? null : v(t);
  return {
    statefulset: [
      ...PODS.map(([n]) =>
        series(
          { namespace: 'shop-data', statefulset: `store-${n}` },
          NOW,
          ksm((t) => (alive(t) ? 3 : null)),
        ),
      ),
      // 另一个工作负载一直在：kube-state-metrics 本身有数据
      series(
        { namespace: 'shop', statefulset: 'gateway' },
        NOW,
        ksm(() => 4),
      ),
    ],
    // worker 02:30 缩到 0 并保持；api 02:20 缩到 0、02:40 又恢复
    deployment: [
      series(
        { namespace: 'shop', deployment: 'worker' },
        NOW,
        ksm((t) => (t < T('2026-10-25T02:30:00Z') ? 2 : 0)),
      ),
      series(
        { namespace: 'shop', deployment: 'api' },
        NOW,
        ksm((t) => (t >= T('2026-10-25T02:20:00Z') && t < T('2026-10-25T02:40:00Z') ? 0 : 2)),
      ),
    ],
    daemonset: [],
    targets: [
      ...PODS.flatMap(([n, k]) =>
        Array.from({ length: k }, (_, i) =>
          series({ job: 'store', namespace: 'shop-data', pod: `store-${n}-${i}` }, NOW, alive),
        ),
      ),
      // job mixed 的目标是 store-master-0；other 时再加一个 gateway 的 Pod，它就不算随退役失去目标
      series({ job: 'mixed', namespace: 'shop-data', pod: 'store-master-0' }, NOW, alive),
      ...(o.other ? [series({ job: 'mixed', namespace: 'shop', pod: 'gateway-0' }, NOW, alive)] : []),
    ],
  };
}

const podKeys = PODS.flatMap(([n, k]) => Array.from({ length: k }, (_, i) => `Pod:shop-data/store-${n}-${i}`));
const graph = new TopologyGraph(
  [
    ...PODS.map(([n]) => node(sts(n))),
    ...podKeys.map(node),
    node('Pod:shop/gateway-0'),
    node('StatefulSet:shop/gateway'),
  ],
  [
    ...podKeys.map((p) => edge(p, sts(p.split('/')[1]!.split('-')[1]!), 'owned_by')),
    edge('Pod:shop/gateway-0', 'StatefulSet:shop/gateway', 'owned_by'),
  ],
  1,
);
const MANAGED = new Map<string, string[]>([
  ...PODS.map(([n]) => [sts(n), [APP]] as [string, string[]]),
  [APP, [PARENT]],
]);

const commit = (sha: string, time: string, targets: string[], o: Partial<ChangeEvent> = {}): ChangeEvent => ({
  change_id: `ops:${sha}`,
  source: 'ops',
  kind: 'config',
  refs: [sha],
  revision: sha,
  actor: null,
  time,
  link: `https://example.com/ops/commit/${sha}`,
  targets,
  summary: `commit ${sha}`,
  ...o,
});

const ctx = (plans: ChangeEvent[] = [], o: Partial<RetireContext> = {}): RetireContext => ({
  clusterId: 'east',
  from: FROM,
  to: NOW,
  stepMs: STEP,
  groupWithinMs: 2 * 60_000,
  podOwners: async () => (k) => (graph.has(k) ? graph.componentOf(k) : null),
  managers: async (keys) => new Map(keys.flatMap((k) => (MANAGED.has(k) ? [[k, MANAGED.get(k)!]] : []))),
  plans,
  ...o,
});

describe('退役推导（ADR 0161）', () => {
  it('删除的三个 StatefulSet 合成一次退役：目标是管理应用与工作负载，抓取 job store 失去全部 8 个目标', async () => {
    const out = await deriveRetirements(retireSeries(), ctx());
    const store = out.find((c) => c.targets.includes(sts('master')))!;
    expect(store).toMatchObject({
      source: 'kubernetes',
      kind: 'retire',
      refs: [APP],
      time: new Date(DELETED).toISOString(),
      targets: [APP, sts('filer'), sts('master'), sts('volume')],
      scrape_jobs: ['mixed', 'store'],
    });
    expect(store.change_id).toMatch(/^kubernetes:east:retire-[0-9a-f]{16}$/);
    expect(store.summary).toContain('抓取 job store 失去全部 8 个目标');
    expect(store.planned_by).toBeUndefined();
  });

  it('缩到 0 并保持是退役，缩到 0 之后又恢复的不是；同样的输入得到同样的 change_id', async () => {
    const a = await deriveRetirements(retireSeries(), ctx());
    const b = await deriveRetirements(retireSeries(), ctx());
    expect(a).toEqual(b);
    const worker = a.find((c) => c.targets.includes('Deployment:shop/worker'))!;
    expect(worker).toMatchObject({ time: '2026-10-25T02:30:00.000Z', refs: [] });
    expect(worker.summary).toBe('shop/worker 副本缩到 0');
    expect(a.some((c) => c.targets.includes('Deployment:shop/api'))).toBe(false);
  });

  it('kube-state-metrics 整体中断时不推导删除；消失不到 5 分钟时也不推导', async () => {
    const gap = await deriveRetirements(retireSeries({ gap: true }), ctx());
    expect(gap.some((c) => c.kind === 'retire' && c.targets.includes(sts('master')))).toBe(false);
    const early = await deriveRetirements(retireSeries(), ctx([], { to: DELETED + 3 * 60_000 }));
    expect(early.some((c) => c.targets.includes(sts('master')))).toBe(false);
  });

  it('job 的目标里有别的工作负载的 Pod 时，不算随退役失去目标', async () => {
    const out = await deriveRetirements(retireSeries({ other: true }), ctx());
    expect(out.find((c) => c.targets.includes(sts('master')))!.scrape_jobs).toEqual(['store']);
  });

  it('计划依据：24 小时内最近一次触及工作负载、管理应用或上层应用的提交；运行时配置与推导出的变更不算', async () => {
    const plans = [
      commit('282aaaa', '2026-10-24T13:30:40Z', [APP]),
      commit('302bbbb', '2026-10-25T02:44:55Z', [PARENT, 'Application.argoproj.io:argocd/pki']),
      commit('9999999', '2026-10-25T02:50:00Z', [APP], { kind: 'runtime_config' }),
      commit('kkkkkkk', '2026-10-25T02:50:30Z', [APP], { source: 'kubernetes' }),
      commit('unrelat', '2026-10-25T02:49:00Z', ['Application.argoproj.io:argocd/other']),
      commit('later00', '2026-10-25T02:55:00Z', [APP]),
    ];
    const store = (await deriveRetirements(retireSeries(), ctx(plans))).find((c) => c.targets.includes(sts('master')))!;
    expect(store.planned_by).toEqual([
      {
        change_id: 'ops:302bbbb',
        revision: '302bbbb',
        time: '2026-10-25T02:44:55Z',
        link: 'https://example.com/ops/commit/302bbbb',
        summary: 'commit 302bbbb',
      },
    ]);
  });
});

describe('已合并、尚未同步的提交（ADR 0161）', () => {
  const AT = T('2026-10-25T13:40:00Z');
  const LOOKBACK = AT - 72 * 3600_000;
  const app = (name: string, synced: (t: number) => boolean): MetricSeries[] => {
    const s = (status: string, f: (t: number) => boolean) => {
      const times: number[] = [];
      const values: Array<number | null> = [];
      for (let t = LOOKBACK; t <= AT; t += STEP) {
        times.push(t);
        values.push(f(t) ? 1 : null);
      }
      return { labels: { namespace: 'argocd', name, sync_status: status }, times, values };
    };
    return [s('Synced', synced), s('OutOfSync', (t) => !synced(t))];
  };
  const METRICS = 'Application.argoproj.io:argocd/metrics';
  const series = [
    ...app('metrics', (t) => t <= T('2026-10-24T13:31:00Z')),
    ...app('drifted', () => false),
    ...app('fine', () => true),
  ];

  it('OutOfSync 的应用：最后一次 Synced 与之后第一个 OutOfSync 样本；一直未同步的为 null；Synced 的不在其中', () => {
    expect(outOfSyncApplications(series, AT, STEP)).toEqual([
      { application: 'Application.argoproj.io:argocd/drifted', lastSynced: null, outOfSyncSince: null },
      {
        application: METRICS,
        lastSynced: T('2026-10-24T13:31:00Z'),
        outOfSyncSince: T('2026-10-24T13:32:00Z'),
      },
    ]);
  });

  it('只标最后一次 Synced 之前 3 分钟之后合并的、触及这个应用的提交；推导出的变更与之后的提交不标', () => {
    const apps = outOfSyncApplications(series, AT, STEP);
    const changes = [
      commit('old0000', '2026-10-24T13:20:00Z', [METRICS]),
      commit('b3d306e', new Date(T('2026-10-24T13:31:00Z') - ARGOCD_REFRESH_TOLERANCE_MS + 20_000).toISOString(), [
        METRICS,
      ]),
      commit('83e3648', '2026-10-24T18:37:14Z', [METRICS, 'Application.argoproj.io:argocd/drifted']),
      commit('kkkkkkk', '2026-10-24T18:40:00Z', [METRICS], { source: 'kubernetes', kind: 'rollout' }),
      commit('future0', '2026-10-25T16:39:46Z', [METRICS]),
    ];
    const out = pendingSyncChanges(changes, apps, LOOKBACK, AT);
    expect(out.map((c) => [c.change_id, c.pending_sync])).toEqual([
      ['ops:b3d306e', [{ application: METRICS, out_of_sync_since: '2026-10-24T13:32:00.000Z' }]],
      [
        'ops:83e3648',
        [
          { application: 'Application.argoproj.io:argocd/drifted', out_of_sync_since: null },
          { application: METRICS, out_of_sync_since: '2026-10-24T13:32:00.000Z' },
        ],
      ],
    ]);
    const merged = mergeChanges(changes, out);
    expect(merged.map((c) => c.change_id)).toEqual([
      'ops:old0000',
      'ops:b3d306e',
      'ops:83e3648',
      'ops:kkkkkkk',
      'ops:future0',
    ]);
    expect(merged.find((c) => c.change_id === 'ops:83e3648')!.pending_sync).toHaveLength(2);
  });
});

describe('阶段 A 时间线与通知（ADR 0161）', () => {
  const retire: ChangeEvent = {
    change_id: 'kubernetes:acme:retire-0123456789abcdef',
    source: 'kubernetes',
    kind: 'retire',
    refs: ['Application.argoproj.io:argocd/acme-prod'],
    revision: null,
    actor: null,
    time: '2026-10-20T16:20:00.000Z',
    link: null,
    targets: ['Application.argoproj.io:argocd/acme-prod', 'StatefulSet:acme-prod/store'],
    summary: 'acme-prod/store 已删除；抓取 job store 失去全部 3 个目标',
    scrape_jobs: ['store'],
    planned_by: [
      {
        change_id: 'ops:6a701ffc28b19d4b9c85c0716223b40769aa334f',
        revision: '6a701ffc28b19d4b9c85c0716223b40769aa334f',
        time: '2026-10-20T16:10:00.000Z',
        link: 'https://example.com/ops/commit/6a701ff',
        summary: 'retire store (#302)',
      },
    ],
  };
  const pending = (sha: string, time: string): ChangeEvent => ({
    ...commit(sha, time, ['Application.argoproj.io:argocd/acme-prod']),
    pending_sync: [
      { application: 'Application.argoproj.io:argocd/acme-prod', out_of_sync_since: '2026-10-20T15:00:00.000Z' },
    ],
  });

  it('变更的补充说明：计划内退役写依据提交，尚未同步写应用与 OutOfSync 的起点', () => {
    expect(changeNotes(retire).map((n) => n.text)).toEqual(['计划内退役：6a701ffc28b1 retire store (#302)']);
    expect(changeNotes(pending('83e3648', '2026-10-20T15:30:00.000Z')).map((n) => n.text)).toEqual([
      '已合并、尚未同步到 argocd/acme-prod（2026-10-20T15:00:00.000Z 起 OutOfSync）',
    ]);
  });

  it('阶段 A 时间线的变更行带上补充说明', () => {
    const input = releaseRolloutInput();
    const inc = { ...input.incident, changes: [retire] };
    const line = timeline(inc, [], []).find((x) => x.kind === 'change')!;
    expect(line.text).toBe(
      'kubernetes retire Application.argoproj.io:argocd/acme-prod；计划内退役：6a701ffc28b1 retire store (#302)',
    );
  });

  it('消息：计划内退役写成"计划内退役 <提交>"并链接到提交；未同步的提交合成一句', () => {
    const input = releaseRolloutInput();
    const changes = [
      retire,
      pending('83e3648', '2026-10-20T15:30:00.000Z'),
      pending('6a701ff', '2026-10-20T15:40:00.000Z'),
    ];
    const { message } = composeMessage({ ...input, incident: { ...input.incident, changes } });
    const md = issueMarkdown(message, '<!-- x -->', 'footer').body;
    expect(md).toContain('计划内退役 6a701ffc28b1');
    expect(md).toContain('https://example.com/ops/commit/6a701ff');
    expect(md).toContain('retire store \\(\\#302\\)');
    expect(md).toContain('2 个已合并、尚未同步的提交 `83e3648 6a701ff`（15:30）');
    expect(md).toContain('config 83e3648（已合并、尚未同步）');
  });
});

describe('退役变更作为研判的支持证据（ADR 0161）', () => {
  const WEB = 'Deployment:shop/web';
  const retire: ChangeEvent = {
    change_id: 'kubernetes:test:retire-0123456789abcdef',
    source: 'kubernetes',
    kind: 'retire',
    refs: [],
    revision: null,
    actor: null,
    time: incident().first_firing_at,
    link: null,
    targets: [WEB],
    summary: 'shop/web 已删除',
    scrape_jobs: ['web'],
  };
  const hyp = { id: 'h1', parent_id: null, root_component: WEB, mechanism: 'web 被退役', supporting: [], refuting: [] };
  const ledgerOf = (changes: ChangeEvent[], related: ChangeEvent[] = []) => {
    const base = incident();
    const rc = researchCase({ incident: { ...base, changes }, relatedChanges: related });
    const ledger = new Ledger(incidentBook(rc), rc.subgraph);
    ledger.merge([hyp], []);
    ledger.evaluate();
    return { ledger, rc, h1: ledger.entries.get('h1')! };
  };

  it('事件里的退役变更支持根因是它的候选的假设：没有异常卡也是 supported，档位 likely，supporting 列出变更', () => {
    const { ledger, rc, h1 } = ledgerOf([retire]);
    expect(ledger.supportChanges(h1)).toEqual(['change:1']);
    expect(h1.status).toBe('supported');
    const r = judgeLadder(ledger, h1, rc.incident, true);
    expect(r.level).toBe('likely');
    expect(r.notes).toEqual(['假设 h1 只有退役变更支持（change:1），没有范围内的异常卡']);
    expect(ledger.toContract()[0]!.supporting).toEqual(['change:1']);
    expect(ledger.leaderSettled(ledger.ranked()[0])).toBe(false);
  });

  it('不在事件里的相关变更、其他类型的变更、候选是别的组件的退役都不支持', () => {
    expect(ledgerOf([], [retire]).ledger.supportChanges(ledgerOf([], [retire]).h1)).toEqual([]);
    const other = ledgerOf([{ ...retire, kind: 'rollout' }]);
    expect(other.ledger.supportChanges(other.h1)).toEqual([]);
    const managed = ledgerOf([{ ...retire, refs: ['Application.argoproj.io:argocd/shop'] }]);
    expect(managed.ledger.supportChanges(managed.h1)).toEqual([]);
  });
});
