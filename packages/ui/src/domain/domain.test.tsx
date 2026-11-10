import { createTheme } from '@grafana/data';
import { SCHEMAS } from '@srenautix/contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { BusinessDomainList, IncidentSubgraph } from '../contract';
import { ErrorBoundary, setRenderErrorReporter, type RenderError } from '../primitives/ErrorBoundary';
import { STATUS, Status } from '../primitives/Status';
import {
  condition,
  evidence,
  feedback,
  incident,
  incidentSummary,
  proposal,
  proposalDetail,
  researchOutput,
  researchRun,
} from '../test/fixtures';
import { renderUi } from '../test/render';
import { tokensFromGrafana } from '../theme/grafana';
import { DEFAULT_TOKENS, TOKEN_NAMES } from '../theme/tokens';
import { ApprovalSheet } from './ApprovalSheet';
import { ConditionStrip } from './ConditionStrip';
import { EvidenceCard } from './EvidenceCard';
import { FeedbackControl, REASON_CODES } from './FeedbackControl';
import { HypothesisList } from './HypothesisList';
import { IncidentRow } from './IncidentRow';
import { DEFAULT_INBOX_FILTERS, groupByDomain, InboxView } from '../views/InboxView';
import type { DataPort } from '../port';
import { componentLabel, sortEvidence } from './model';
import { ComponentNamesProvider } from './names';
import { RunTrace, waterfall } from './RunTrace';
import { MINIMAP_MIN_NODES, Subgraph } from './Subgraph';
import { TimelineLane } from './TimelineLane';
import { VerdictHeader } from './VerdictHeader';

const NOW = Date.parse('2026-10-19T06:24:00Z');
const noReauth = { needed: false, begin: () => undefined };

describe('状态标签', () => {
  it('每个取值都是图标加文字', () => {
    for (const [domain, values] of Object.entries(STATUS)) {
      for (const value of Object.keys(values)) {
        const { container, unmount } = renderUi(<Status domain={domain as 'verdict'} value={value as 'normal'} />);
        const pill = container.querySelector('[data-tone]');
        expect(pill?.querySelector('svg'), `${domain}.${value}`).not.toBeNull();
        expect(pill?.textContent?.trim().length, `${domain}.${value}`).toBeGreaterThan(0);
        unmount();
      }
    }
  });
});

describe('设计令牌', () => {
  it('浅色与深色都写成 CSS 变量', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { container, unmount } = renderUi(<span />, { scheme });
      const root = container.firstElementChild as HTMLElement;
      expect(root.dataset.scheme).toBe(scheme);
      for (const name of TOKEN_NAMES) {
        expect(root.style.getPropertyValue(`--sn-${name}`)).toBe(DEFAULT_TOKENS[scheme].colors[name]);
      }
      unmount();
    }
  });

  it('GrafanaTheme2 映射出完整的令牌', () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = tokensFromGrafana(createTheme({ colors: { mode } }));
      expect(t.scheme).toBe(mode);
      for (const name of TOKEN_NAMES) {
        expect(t.colors[name], name).toMatch(/\S/);
      }
    }
  });
});

