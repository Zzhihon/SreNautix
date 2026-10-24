import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Alert, Incident, ResearchOutput, StageAReport } from '@srenautix/contract';
import type { ComposeInput } from '../../src/notify/compose.js';
import type { Subgraph } from '../../src/research/types.js';

/**
 * 通知报告的黄金用例（ADR 0125）：一次真实发布事故（发布后回退失败，worker 约 2 小时没有可用副本）在本机重建的
 * 事件、阶段 A 报告（133 张卡）、研判账本（4 个假设、3 项卡片检查）与研判子图，已脱敏（命名空间、版本号、节点名、uid）。
 * 研判的假设机制与修复建议取自一次真实的模型输出，经过数值审计。研判的开始与结束时间是样例值。
 */
interface ReportFixture {
  incident: Incident;
  stageA: StageAReport;
  alerts: Alert[];
  output: ResearchOutput;
  subgraph: Subgraph;
  endIncident: Incident;
}

const FILE = resolve(import.meta.dirname, '../fixtures/report/release-rollout-2026-10-20.json');

export const REPORT_LINKS = {
  metricsExploreUrl: 'https://vm.example.test/vmui/#/?g0.expr={query}&g0.range_input={range}&g0.end_input={to}',
  logsExploreUrl: null,
  alertmanagerUrl: 'https://alertmanager.example.test',
  argocdUrl: 'https://argocd.example.test',
  gitCommitUrl: null,
};

/**
 * 大事件（#13 的 ENTITIES_TOO_LONG）：在发布事故上扩成 70 个成员告警、53 张卡。每个成员告警的来源链接与 CCHP 的
 * vmalert 相同，是预填了表达式的 Grafana Explore 页面（JSON 再 URL 编码，每个 700 多字符），卡片带 vmui 的查询链接；
 * 链接的地址合计远超 Telegram 对一条消息实体总大小的上限。
 */
export function largeIncidentInput(): ComposeInput {
  const input = releaseRolloutInput();
  const stageA = { ...input.stageA!, cards: input.stageA!.cards.slice(0, 53) };
  const base = input.alerts;
  const alerts: Alert[] = [];
  const members: Incident['members'] = [];
  for (let i = 0; i < 70; i++) {
    const a = base[i % base.length]!;
    const pod = `${a.entity?.name ?? 'pod'}-${i}`;
    const id = `${a.fingerprint.slice(0, 12)}${String(i).padStart(4, '0')}@1792512360`;
    const expr =
      `sum by (namespace, pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="acme-prod",pod="${pod}",container!=""}[5m]))` +
      ` / sum by (namespace, pod) (rate(container_cpu_cfs_periods_total{namespace="acme-prod",pod="${pod}"}[5m])) > 0.25`;
    // 与 CCHP 的 vmalert 相同：generatorURL 是预填了规则表达式的 Grafana Explore 页面（-external.alert.source）
    const panes = {
      a: {
        datasource: 'victoriametrics',
        queries: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'victoriametrics' }, expr }],
        range: { from: 'now-6h', to: 'now' },
      },
    };
    alerts.push({
      ...a,
      alert_id: id,
      labels: { ...a.labels, pod },
      generator_url: `https://grafana.example.test/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`,
    });
    members.push({
      ...input.incident.members[i % input.incident.members.length]!,
      alert_id: id,
      alertname: a.alertname,
      left_version: null,
    });
  }
  return {
    ...input,
    stageA,
    researchStageA: stageA,
    alerts,
    incident: { ...input.incident, members },
  };
}

/** at：'as_of' 为分析时刻（17:05Z，未恢复）；'end' 为窗口末尾（事件已恢复） */
export function releaseRolloutInput(at: 'as_of' | 'end' = 'as_of'): ComposeInput {
  const fx = JSON.parse(readFileSync(FILE, 'utf8')) as ReportFixture;
  // 边缘 5xx 是用户可见的影响：领域包把这张卡标为 impact
  for (const c of fx.stageA.cards) {
    if (c.card_id.endsWith('edge/error-split')) {
      c.impact = true;
    }
  }
  const incident = at === 'end' ? { ...fx.endIncident, members: fx.endIncident.members } : fx.incident;
  return {
    incident,
    stageA: fx.stageA,
    researchStageA: fx.stageA,
    alerts: fx.alerts,
    research: {
      run_id: '5d9e3c1a-0000-4000-8000-0000000000aa',
      state: 'completed',
      disposition: fx.output.disposition,
      conclusion_level: fx.output.conclusion.level,
      root_component: fx.output.conclusion.root_component,
      output: fx.output,
      error: null,
      incident_version: fx.incident.incident_version,
      started_at: '2026-10-20T17:05:10.000Z',
      finished_at: '2026-10-20T17:07:40.000Z',
    },
    researchRootMismatch: true,
    researchPending: false,
    stageAOnlyReason: null,
    proposals: [],
    feedback: null,
    prefix: '[影子]',
    consoleUrl: 'https://srenautix.example.test',
    language: 'zh',
    subgraph: fx.subgraph,
    alertTitle: (a) => (a.alertname === 'AcmeWorkerNoAvailableReplicas' ? 'worker 没有可用副本' : null),
    actionVerify: (id) =>
      id === 'pod_restart'
        ? { windowSeconds: 300, checks: ['原 Pod 已移除，控制器有新的就绪 Pod，就绪副本数回到驱逐前'] }
        : null,
    links: REPORT_LINKS,
  };
}
