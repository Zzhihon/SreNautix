import type { ChangeEvent, EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { escapeFeishu, feishuMarkdown } from '../../src/channels/feishu/render.js';
import { alertLink, cardConsoleLink, cardQueryLink, changeLink, type LinkSettings } from '../../src/notify/links.js';
import { escapeMarkdown, runsMarkdown } from '../../src/notify/markdown.js';

// 证据链接与 Markdown 转义（ADR 0125）

const S: LinkSettings = {
  consoleUrl: 'https://srenautix.example.test/',
  metricsExploreUrl:
    'https://grafana.example.test/explore?left=%7B%22queries%22%3A%5B%7B%22expr%22%3A{query_json}%7D%5D%2C%22range%22%3A%7B%22from%22%3A%22{from_ms}%22%2C%22to%22%3A%22{to_ms}%22%7D%7D',
  logsExploreUrl: null,
  alertmanagerUrl: 'https://am.example.test/',
  argocdUrl: 'https://argocd.example.test',
  gitCommitUrl: 'https://github.example.test/acme/gitops/commit/{revision}',
};

const card = (queries: EvidenceResult['queries']): EvidenceResult => ({
  ref: 'card:7',
  card_id: 'p/c/x',
  title: { 'zh-CN': 'x' },
  threshold: null,
  series: [],
  entity: null,
  window: { from: '2026-10-20T15:32:30.000Z', to: '2026-10-20T16:12:30.000Z' },
  verdict: 'abnormal',
  display_state: 'abnormal',
  reason: { kind: 'rule', text: 'x' },
  value: null,
  table: null,
  queries,
  egress: 'allow',
  evaluated_at: '2026-10-20T17:05:00.000Z',
});

const change = (over: Partial<ChangeEvent>): ChangeEvent => ({
  change_id: 'c:1',
  source: 'github',
  kind: 'gitops_sync',
  refs: [],
  revision: null,
  actor: null,
  time: '2026-10-20T15:59:52Z',
  link: null,
  targets: [],
  summary: 's',
  ...over,
});

describe('证据链接', () => {
  it('控制台的卡片详情：事件页证据标签页的卡片锚点', () => {
    expect(cardConsoleLink(S, 'abc', 'card:38')).toBe(
      'https://srenautix.example.test/incidents/abc?tab=evidence#card-38',
    );
  });

  it('数据源查询：模板中填入查询（JSON 字符串、URL 编码）与时间窗；没有指标查询时为 null', () => {
    const q = 'sum(rate(x{a="b"}[5m]))';
    const url = cardQueryLink(
      S,
      card([
        {
          name: 'm',
          integration: 'vm',
          capability: 'metrics.query_range',
          query: q,
          sample_count: 1,
          truncated: false,
          error: null,
          duration_ms: 1,
        },
      ]),
    )!;
    const left = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('left')!)) as {
      queries: Array<{ expr: string }>;
      range: { from: string; to: string };
    };
    expect(left.queries[0]!.expr).toBe(q);
    expect(left.range).toEqual({
      from: String(Date.parse('2026-10-20T15:32:30Z')),
      to: String(Date.parse('2026-10-20T16:12:30Z')),
    });
    expect(cardQueryLink(S, card([]))).toBeNull();
    expect(cardQueryLink({ ...S, metricsExploreUrl: null }, card([]))).toBeNull();
  });

  it('告警：generatorURL 优先，没有时为 Alertmanager 按告警名过滤；非 http(s) 的 generatorURL 不用', () => {
    expect(alertLink(S, { alertname: 'A', generator_url: 'https://prom.example.test/graph?g0.expr=up' })).toBe(
      'https://prom.example.test/graph?g0.expr=up',
    );
    expect(alertLink(S, { alertname: 'A', generator_url: 'javascript:alert(1)' })).toBe(
      'https://am.example.test/#/alerts?filter=%7Balertname%3D%22A%22%7D',
    );
    expect(alertLink({ ...S, alertmanagerUrl: null }, { alertname: 'A', generator_url: null })).toBeNull();
  });

  it('变更：自带链接，其次 Argo CD 应用页，其次提交页', () => {
    expect(changeLink(S, change({ link: 'https://ci.example.test/run/1' }))).toBe('https://ci.example.test/run/1');
    expect(changeLink(S, change({ refs: ['Application.argoproj.io:argocd/shop'] }))).toBe(
      'https://argocd.example.test/applications/argocd/shop',
    );
    expect(changeLink(S, change({ revision: '0123456789abcdef' }))).toBe(
      'https://github.example.test/acme/gitops/commit/0123456789abcdef',
    );
    expect(changeLink(S, change({ revision: 'rel-9a8c' }))).toBeNull();
  });
});

describe('Markdown 转义', () => {
  it('GitHub：特殊字符转义，@ 不提及用户，代码用反引号，链接只允许 http(s)', () => {
    expect(escapeMarkdown('a*b_c [x](y) <b> # | ~ @user')).toBe('a\\*b\\_c \\[x\\]\\(y\\) \\<b\\> \\# \\| \\~ @​user');
    expect(
      runsMarkdown([
        { text: 'x`y', style: 'code', href: null },
        { text: ' t', style: 'bold', href: 'javascript:1' },
        { text: ' 链接', style: 'italic', href: 'https://e.test/a(b)' },
      ]),
    ).toBe('``x`y``** t**[_ 链接_](https://e.test/a%28b%29)');
  });

  it('飞书：按富文本组件的转义表转义，链接只允许 http(s)', () => {
    expect(escapeFeishu('*a* ~b~ <c> [d] -e- _f_ #g & `h`')).toBe(
      '&#42;a&#42; &sim;b&sim; &#60;c&#62; &#91;d&#93; &#45;e&#45; &#95;f&#95; &#35;g &#38; &#96;h&#96;',
    );
    expect(
      feishuMarkdown([
        { text: '值', style: 'code', href: null },
        { text: ' 控制台', style: 'plain', href: 'https://e.test/x' },
      ]),
    ).toBe('`值`[ 控制台](https://e.test/x)');
  });
});