describe('证据卡', () => {
  it('按异常、无法判定、正常排序', () => {
    const list = [
      evidence({ ref: 'card:1', display_state: 'normal' }),
      evidence({
        ref: 'card:2',
        display_state: 'capability_missing',
        reason: { kind: 'capability_missing', text: 'logs.match 不可用' },
      }),
      evidence({ ref: 'card:3', display_state: 'abnormal' }),
      evidence({ ref: 'card:4', display_state: 'undeterminable', reason: { kind: 'no_data', text: '没有样本' } }),
    ];
    expect(sortEvidence(list).map((r) => r.ref)).toEqual(['card:3', 'card:4', 'card:2', 'card:1']);
  });

  it('实时重跑与快照并排，标注非模型所见与判定变化', () => {
    const snap = evidence({ ref: 'card:1', display_state: 'abnormal' });
    const live = evidence({ ref: 'card:1', display_state: 'normal', evaluated_at: '2026-10-19T06:40:00Z' });
    renderUi(<EvidenceCard r={snap} live={live} />);
    expect(screen.getByText('研判快照 · 模型所见')).toBeTruthy();
    expect(screen.getByText('实时重跑 · 非模型所见')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('研判时为「异常」，现在为「正常」');
  });

  it('卡片的页内锚点是 card-<n>，与通知、issue 里卡片详情链接的 #card-<n> 相同', () => {
    const { container } = renderUi(<EvidenceCard r={evidence({ ref: 'card:38', display_state: 'abnormal' })} />);
    expect(container.querySelector('#card-38')).not.toBeNull();
  });

  it('表格里的原文只作为文本显示（不变量 9）', () => {
    const payload = '<img src=x onerror="window.__pwned=1">{{ .Values }}‮';
    const r = evidence({ ref: 'card:1', display_state: 'abnormal', table: { head: ['message'], rows: [[payload]] } });
    const { container } = renderUi(<EvidenceCard r={r} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(payload)).toBeTruthy();
    expect(screen.getByText(/以下为数据原文/)).toBeTruthy();
  });
});

describe('审批页', () => {
  it('机器推导的字段按固定顺序在前，模型理由折叠并标注未经验证', () => {
    const { container } = renderUi(
      <ApprovalSheet detail={proposalDetail(proposal())} reauth={noReauth} passkey={null} now={NOW} />,
    );
    const order = [...container.querySelectorAll('[data-testid^="f-"]')].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual([
      'f-action',
      'f-target',
      'f-params',
      'f-prechecks',
      'f-blast',
      'f-conflict',
      'f-verify',
      'f-undo',
      'f-ttl',
      'f-policy',
      'f-source',
      'f-binding',
    ]);
    const trigger = screen.getByRole('button', { name: /模型给出的理由（模型生成，未经验证）/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/init 容器在等待迁移锁/)).toBeNull();
  });

  it('H 档要求输入目标名称，并且 5 分钟内重新认证过', () => {
    const p = proposal({
      action: 'cnpg_switchover',
      level: 'compensable',
      tier: 'H',
      target: {
        cluster_id: 'prod',
        kind: 'Cluster',
        namespace: 'db',
        name: 'pg-main',
        uid: null,
        display: 'db/pg-main',
      },
    });
    let began = 0;
    const { rerender } = renderUi(
      <ApprovalSheet
        detail={proposalDetail(p, { undo: { kind: 'compensation', description: '再次切换' } })}
        reauth={{ needed: true, begin: () => (began += 1) }}
        passkey={null}
        now={NOW}
      />,
    );
    const approve = screen.getByRole('button', { name: '批准' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('输入目标名称 db/pg-main 以确认'), { target: { value: 'db/pg-mai' } });
    expect(screen.getByText('与目标名称不一致')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('输入目标名称 db/pg-main 以确认'), { target: { value: 'db/pg-main' } });
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重新认证' }));
    expect(began).toBe(1);
    rerender(
      <ApprovalSheet
        detail={proposalDetail(p, { undo: { kind: 'compensation', description: '再次切换' } })}
        reauth={noReauth}
        passkey={null}
        now={NOW}
      />,
    );
    expect((screen.getByRole('button', { name: '批准' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Grafana 插件里只给出跳转到控制台的链接', () => {
    renderUi(<ApprovalSheet detail={proposalDetail(proposal())} reauth={noReauth} passkey={null} now={NOW} />, {
      actions: false,
      links: { approval: (id) => `https://console.example/actions/${id}`, approvalExternal: true },
    });
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    const a = screen.getByRole('link', { name: /在控制台中审批/ });
    expect(a.getAttribute('href')).toBe(`https://console.example/actions/${proposal().proposal_id}`);
  });

  it('拒绝必须填写理由', () => {
    renderUi(<ApprovalSheet detail={proposalDetail(proposal())} reauth={noReauth} passkey={null} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect((screen.getByRole('button', { name: '确认拒绝' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('拒绝理由（必填）'), { target: { value: '迁移仍在进行' } });
    expect((screen.getByRole('button', { name: '确认拒绝' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('状态条', () => {
  it('没有条件时写明检查时间', () => {
    renderUi(<ConditionStrip conditions={[]} checkedAt={NOW} now={NOW} />);
    expect(screen.getByRole('status').textContent).toContain('各角色的状态条件正常（14:24 检查）');
  });

  it('读不到条件时显性失败', () => {
    renderUi(
      <ConditionStrip conditions={undefined} checkedAt={null} now={NOW} error={new Error('listConditions: 503')} />,
    );
    expect(screen.getByRole('alert').textContent).toContain('读不到系统状态');
  });

  it('准入自检失败的集群显示仅提议', () => {
    renderUi(
      <ConditionStrip
        conditions={[
          condition({ type: 'AdmissionSelfTestFailed', role: 'gateway', message: 'dryRun 违规写入被放行' }),
          condition({ type: 'ModelRouteBreakerOpen', role: 'worker', subject: 'route-a', status: 'true' }),
          condition({ type: 'ClockSkew', status: 'false' }),
        ]}
        checkedAt={NOW}
        now={NOW}
      />,
    );
    const strip = screen.getByRole('alert');
    expect(strip.textContent).toContain('集群 prod 仅提议');
    expect(strip.textContent).toContain('准入自检失败');
    expect(strip.textContent).toContain('模型路由熔断');
    expect(strip.textContent).not.toContain('时钟偏差');
  });

  it('reader 的条件与控制台不认识的类型：照常显示，不认识的类型按 warning 并显示类型名', () => {
    renderUi(
      <ConditionStrip
        conditions={[
          condition({
            type: 'QueryManifest',
            role: 'reader',
            status: 'true',
            message: 'declared evidence queries are rejected',
          }),
          // 契约之外的类型（较新的 server），绕过夹具的契约校验
          {
            ...condition({ type: 'ClockSkew', status: 'true', message: '较新的 server 上报的类型' }),
            type: 'SomethingNew' as 'ClockSkew',
          },
        ]}
        checkedAt={NOW}
        now={NOW}
      />,
    );
    const strip = screen.getByRole('alert');
    expect(strip.getAttribute('data-level')).toBe('warning');
    expect(strip.textContent).toContain('查询模板清单未加载');
    expect(strip.textContent).toContain('SomethingNew');
    expect(strip.textContent).toContain('较新的 server 上报的类型');
  });
});

describe('错误边界', () => {
  function Boom(): never {
    throw new Error('坏数据');
  }

  it('子组件渲染出错只影响自己：显示一行说明并上报，兄弟组件照常渲染', () => {
    const reported: RenderError[] = [];
    setRenderErrorReporter((e) => reported.push(e));
    const error = console.error;
    console.error = () => undefined;
    try {
      renderUi(
        <div>
          <ErrorBoundary area="ConditionStrip">
            <Boom />
          </ErrorBoundary>
          <p>页面其余部分</p>
        </div>,
      );
    } finally {
      console.error = error;
      setRenderErrorReporter(() => undefined);
    }
    expect(screen.getByText('页面其余部分')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('ConditionStrip 显示出错，页面其他部分不受影响');
    expect(screen.getByRole('alert').textContent).toContain('坏数据');
    expect(reported.map((r) => r.area)).toEqual(['ConditionStrip']);
  });
});

describe('反馈', () => {
  const base = {
    incidentRef: 'x',
    runId: null,
    disposition: 'act' as const,
    rootComponent: 'postgres.cluster:db/pg-main',
    components: ['postgres.cluster:db/pg-main', 'Deployment:app/gateway'],
    latest: null,
    state: 'pending' as const,
    firing: true,
  };

  it('两个维度，根因错时可以选择不知道真实根因，原因必选', () => {
    renderUi(<FeedbackControl {...base} />);
    const submit = screen.getByRole('button', { name: '提交反馈' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const root = screen.getByRole('group', { name: '根因组件' });
    fireEvent.click(within(root).getByRole('button', { name: '错' }));
    expect(submit.disabled).toBe(true);
    const select = screen.getByLabelText('真实根因组件') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toContain('不知道真实根因');
    fireEvent.change(select, { target: { value: '__unknown__' } });
    expect(screen.getByText(/不生成回放用例/)).toBeTruthy();
    // 拒绝时原因必选（ADR 0174）
    expect(submit.disabled).toBe(true);
    const reason = screen.getByLabelText('原因') as HTMLSelectElement;
    expect([...reason.options].map((o) => o.textContent)).toContain('修复方向错误（事件是真的）');
    fireEvent.change(reason, { target: { value: 'false_positive' } });
    expect(submit.disabled).toBe(false);
    expect(screen.getByText('事件进行中也可以反馈，以最新一条为准。')).toBeTruthy();
  });

  it('确认时原因可选；只选原因、不评价两个维度也可以提交', () => {
    renderUi(<FeedbackControl {...base} />);
    const submit = screen.getByRole('button', { name: '提交反馈' }) as HTMLButtonElement;
    const disp = screen.getByRole('group', { name: '处置判断' });
    fireEvent.click(within(disp).getByRole('button', { name: '对' }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(within(disp).getByRole('button', { name: '对' }));
    expect(submit.disabled).toBe(true);
    const reason = screen.getByLabelText('原因（可选）') as HTMLSelectElement;
    expect(reason.required).toBe(false);
    fireEvent.change(reason, { target: { value: 'worse_than_baseline' } });
    expect(submit.disabled).toBe(false);
  });

  it('原因的选项与契约的 FeedbackReasonCode 一致', () => {
    const schema = SCHEMAS['https://srenautix.io/contract/schemas/feedback.schema.json'] as unknown as {
      $defs: { ReasonCode: { enum: string[] } };
    };
    expect([...REASON_CODES].sort()).toEqual([...schema.$defs.ReasonCode.enum].sort());
  });

  it('已反馈时显示摘要，可以修改', () => {
    renderUi(<FeedbackControl {...base} latest={feedback({ reason_code: 'known_issue' })} state="given" />);
    expect(screen.getByRole('status').textContent).toContain('处置判断对 · 根因对 · 已知问题 · oncall-a（console）');
    fireEvent.click(screen.getByRole('button', { name: '修改' }));
    expect(screen.getByRole('button', { name: '提交反馈' })).toBeTruthy();
  });

  it('没有反馈权限时说明原因', () => {
    renderUi(<FeedbackControl {...base} />, {
      caps: { feedback: false, readOnlyReason: '只读：反馈需要 responder 角色' },
    });
    expect(screen.getByText('只读：反馈需要 responder 角色')).toBeTruthy();
  });
});

describe('结论头', () => {
  it('研判中时用阶段 A 的判断，并列出影响判定的条件', () => {
    renderUi(
      <VerdictHeader
        incident={incident({
          aliases: [
            {
              from_incident_id: '00000000-0000-4000-8000-000000000001',
              from_label: 'Pod:app/worker-1:2026-10-19T06:10:00Z',
              at_version: 2,
              merged_at: '2026-10-19T06:19:00Z',
            },
          ],
        })}
        stageA={null}
        latestRun={{
          ...researchRun({
            state: 'hypothesize',
            finished_at: null,
            summary: null,
            disposition: null,
            conclusion_level: null,
          }),
        }}
        evidence={[evidence({ ref: 'card:1', display_state: 'abnormal' })]}
        conditions={[condition({ type: 'DatasourceUnavailable', subject: 'loki', message: 'Loki 超时' })]}
        now={NOW}
      />,
    );
    expect(screen.getByText('模型研判中：提出假设')).toBeTruthy();
    expect(screen.getByText('合并自 1')).toBeTruthy();
    expect(screen.getByRole('list', { name: '影响这个判定的条件' }).textContent).toContain('Loki 超时');
  });

  it('没有模型结论时显示阶段 A 的规则判定，标明“规则判定”，档位为可能', () => {
    const inc = incident();
    const stageA = {
      report_id: '00000000-0000-4000-8000-0000000000a1',
      incident_id: inc.incident_id,
      incident_version: inc.incident_version,
      disposition: 'escalate',
      disposition_reason: 'critical_ambiguous',
      candidates: [],
      ambiguous: true,
      cards: [],
      evidence_fingerprint: `sha256:${'1'.repeat(64)}`,
      observability_blind: false,
      timeline: [],
      runbooks: [],
      rule_proposals: [],
      degraded: false,
      rendered_at: '2026-10-19T06:20:00Z',
      rule_conclusions: [
        {
          rule_id: 'postgres/oom-failover',
          title: { 'zh-CN': '实例 OOM 引发主库切换', en: 'An instance OOM kill caused a primary change' },
          root_component: 'StatefulSet:data/pg',
          mechanism: { 'zh-CN': '主库被 OOM 终止，集群提升备库', en: 'The primary was OOM-killed' },
          level: 'likely',
          basis: ['card:1', 'card:2'],
          card_conditions: [],
        },
      ],
    } as const;
    renderUi(
      <VerdictHeader
        incident={inc}
        stageA={stageA as never}
        latestRun={researchRun({ state: 'stage_a_only', summary: null, disposition: null, conclusion_level: null })}
        evidence={[]}
        conditions={[]}
        now={NOW}
      />,
    );
    expect(screen.getByText('规则判定').closest('[title]')?.getAttribute('title')).toBe('postgres/oom-failover');
    expect(screen.getByText(/（实例 OOM 引发主库切换）：主库被 OOM 终止，集群提升备库/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('pg');
  });
});

describe('详情页的标题（ADR 0190、0193）', () => {
  it('标题是问题陈述，根因写在副行；事件键与版本只在集群的悬停提示里', () => {
    const inc = incident({
      headline: {
        alert_id: 'f0e1d2c3b4a59687@1760854680',
        alertname: 'GatewayErrorRateHigh',
        summary: 'gateway 5xx 比例 12%，超过 5%',
        started_at: '2026-10-19T06:18:00Z',
        research_summary: null,
      },
    });
    renderUi(<VerdictHeader incident={inc} stageA={null} latestRun={null} evidence={[]} conditions={[]} now={NOW} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('gateway 5xx 比例 12%，超过 5%');
    expect(screen.getByText(/^根因 pg-main（/)).toBeTruthy();
    const head = screen.getByRole('region', { name: '结论' });
    expect(head.textContent).not.toContain(inc.label);
    expect(screen.getByText('prod').getAttribute('title')).toBe(
      `事件键 ${inc.label}\nv3 · 拓扑 v${inc.topology_version}`,
    );
  });
});

describe('收件箱翻页（契约 2.57.0）', () => {
  it('显示已加载数与总数；加载更多取下一页并拼在后面，最后一页之后没有按钮', async () => {
    const row = (n: number) => incidentSummary({ incident_id: `00000000-0000-4000-8000-00000000000${n}` });
    const asked: Array<string | undefined> = [];
    const listIncidents: DataPort['listIncidents'] = async (q) => {
      asked.push(q.cursor);
      const base = { suppressed_count: 0, blind_spans: [], total: 3, total_truncated: false };
      return q.cursor === 'c1'
        ? { ...base, items: [row(3)], next_cursor: null }
        : { ...base, items: [row(1), row(2)], next_cursor: 'c1' };
    };
    renderUi(<InboxView filters={DEFAULT_INBOX_FILTERS} onFilters={() => undefined} now={NOW} />, {
      port: {
        listIncidents,
        listConditions: async () => [],
        listBusinessDomains: async () => ({ items: [], unassigned_firing: 0 }),
      },
    });
    expect(await screen.findByText('显示 2 / 共 3 个事件 · 已抑制 0')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('显示 3 / 共 3 个事件 · 已抑制 0')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(asked).toEqual([undefined, 'c1']);
  });
});

describe('组件的可读名称', () => {
  it('有名称时显示名称，副标题带对象名；组件键不变；没有名称时显示对象名', () => {
    expect(componentLabel('postgres.cluster:db/pg-main', { 'postgres.cluster:db/pg-main': '订单主库' })).toEqual({
      name: '订单主库',
      sub: 'postgres.cluster · db · pg-main',
    });
    expect(componentLabel('postgres.cluster:db/pg-main', {})).toEqual({
      name: 'pg-main',
      sub: 'postgres.cluster · db',
    });
    renderUi(
      <ComponentNamesProvider names={{ 'postgres.cluster:db/pg-main': '订单主库' }}>
        <HypothesisList output={researchOutput()} />
      </ComponentNamesProvider>,
    );
    expect(screen.getAllByText(/订单主库/).length).toBeGreaterThan(0);
  });
});

describe('假设与运行', () => {
  it('假设树、区分性检查与结论条件', () => {
    renderUi(<HypothesisList output={researchOutput()} />);
    expect(screen.getByText('结论采用')).toBeTruthy();
    expect(screen.getAllByText('已推翻').length).toBeGreaterThan(0);
    expect(screen.getByText('检查发布后的错误率')).toBeTruthy();
    expect(screen.getByText('删除了无效引用 card:9')).toBeTruthy();
    expect(screen.getByText('至少检验过一个竞争假设')).toBeTruthy();
  });

  it('瀑布图按开始时间排列步骤、模型调用与工具调用', () => {
    const bars = waterfall(researchRun(), NOW, (s) => s);
    expect(bars.map((b) => `${b.kind}:${b.label}`)).toEqual([
      'step:queued',
      'step:hypothesize',
      'llm:hypothesize · route-b',
      'step:discriminate',
      'tool:metrics.query_range',
      'step:conclude',
    ]);
  });

  it('运行明细：模型调用与出境清单', () => {
    renderUi(
      <RunTrace
        run={researchRun()}
        manifest={null}
        now={NOW}
        promptHref={(seq, raw) => (raw ? null : `/runs/x/prompts/${seq}`)}
      />,
    );
    const table = screen.getByRole('table', { name: '模型调用' });
    expect(table.textContent?.match(/输入[^推]*推理 \d+/)?.[0]).toBe('输入 21,480（缓存 0）· 输出 2,310 · 推理 0');
    expect(screen.getByRole('link', { name: '脱敏后提示词' }).getAttribute('href')).toBe('/runs/x/prompts/1');
    expect(screen.queryByRole('link', { name: '原始提示词' })).toBeNull();
    expect(screen.getByText('没有研判清单')).toBeTruthy();
  });
});

describe('时间线', () => {
  it('不可信原文放进引用样式', () => {
    renderUi(
      <TimelineLane
        from={NOW - 3_600_000}
        to={NOW}
        blind={[[NOW - 1_800_000, NOW - 1_500_000]]}
        items={[
          {
            at: '2026-10-19T06:18:00Z',
            kind: 'alert_firing',
            text: 'KubePodCrashLooping app/gateway',
            ref: null,
            untrusted: false,
            code: null,
            level: null,
          },
          {
            at: '2026-10-19T06:18:30Z',
            kind: 'change',
            text: '<b>deploy</b> by **bot**',
            ref: null,
            untrusted: true,
            code: null,
            level: null,
          },
        ]}
      />,
    );
    const quote = screen.getByText('<b>deploy</b> by **bot**');
    expect(quote.closest('blockquote')).not.toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('变更记录显示关联分级、依据与回退（ADR 0169）', () => {
    renderUi(
      <TimelineLane
        from={NOW - 3_600_000}
        to={NOW}
        items={[
          {
            at: '2026-10-19T06:18:30Z',
            kind: 'change',
            text: 'argocd gitops_sync：bump image',
            ref: 'argocd:1',
            untrusted: true,
            code: null,
            level: null,
            change_link: {
              change_id: 'argocd:1',
              grade: 'high',
              basis: ['component_match', 'acts_on'],
              new_signals: ['a1'],
              rollback: true,
            },
          },
          {
            at: '2026-10-19T06:20:00Z',
            kind: 'change',
            text: 'github config：tune',
            ref: 'github:2',
            untrusted: true,
            code: null,
            level: null,
            change_link: {
              change_id: 'github:2',
              grade: 'low',
              basis: ['namespace'],
              new_signals: [],
              rollback: false,
            },
          },
        ]}
      />,
    );
    expect(screen.getByText('强关联 · 作用在告警的组件上 · 前置 Job 访问的组件 · 回退')).toBeTruthy();
    expect(screen.getByText('弱关联 · 同一命名空间')).toBeTruthy();
  });

  it('终态记录显示原因码与级别，warning 与 error 的记录按级别着色（ADR 0172）', () => {
    renderUi(
      <TimelineLane
        from={NOW - 3_600_000}
        to={NOW}
        items={[
          {
            at: '2026-10-19T06:18:00Z',
            kind: 'stage_a_missing',
            text: '阶段 A 补跑 3 次仍然失败，当前版本没有报告',
            ref: null,
            untrusted: false,
            code: 'stage_a_missing',
            level: 'error',
          },
          {
            at: '2026-10-19T06:19:00Z',
            kind: 'notify',
            text: '不推送：事件被抑制',
            ref: null,
            untrusted: false,
            code: 'withheld_suppressed',
            level: 'info',
          },
          {
            at: '2026-10-19T06:20:00Z',
            kind: 'research_ended',
            text: '入队时跳过，只出阶段 A：该事件 6 小时内已研判 3 次',
            ref: 'r1',
            untrusted: false,
            code: 'capped',
            level: 'warning',
          },
        ]}
      />,
    );
    expect(screen.getByText('stage_a_missing').closest('[data-tone]')?.getAttribute('data-tone')).toBe('bad');
    expect(screen.getByText('withheld_suppressed').closest('[data-tone]')?.getAttribute('data-tone')).toBe('neutral');
    const kinds = [...document.querySelectorAll('li > [data-tone]')].map((e) => [
      e.textContent,
      e.getAttribute('data-tone'),
    ]);
    expect(kinds).toEqual([
      ['阶段 A 缺失', 'bad'],
      ['通知', 'info'],
      ['研判没有结论', 'warn'],
    ]);
    expect(screen.getByText('不推送：事件被抑制')).toBeTruthy();
  });
});

describe('收件箱的一行（ADR 0190）', () => {
  const subRow = (row: HTMLElement, since: string) =>
    [...(within(row).getByText(since).parentElement?.children ?? [])].slice(0, 3).map((e) => e.textContent);

  it('标题是头条告警的问题陈述，副行先写开始时刻，研判结论单独一行，事件键与 ID 只在悬停提示里', () => {
    const s = incidentSummary();
    renderUi(<IncidentRow s={s} now={NOW} />);
    const row = screen.getByRole('link');
    expect(row.getAttribute('aria-label')).toBe(
      '事件：gateway 5xx 比例 12%，超过 5%，10-19 14:18 起，根因 pg-main，集群 prod',
    );
    expect(within(row).getByText('gateway 5xx 比例 12%，超过 5%')).toBeTruthy();
    expect(subRow(row, '10-19 14:18 起')).toEqual(['10-19 14:18 起', 'pg-main', 'prod']);
    expect(within(row).getByTestId('research-summary').textContent).toBe(
      '研判：pg-main 主库内存达到上限后重启，gateway 连接被拒绝',
    );
    expect(row.textContent).not.toContain(s.label);
    expect(row.textContent).not.toContain(s.incident_id);
    expect(row.getAttribute('title')).toBe(
      [
        '告警 GatewayErrorRateHigh',
        '组件 postgres.cluster:db/pg-main',
        `事件键 ${s.label}`,
        `事件 ID ${s.incident_id}`,
      ].join('\n'),
    );
  });

  it('没有 summary 注解时标题是告警名；没有完成的研判时不显示研判行', () => {
    const base = incidentSummary();
    const s = incidentSummary({
      headline: { ...base.headline!, summary: null, research_summary: null },
    });
    renderUi(<IncidentRow s={s} now={NOW} />);
    const row = screen.getByRole('link');
    expect(within(row).getByText('GatewayErrorRateHigh')).toBeTruthy();
    expect(within(row).queryByTestId('research-summary')).toBeNull();
    expect(row.getAttribute('title')?.split('\n')[0]).toBe('组件 postgres.cluster:db/pg-main');
  });

  it('没有头条告警时标题回到根因组件名，开始时刻取事件首次触发的时间（英文）', () => {
    const s = incidentSummary({ headline: null, first_firing_at: '2026-10-19T06:05:00Z' });
    renderUi(<IncidentRow s={s} now={NOW} />, { locale: 'en' });
    const row = screen.getByRole('link');
    expect(row.getAttribute('aria-label')).toBe('Incident: pg-main, since 10-19 14:05, root pg-main, cluster prod');
    expect(subRow(row, 'since 10-19 14:05')).toEqual(['since 10-19 14:05', 'pg-main', 'prod']);
    expect(within(row).queryByTestId('research-summary')).toBeNull();
  });
});

describe('业务领域与服务（ADR 0193）', () => {
  const domains: BusinessDomainList = {
    items: [
      {
        id: 'forwarding',
        title: { 'zh-CN': '请求转发' },
        tier: 'core',
        services: [{ id: 'gateway', title: { 'zh-CN': '网关' }, firing: 1 }],
      },
      {
        id: 'data',
        title: { 'zh-CN': '数据存储', en: 'Data' },
        tier: 'core',
        services: [{ id: 'postgres', title: { 'zh-CN': 'PostgreSQL' }, firing: 1 }],
      },
    ],
    unassigned_firing: 1,
  };
  const title = (d: BusinessDomainList['items'][number]) => d.title['zh-CN'] ?? d.id;

  it('分组按声明顺序，组内保持列表顺序，没有业务领域的在最后；空组不出现；没有声明时不分组', () => {
    const pg = incidentSummary({ incident_id: 'a', business_domain: 'data' });
    const none = incidentSummary({ incident_id: 'b', business_domain: null, primary_service: null, services: [] });
    const gone = incidentSummary({ incident_id: 'c', business_domain: 'retired' });
    const pg2 = incidentSummary({ incident_id: 'd', business_domain: 'data' });
    const groups = groupByDomain([pg, none, gone, pg2], domains, title, '未归属');
    expect(groups?.map((g) => [g.id, g.title, g.rows.map((r) => r.incident_id)])).toEqual([
      ['data', '数据存储', ['a', 'd']],
      [null, '未归属', ['b', 'c']],
    ]);
    expect(groupByDomain([pg], { items: [], unassigned_firing: 0 }, title, '未归属')).toBeNull();
    expect(groupByDomain([pg], undefined, title, '未归属')).toBeNull();
  });

  it('行标题前是主服务；按命名空间推定的服务带提示', () => {
    const s = incidentSummary();
    renderUi(<IncidentRow s={s} now={NOW} service={{ title: 'PostgreSQL', presumed: false }} />);
    const row = screen.getByRole('link');
    expect(row.getAttribute('aria-label')).toBe(
      '事件：PostgreSQL · gateway 5xx 比例 12%，超过 5%，10-19 14:18 起，根因 pg-main，集群 prod',
    );
    expect(within(row).getByText('PostgreSQL').getAttribute('title')).toBeNull();
  });

  it('推定的服务：title 写明按命名空间推定', () => {
    renderUi(<IncidentRow s={incidentSummary()} now={NOW} service={{ title: '网关', presumed: true }} />);
    expect(within(screen.getByRole('link')).getByText('网关').getAttribute('title')).toBe('按命名空间推定的服务');
  });
});

describe('根因子图的交互（ADR 0191）', () => {
  const ROOT = 'postgres.cluster:db/pg-main';
  const GATEWAY = 'Deployment:app/gateway';
  const graph: IncidentSubgraph = {
    topology_version: 41,
    root: ROOT,
    nodes: [
      {
        component: ROOT,
        kind: 'postgres.cluster',
        namespace: 'db',
        name: 'pg-main',
        role: 'root',
        alerts: ['a1@1'],
        hops: 0,
      },
      {
        component: GATEWAY,
        kind: 'Deployment',
        namespace: 'app',
        name: 'gateway',
        role: 'member',
        alerts: [],
        hops: 1,
      },
      {
        component: 'StatefulSet:app/worker',
        kind: 'StatefulSet',
        namespace: 'app',
        name: 'worker',
        role: 'neighbor',
        alerts: [],
        hops: 2,
      },
    ],
    edges: [
      { from: GATEWAY, to: ROOT, relation: 'connects_to', provenance: 'runtime', confidence: 0.9, scope: 'instance' },
      {
        from: 'StatefulSet:app/worker',
        to: GATEWAY,
        relation: 'calls',
        provenance: 'naming',
        confidence: 0.4,
        scope: 'service',
      },
    ],
  };
  const links = {
    topology: (c: string, k: string) => `/topology?cluster=${c}&view=neighborhood&component=${encodeURIComponent(k)}`,
    search: (q: string, c: string) => `/search?cluster=${c}&q=${encodeURIComponent(q)}`,
  };
  const node = (name: string) => screen.findByRole('group', { name });

  it('单击节点打开侧栏：显示名与键、角色、告警，以及邻域与搜索链接；关闭按钮收起侧栏', async () => {
    renderUi(<Subgraph graph={graph} clusterId="prod" alertLabel={(id) => `KubePodCrashLooping（${id}）`} />, {
      links,
    });
    const rootEl = await node('pg-main，根因，1 条告警');
    fireEvent.click(rootEl);
    const panel = await screen.findByTestId('subgraph-panel');
    expect(rootEl.querySelector('[data-selected]')).not.toBeNull();
    expect(within(panel).getByRole('heading', { name: 'pg-main' })).toBeTruthy();
    expect(within(panel).getByText(ROOT)).toBeTruthy();
    expect(within(panel).getByText('根因')).toBeTruthy();
    expect(within(panel).getByText('0 跳')).toBeTruthy();
    expect(within(panel).getByRole('listitem').textContent).toBe('KubePodCrashLooping（a1@1）');
    expect(within(panel).getByRole('link', { name: '以它为中心查看拓扑邻域' }).getAttribute('href')).toBe(
      links.topology('prod', ROOT),
    );
    expect(within(panel).getByRole('link', { name: '搜索这个组件的事件' }).getAttribute('href')).toBe(
      links.search(ROOT, 'prod'),
    );
    fireEvent.click(await node('gateway，成员，0 条告警'));
    expect(within(await screen.findByTestId('subgraph-panel')).getByText('这个组件上没有成员告警')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('subgraph-panel')).getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('subgraph-panel')).toBeNull();
  });

  it('宿主没有拓扑页与搜索页（或没有给集群）时侧栏不显示链接；告警显示 alert_id', async () => {
    renderUi(<Subgraph graph={graph} />, { links });
    fireEvent.click(await node('pg-main，根因，1 条告警'));
    const panel = await screen.findByTestId('subgraph-panel');
    expect(within(panel).queryByRole('navigation')).toBeNull();
    expect(within(panel).getByRole('listitem').textContent).toBe('a1@1');
  });

  it('双击节点把组件键交给宿主', async () => {
    const opened: string[] = [];
    renderUi(<Subgraph graph={graph} clusterId="prod" onOpenComponent={(c) => opened.push(c)} />);
    fireEvent.doubleClick(await node('gateway，成员，0 条告警'));
    expect(opened).toEqual([GATEWAY]);
  });

  it('键盘：节点可以聚焦，回车打开侧栏并把焦点移到侧栏标题，Esc 关闭后焦点回到节点', async () => {
    renderUi(<Subgraph graph={graph} clusterId="prod" />);
    const root = await node('pg-main，根因，1 条告警');
    expect(root.tabIndex).toBe(0);
    root.focus();
    fireEvent.keyDown(root, { key: 'Enter' });
    const heading = within(await screen.findByTestId('subgraph-panel')).getByRole('heading', { name: 'pg-main' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(screen.queryByTestId('subgraph-panel')).toBeNull();
    expect(document.activeElement).toBe(root);
  });

  it('缩放按钮与全屏按钮带文字标签；节点多于阈值时才显示小地图', async () => {
    const { unmount } = renderUi(<Subgraph graph={graph} />);
    await node('pg-main，根因，1 条告警');
    for (const name of ['放大', '缩小', '适配视图']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: '全屏' }) !== null).toBe(document.fullscreenEnabled);
    expect(document.querySelector('.react-flow__minimap')).toBeNull();
    unmount();

    const many: IncidentSubgraph = {
      topology_version: 41,
      root: null,
      nodes: Array.from({ length: MINIMAP_MIN_NODES + 1 }, (_, i) => ({
        component: `Deployment:app/svc-${i}`,
        kind: 'Deployment',
        namespace: 'app',
        name: `svc-${i}`,
        role: 'neighbor' as const,
        alerts: [],
        hops: 1,
      })),
      edges: [],
    };
    renderUi(<Subgraph graph={many} />);
    await node('svc-0，邻居，0 条告警');
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
  });

  it('全屏：进入后子图与侧栏都在全屏范围内，退出后恢复进入前的缩放与位置', async () => {
    renderUi(<Subgraph graph={graph} clusterId="prod" />);
    const rootEl = await node('pg-main，根因，1 条告警');
    const viewport = () => document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    await userEvent.click(screen.getByRole('button', { name: '放大' }));
    await waitFor(() => expect(viewport()).toMatch(/scale/));
    const before = viewport();
    await userEvent.click(screen.getByRole('button', { name: '全屏' }));
    await waitFor(() => expect(document.fullscreenElement).not.toBeNull());
    expect(document.fullscreenElement?.contains(rootEl)).toBe(true);
    fireEvent.click(rootEl);
    expect(document.fullscreenElement?.contains(await screen.findByTestId('subgraph-panel'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '退出全屏' }));
    await waitFor(() => expect(document.fullscreenElement).toBeNull());
    await waitFor(() => expect(viewport()).toBe(before));
    expect(screen.getByRole('button', { name: '全屏' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('浅色与深色下画布控件都取主题令牌', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { unmount } = renderUi(<Subgraph graph={graph} />, { scheme });
      await node('pg-main，根因，1 条告警');
      const wrap = screen.getByRole('group', { name: '根因子图：3 个组件，2 条边' });
      const css = getComputedStyle(wrap);
      expect(css.getPropertyValue('--xy-controls-button-background-color').trim()).toBe(
        DEFAULT_TOKENS[scheme].colors.panel,
      );
      expect(css.getPropertyValue('--xy-controls-button-color').trim()).toBe(DEFAULT_TOKENS[scheme].colors.text);
      unmount();
    }
  });
});
