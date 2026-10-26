import type { EvidenceResult, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { TopologyGraph } from '@srenautix/core';
import { describe, expect, it } from 'vitest';
import { renderCard, ButtonSigner, renderExternalDigestCard } from '../../src/channels/feishu/render.js';
import { MAX_ENTITIES, MAX_TEXT_UNITS } from '../../src/channels/telegram/html.js';
import { renderExternalDigest, renderIncident, type TelegramPayload } from '../../src/channels/telegram/render.js';
import { composeMessage, type ComposeInput } from '../../src/notify/compose.js';
import {
  composeExternalDigest,
  dependencyPath,
  externalTypeLookup,
  impactLine,
  lastWindow,
  matchesLabels,
  type ExternalWindowStats,
} from '../../src/notify/external.js';
import { feishuButtonKey } from '../../src/notify/index.js';
import { issueMarkdown } from '../../src/notify/markdown.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';
import { businessSignals, categoryOf, nearThreshold, valueNumber } from '../../src/notify/signals.js';
import { gatewayOomInput } from '../support/gateway-oom-fixture.js';
import { releaseRolloutInput } from '../support/report-fixture.js';
import { parseTelegramHtml } from '../support/telegram-html.js';

const CHAT = { channel: 'telegram' as const, chat: '-1001234567890', language: 'zh' as const };

function desired(input: ComposeInput): DesiredIncidentMessage {
  const { message, targets } = composeMessage(input);
  const inc = input.incident;
  return {
    incidentId: inc.incident_id,
    clusterId: inc.cluster_id,
    label: inc.label,
    severity: inc.severity,
    state: inc.state,
    firstFiringAt: new Date(inc.first_firing_at),
    endedAt: null,
    lane: 'urgent',
    message,
    targets,
    language: 'zh',
  };
}

/** Bot API 的 HTML 严格解析：不合法时抛出（对应 400 can't parse entities），长度与实体数不超过上限 */
function strict(p: TelegramPayload): ReturnType<typeof parseTelegramHtml> {
  expect(p.parse_mode).toBe('HTML');
  const r = parseTelegramHtml(p.text);
  expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
  expect(r.entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
  return r;
}

function inOrder(text: string, parts: string[]): void {
  let last = -1;
  for (const s of parts) {
    const i = text.indexOf(s, last + 1);
    expect(i, `${s} 缺失或顺序不对：\n${text}`).toBeGreaterThan(last);
    last = i;
  }
}

const card = (over: Partial<EvidenceResult>): EvidenceResult =>
  ({
    ref: 'card:1',
    card_id: 'x/y/z',
    title: { 'zh-CN': 't', en: 't' },
    threshold: null,
    series: [],
    entity: null,
    window: { from: '2026-10-23T00:00:00Z', to: '2026-10-23T00:10:00Z' },
    verdict: 'normal',
    display_state: 'normal',
    reason: { kind: 'all_clear', text: '' },
    value: null,
    table: null,
    queries: [],
    egress: 'allow',
    evaluated_at: '2026-10-23T00:10:00Z',
    ...over,
  }) as EvidenceResult;

describe('业务关键信号：类别与接近阈值（ADR 0148）', () => {
  it('卡片定义的 category 优先；没有时按卡片 id、再按证据链 id 推断', () => {
    expect(categoryOf({ card_id: 'workload/capacity/hpa-latency', category: 'traffic' })).toBe('traffic');
    expect(categoryOf({ card_id: 'workload/capacity/hpa-latency', category: null })).toBe('cpu');
    expect(categoryOf({ card_id: 'cchp/provider/error-ratio', category: null })).toBe('traffic');
    expect(categoryOf({ card_id: 'cchp/provider/ttft', category: null })).toBe('traffic');
    expect(categoryOf({ card_id: 'cchp/cache/memory', category: null })).toBe('memory');
    expect(categoryOf({ card_id: 'cchp/capacity/memory-available', category: null })).toBe('memory');
    expect(categoryOf({ card_id: 'cchp/db-backup/freshness', category: null })).toBe('storage');
    expect(categoryOf({ card_id: 'cchp/seaweedfs/slots', category: null })).toBe('storage');
    expect(categoryOf({ card_id: 'cchp/db-saturation/waits', category: null })).toBe('blocking');
    expect(categoryOf({ card_id: 'cchp/edge/error-split', category: null })).toBe('traffic');
    // 资源 requests 不是请求量；重启与就绪不属于五类
    expect(categoryOf({ card_id: 'cchp/capacity/requests', category: null })).toBeNull();
    expect(categoryOf({ card_id: 'workload/pod-restarts/restarts', category: null })).toBeNull();
    expect(categoryOf({ card_id: 'workload/pod-restarts/readiness', category: null })).toBeNull();
    // 区分性检查的卡只看 category
    expect(categoryOf({ card_id: 'check/h1/1', category: null })).toBeNull();
    expect(categoryOf({ card_id: 'check/h1/1', category: 'memory' })).toBe('memory');
  });

  it('正常卡的主值不低于阈值的 80% 且低于阈值时接近阈值；旧结果从百分比展示文本还原数值', () => {
    expect(nearThreshold(card({ value_number: 0.75, threshold: 0.9 }))).toBe(true);
    expect(nearThreshold(card({ value_number: 0.7, threshold: 0.9 }))).toBe(false);
    expect(nearThreshold(card({ value_number: 0.95, threshold: 0.9 }))).toBe(false);
    expect(nearThreshold(card({ value_number: 0.85, threshold: 0.9, verdict: 'abnormal' }))).toBe(false);
    expect(valueNumber({ value: '96.5%', unit: 'percent' })).toBeCloseTo(0.965);
    expect(valueNumber({ value: '12', unit: 'count' })).toBe(12);
    expect(valueNumber({ value: '1.2 s', unit: 'seconds' })).toBeNull();
    expect(nearThreshold(card({ value: '80.0%', unit: 'percent', threshold: 0.9 }))).toBe(true);
  });

  it('同一对象上同一张卡只保留一项，异常的优先；类别按存储、内存、CPU、流量负载、阻塞排列', () => {
    const items = businessSignals([
      card({ ref: 'card:1', card_id: 'workload/rollout/statefulset', category: 'blocking', verdict: 'abnormal' }),
      card({
        ref: 'card:2',
        card_id: 'workload/pod-restarts/memory',
        category: 'memory',
        value_number: 0.8,
        threshold: 0.9,
      }),
      card({
        ref: 'card:3',
        card_id: 'workload/pod-restarts/memory',
        category: 'memory',
        verdict: 'abnormal',
        value_number: 0.95,
        threshold: 0.9,
      }),
      card({ ref: 'card:4', card_id: 'node/node-filesystem/space', category: 'storage', verdict: 'abnormal' }),
    ]);
    expect(items.map((s) => [s.category, s.card.ref, s.near])).toEqual([
      ['storage', 'card:4', false],
      ['memory', 'card:3', false],
      ['blocking', 'card:1', false],
    ]);
  });
});

describe('事件消息的业务关键信号：gateway OOM（cchp-k8s-ops#249 那一类，黄金用例）', () => {
  const input = () => gatewayOomInput(releaseRolloutInput());

  it('卡片组合与 #249 那次相同：70 个成员告警、53 张卡', () => {
    const i = input();
    expect(i.incident.members).toHaveLength(70);
    expect(i.stageA!.cards).toHaveLength(53);
  });

  it('Telegram：业务关键信号在现状之后、关键问题之前，内存一类第一项是 gateway 94% 与 OOM', async () => {
    const r = renderIncident(CHAT, desired(input()), [], null, { callbacks: true });
    const p = r.payload as TelegramPayload;
    const { text, entities } = strict(p);
    await expect(p.text).toMatchFileSnapshot('../fixtures/report/gateway-oom-2026-10-23.telegram.html');
    inOrder(text, ['现状', '业务关键信号', '时间线（UTC，10-23）', '关键问题', '证据链']);
    const section = text.slice(text.indexOf('业务关键信号'), text.indexOf('时间线（UTC'));
    const lines = section.split('\n').filter((l) => l.startsWith('- '));
    const memory = lines.filter((l) => l.startsWith('- 内存：'));
    expect(memory[0]).toContain('gateway 内存占 limit 与 OOM 94.0% / 阈值 90.0%');
    expect(memory[0]).toContain('2 个容器被 OOM 终止');
    // 内存一类：gateway 与 gateway-2 异常，gateway-1 接近阈值（75.4% ≥ 90% × 0.8）在其余中
    expect(memory[1]).toContain('gateway-2');
    expect(section).toContain('其余：内存 1 项');
    // 流量负载：边缘 5xx 0.4% 接近 0.5% 的阈值；阻塞：StatefulSet 发布停在未就绪的副本上
    expect(lines.some((l) => l.startsWith('- 流量负载：gateway 5xx 来自哪一层 0.4%') && l.includes('接近阈值'))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith('- 阻塞：gateway StatefulSet 发布 1') && l.includes('未就绪'))).toBe(true);
    // 不属于五类的卡（重启、就绪、终止原因、连接池）与正常且不接近阈值的卡不在这一段
    expect(section).not.toContain('重启与终止原因');
    expect(section).not.toContain('应用就绪与数据库连接池');
    expect(section).not.toContain('CPU：');
    expect(section).not.toContain('存储：');
    // 标题粗体，数值与阈值等宽
    const bold = entities.filter((e) => e.type === 'bold').map((e) => text.slice(e.offset, e.offset + e.length));
    expect(bold).toContain('业务关键信号');
    const code = entities.filter((e) => e.type === 'code').map((e) => text.slice(e.offset, e.offset + e.length));
    expect(code).toEqual(expect.arrayContaining(['94.0%', '90.0%', '0.4%']));
  });

  it('issue 与飞书保持同样的结构', () => {
    const { message } = composeMessage(input());
    const md = issueMarkdown(message, '<!-- x -->', 'footer').body;
    inOrder(md, ['## 现状', '## 业务关键信号', '## 关键问题']);
    // issue 是全文：内存一类的第三项也在
    expect(md).toContain('内存：gateway-1 内存占 limit 与 OOM `75.4%` / 阈值 `90.0%` · 接近阈值');
    const card = renderCard(
      { channel: 'feishu', chat: 'oc_x', language: 'zh' },
      desired(input()),
      [],
      null,
      { callbacks: true },
      new ButtonSigner(feishuButtonKey('test-app-secret')),
    );
    const json = JSON.stringify(card.payload);
    inOrder(json, ['现状', '业务关键信号', '关键问题']);
    expect(json).toContain('gateway 内存占 limit 与 OOM `94.0%`');
  });

  it('没有异常或接近阈值的信号时不出现这一段', () => {
    const i = input();
    i.stageA!.cards = i.stageA!.cards.map((c) => ({
      ...c,
      verdict: 'normal',
      display_state: 'normal',
      value_number: 0,
    }));
    const { message } = composeMessage(i);
    expect(message.sections.some((s) => s.kind === 'signals')).toBe(false);
  });
});

const W0 = '2026-10-24T10:00:00.000Z';
const W1 = '2026-10-24T11:00:00.000Z';
const provider = (
  id: string,
  name: string,
  over: Partial<ExternalWindowStats['roots'][number]> = {},
): ExternalWindowStats['roots'][number] => ({
  root: `provider:${id}`,
  name,
  incidents: 1,
  triggers: 2,
  alertnames: ['CCHPProviderErrorRatioHigh'],
  severity: 'warning',
  firing: true,
  ended_at: null,
  first_at: '2026-10-24T10:05:00.000Z',
  immediate: false,
  values: [
    {
      card_id: 'cchp/provider/error-ratio',
      title: { 'zh-CN': 'provider 故障率', en: 'Provider fault ratio' },
      value: '35.2%',
      abnormal: true,
    },
    {
      card_id: 'cchp/provider/ttft',
      title: { 'zh-CN': '首字延迟', en: 'Time to first token' },
      value: '12.3 s',
      abnormal: true,
    },
  ],
  ...over,
});

describe('外部上游的周期汇总（ADR 0147）', () => {
  const cur: ExternalWindowStats = {
    from: W0,
    to: W1,
    roots: [
      provider('01a13f9e-132d-7803-9a7e-5c8730c4f01e', 'Kimi', { severity: 'critical', triggers: 5 }),
      provider('01a13502-db15-7da2-a26d-87d84d75b634', 'lcodex<&>', {
        firing: false,
        ended_at: '2026-10-24T10:42:00.000Z',
      }),
      {
        ...provider('x', 'x'),
        root: 'component:provider',
        name: null,
        values: [],
        alertnames: ['AlertThemeEscalated'],
        triggers: 1,
      },
    ],
    impact: { condition: 'layer=L0', alerts: [], cards: [] },
  };
  const prev: ExternalWindowStats = {
    from: '2026-10-24T09:00:00.000Z',
    to: W0,
    roots: [
      provider('01a13f9e-132d-7803-9a7e-5c8730c4f01e', 'Kimi', { triggers: 3 }),
      provider('01a154f6-c1dd-710e-b7b2-14352afe477d', '柚子'),
    ],
    impact: { condition: 'layer=L0', alerts: [], cards: [] },
  };

  it('Telegram：一条摘要，每个上游一行，带关键数值、触发次数与上一时段、恢复情况与业务影响；按 Bot API 严格解析', () => {
    const view = composeExternalDigest(cur, prev, 'zh', 'https://srenautix.example.test/incidents');
    const r = renderExternalDigest(CHAT, view, '[影子]');
    const p = r.payload as TelegramPayload;
    const { text, entities } = strict(p);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[影子] 外部上游汇总 10:00–11:00 UTC');
    expect(text).toContain('本时段 3 个上游有问题（上一时段 2 个）：新增 2、持续 1；未恢复 2、已恢复 1。');
    expect(text).toContain('业务影响：无（与上游事件相关的业务告警 layer=L0 0 条，相关的影响卡无异常）');
    const items = lines.filter((l) => l.startsWith('- '));
    expect(items).toEqual([
      '- [严重] Kimi provider 故障率 35.2%、首字延迟 12.3 s · 触发 5 次（上一时段 3 次） · 未恢复',
      '- lcodex<&> provider 故障率 35.2%、首字延迟 12.3 s · 触发 2 次 · 新增 · 10:42 恢复',
      '- component:provider 告警 AlertThemeEscalated · 触发 1 次 · 新增 · 未恢复',
    ]);
    expect(text).toContain('上一时段有问题、本时段没有告警：柚子');
    // 名称粗体，数值等宽；不可信的名称原样作为文字
    expect(p.text).toContain('<b>lcodex&lt;&amp;&gt;</b>');
    const code = entities.filter((e) => e.type === 'code').map((e) => text.slice(e.offset, e.offset + e.length));
    expect(code).toEqual(expect.arrayContaining(['35.2%', '12.3 s']));
    expect(p.reply_markup.inline_keyboard).toEqual([
      [{ text: '在控制台打开', url: 'https://srenautix.example.test/incidents' }],
    ]);
  });

  it('有业务影响时写出相关的业务告警与异常的影响卡及依据（ADR 0150），并说明相关事件已即时推送', () => {
    const kimi = cur.roots[0]!.root;
    const stats: ExternalWindowStats = {
      ...cur,
      roots: [{ ...cur.roots[0]!, immediate: true }],
      impact: {
        condition: 'layer=L0',
        alerts: [
          {
            alertname: 'CCHPErrorBudgetBurnFast',
            starts_at: '2026-10-24T10:12:00.000Z',
            ends_at: null,
            upstream: kimi,
            basis: {
              kind: 'window',
              subject: 'alert',
              upstream_at: '2026-10-24T10:05:00.000Z',
              starts_at: '2026-10-24T10:12:00.000Z',
            },
          },
        ],
        cards: [
          {
            title: { 'zh-CN': '5xx 来自哪一层', en: 'Which layer' },
            value: '4.1%',
            upstream: kimi,
            basis: { kind: 'topology', path: ['StatefulSet:cchp-prod/gateway', kimi] },
          },
        ],
      },
    };
    const zh = strict(
      renderExternalDigest(CHAT, composeExternalDigest(stats, null, 'zh', null), '').payload as TelegramPayload,
    );
    expect(zh.text).toContain(
      '业务影响：CCHPErrorBudgetBurnFast（10:12 起，未恢复；在上游 Kimi 的事件开始后 7 分钟开始）、' +
        '5xx 来自哪一层 4.1%（拓扑路径 StatefulSet:cchp-prod/gateway → Kimi），相关事件已即时推送',
    );
    expect(zh.text).toContain('波及业务，已即时推送');
    const en = strict(
      renderExternalDigest(CHAT, composeExternalDigest(stats, null, 'en', null), '').payload as TelegramPayload,
    );
    expect(en.text).toContain(
      'Business impact: CCHPErrorBudgetBurnFast (since 10:12, firing; started 7 min after the incident of upstream Kimi), ' +
        'Which layer 4.1% (topology path StatefulSet:cchp-prod/gateway → Kimi); the incidents were sent immediately',
    );
  });

  it('事件横幅里每个信号带依据：本事件的影响卡、时间窗、拓扑路径与落在上游组件上', () => {
    const names = { 'provider:k': 'Kimi' };
    const window = {
      kind: 'window' as const,
      subject: 'incident' as const,
      upstream_at: '2026-10-24T10:05:00.000Z',
      starts_at: '2026-10-24T10:05:40.000Z',
    };
    expect(impactLine({ signal: 'provider 故障率 35.2%', basis: { kind: 'own_card' } }, 'zh', names)).toBe(
      'provider 故障率 35.2%（本事件的影响卡）',
    );
    expect(impactLine({ signal: '边缘 5xx 4.1%', basis: window }, 'zh', names)).toBe(
      '边缘 5xx 4.1%（所在事件在上游事件开始后 1 分钟内开始）',
    );
    expect(impactLine({ signal: 'Edge 5xx 4.1%', basis: window }, 'en', names)).toBe(
      'Edge 5xx 4.1% (its incident started within 1 min after the upstream incident)',
    );
    expect(
      impactLine(
        { signal: 'L0', basis: { kind: 'topology', path: ['component:edge-envoy', 'provider:k'] } },
        'zh',
        names,
      ),
    ).toBe('L0（拓扑路径 component:edge-envoy → Kimi）');
    expect(impactLine({ signal: 'L0', basis: { kind: 'topology', path: ['provider:k'] } }, 'en', names)).toBe(
      'L0 (on the upstream component Kimi)',
    );
  });

  it('依赖路径：沿依赖边（含成员）到达上游组件；枢纽不展开，访问边之后不再展开，命名推断的边不算，超过跳数不算', () => {
    const n = (key: string, hub = false): TopologyNode => {
      const [kind, rest] = key.split(':') as [string, string];
      const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
      return { key, kind, namespace: ns, name: name!, uid: null, labels: {}, component_type: null, hub };
    };
    const e = (from: string, to: string, relation: string, provenance: TopologyEdge['provenance'] = 'structural') =>
      ({ from, to, relation, provenance, confidence: 1, scope: 'service', evidence: 't' }) as TopologyEdge;
    const g = new TopologyGraph(
      [
        n('Deployment:shop/web'),
        n('ReplicaSet:shop/web-1'),
        n('Pod:shop/web-1-a'),
        n('Service:shop/api'),
        n('Deployment:shop/api'),
        n('Pod:shop/api-1-a'),
        n('Service:shop/payments'),
        n('Service:kube-system/dns', true),
        n('Service:shop/ledger'),
        n('Job:shop/migrate'),
        n('StatefulSet:shop/pg'),
        n('Pod:shop/pg-0'),
        n('Node:node-a'),
        n('Service:shop/named'),
      ],
      [
        e('ReplicaSet:shop/web-1', 'Deployment:shop/web', 'owned_by'),
        e('Pod:shop/web-1-a', 'ReplicaSet:shop/web-1', 'owned_by'),
        e('Pod:shop/web-1-a', 'Service:shop/api', 'calls', 'runtime'),
        e('Service:shop/api', 'Pod:shop/api-1-a', 'selects'),
        e('Pod:shop/api-1-a', 'Deployment:shop/api', 'owned_by'),
        e('Pod:shop/api-1-a', 'Service:shop/payments', 'calls', 'runtime'),
        e('Pod:shop/web-1-a', 'Service:kube-system/dns', 'calls', 'runtime'),
        e('Service:kube-system/dns', 'Service:shop/ledger', 'routes_to'),
        e('Job:shop/migrate', 'StatefulSet:shop/pg', 'egress_to', 'network_policy'),
        e('Pod:shop/pg-0', 'StatefulSet:shop/pg', 'owned_by'),
        e('Pod:shop/pg-0', 'Node:node-a', 'runs_on'),
        e('Pod:shop/web-1-a', 'Service:shop/named', 'named_like', 'naming'),
      ],
      1,
    );
    expect(dependencyPath(g, 'Deployment:shop/web', 'Service:shop/payments', 6)).toEqual([
      'Deployment:shop/web',
      'Service:shop/api',
      'Deployment:shop/api',
      'Service:shop/payments',
    ]);
    expect(dependencyPath(g, 'Deployment:shop/web', 'Service:shop/payments', 2)).toBeNull();
    expect(dependencyPath(g, 'Pod:shop/api-1-a', 'Deployment:shop/api', 6)).toEqual(['Deployment:shop/api']);
    // 枢纽可以被到达，但不经它到达后面的组件
    expect(dependencyPath(g, 'Deployment:shop/web', 'Service:kube-system/dns', 6)).toEqual([
      'Deployment:shop/web',
      'Service:kube-system/dns',
    ]);
    expect(dependencyPath(g, 'Deployment:shop/web', 'Service:shop/ledger', 6)).toBeNull();
    // 访问边到达被访问的组件为止，不经它的 Pod 到达节点
    expect(dependencyPath(g, 'Job:shop/migrate', 'StatefulSet:shop/pg', 6)).toEqual([
      'Job:shop/migrate',
      'StatefulSet:shop/pg',
    ]);
    expect(dependencyPath(g, 'Job:shop/migrate', 'Node:node-a', 6)).toBeNull();
    expect(dependencyPath(g, 'Deployment:shop/web', 'Service:shop/named', 6)).toBeNull();
    // 方向：上游不依赖业务组件
    expect(dependencyPath(g, 'Service:shop/payments', 'Deployment:shop/web', 6)).toBeNull();
    expect(dependencyPath(g, 'provider:x', 'Deployment:shop/web', 6)).toBeNull();
  });

  it('飞书：同样的行写成 markdown，特殊字符已转义', () => {
    const view = composeExternalDigest(cur, prev, 'zh', 'https://srenautix.example.test');
    const r = renderExternalDigestCard({ channel: 'feishu', chat: 'oc_x', language: 'zh' }, view, '[影子]');
    const json = JSON.stringify(r.payload);
    expect(json).toContain('[影子] 外部上游汇总 10:00–11:00 UTC');
    expect(json).toContain('- &#91;严重&#93; **Kimi** provider 故障率 `35.2%`、首字延迟 `12.3 s`');
    expect(json).toContain('**lcodex&#60;&#38;&#62;**');
  });

  it('窗口按 UTC 纪元对齐：1 小时即整点', () => {
    expect(lastWindow(Date.parse('2026-10-24T11:00:30Z'), 3_600_000)).toEqual({
      from: Date.parse(W0),
      to: Date.parse(W1),
    });
    expect(matchesLabels({ theme: 'provider', x: 'y' }, { theme: ['provider'] })).toBe(true);
    expect(matchesLabels({ theme: 'dragonfly' }, { theme: ['provider'] })).toBe(false);
    expect(matchesLabels({ theme: 'provider' }, {})).toBe(false);
  });

  it('组件类型：拓扑里有的取拓扑上的类型，provider 这类只来自告警的实体按 kind 与名字匹配领域包的类型', async () => {
    const types = [
      { id: 'cchp.provider', external: true, match: { kind: 'provider' } },
      { id: 'cchp.component-provider', match: { kind: 'component', name_pattern: '^(provider|business)$' } },
      { id: 'cchp.gateway-pod', match: { kind: 'Pod', namespaces: ['cchp-prod'] } },
    ];
    const lookup = externalTypeLookup(
      () => types,
      async (_c, key) => (key === 'Pod:cchp-prod/gateway-0' ? 'cchp.gateway-pod' : null),
    );
    expect(await lookup('cchp', 'provider:01a13f9e-132d-7803-9a7e-5c8730c4f01e')).toBe(true);
    expect(await lookup('cchp', 'component:provider')).toBe(false);
    expect(await lookup('cchp', 'Pod:cchp-prod/gateway-0')).toBe(false);
    const none = externalTypeLookup(
      () => types.slice(1),
      async () => null,
    );
    expect(await none('cchp', 'provider:x')).toBe(false);
  });
});
