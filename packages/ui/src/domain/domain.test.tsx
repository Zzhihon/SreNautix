import { createTheme } from '@grafana/data';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary, setRenderErrorReporter, type RenderError } from '../primitives/ErrorBoundary';
import { STATUS, Status } from '../primitives/Status';
import {
  condition,
  evidence,
  feedback,
  incident,
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
import { FeedbackControl } from './FeedbackControl';
import { HypothesisList } from './HypothesisList';
import { componentLabel, sortEvidence } from './model';
import { ComponentNamesProvider } from './names';
import { RunTrace, waterfall } from './RunTrace';
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

  it('两个维度，根因错时可以选择不知道真实根因', () => {
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
    expect(submit.disabled).toBe(false);
    expect(screen.getByText('事件进行中也可以反馈，以最新一条为准。')).toBeTruthy();
  });

  it('已反馈时显示摘要，可以修改', () => {
    renderUi(<FeedbackControl {...base} latest={feedback()} state="given" />);
    expect(screen.getByRole('status').textContent).toContain('处置判断对 · 根因对 · oncall-a（console）');
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
          },
          { at: '2026-10-19T06:18:30Z', kind: 'change', text: '<b>deploy</b> by **bot**', ref: null, untrusted: true },
        ]}
      />,
    );
    const quote = screen.getByText('<b>deploy</b> by **bot**');
    expect(quote.closest('blockquote')).not.toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});
