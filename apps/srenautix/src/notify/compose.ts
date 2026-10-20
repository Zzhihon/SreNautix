import type {
  Alert,
  Disposition,
  Feedback,
  Incident,
  NotifyBlock,
  NotifyButton,
  NotifyMessage,
  NotifySection,
  Proposal,
  ResearchOutput,
  StageAReport,
} from '@srenautix/contract';
import type { ButtonTarget, DesiredIncidentMessage } from './ports.js';

type Lang = 'zh' | 'en';

/** worker 研判在 server 侧的镜像（server.research_runs）。 */
export interface ResearchMirror {
  run_id: string;
  state: string;
  disposition: Disposition | null;
  conclusion_level: string | null;
  root_component: string | null;
  output: ResearchOutput | null;
  error: { kind?: string; message?: string } | null;
}

export interface ComposeInput {
  incident: Incident;
  stageA: StageAReport;
  alerts: Alert[];
  research: ResearchMirror | null;
  /** 阶段 B 排队或进行中。 */
  researchPending: boolean;
  /** 阶段 B 被跳过的原因（风暴、预算、上限）。 */
  stageAOnlyReason: string | null;
  proposals: Proposal[];
  feedback: Feedback | null;
  prefix: string;
  consoleUrl: string;
  language: Lang;
}

const T = {
  zh: {
    disposition: { act: '处理', ignore: '忽略', escalate: '升级', undetermined: '无法判定' } as Record<
      Disposition,
      string
    >,
    dispositionReason: {
      suppressed: '命中抑制规则',
      pack_exclude: '命中领域包的排除规则',
      forecast_or_chronic_only: '只有预测类与长期告警',
      rule_action: '有动作明确的规则提议',
      critical_ambiguous: 'critical 且根因有歧义',
      observability_blind: '观测失明：至少一半的证据卡没有数据',
      default: '证据不足以给出处理或忽略',
    } as Record<string, string>,
    level: {
      evidence_consistent: '证据一致',
      likely: '可能',
      inconclusive: '待确认',
      undetermined: '无法判定',
    } as Record<string, string>,
    state: { firing: '未恢复', resolved: '已恢复', merged: '已合并' } as Record<string, string>,
    banner: {
      degraded: '状态库降级：本消息由内存中的数据生成，恢复后补写',
      pending: '模型研判中，以下为确定性报告',
      invalid: '模型输出无效，以下为确定性报告',
      failed: '模型研判失败，以下为确定性报告',
      stageAOnly: '只出确定性报告：',
      blind: '观测失明：至少一半的证据卡没有数据',
    },
    skipReason: {
      budget: '当日模型预算已用到上限',
      storm: '告警风暴中，只研判排名靠前的根因',
      capped: '该事件 6 小时内已研判 3 次',
      no_model_route: '没有可用的模型路由（全部被出站策略禁用）',
    } as Record<string, string>,
    title: (root: string | null, alerts: number) => `${root ?? '未定位根因'} · ${alerts} 条告警`,
    disp: (d: string, r: string) => `处置判断：${d}（${r}）`,
    members: (n: number, c: number) => `${n} 条告警，涉及 ${c} 个组件`,
    root: (c: string, ambiguous: boolean, margin: number | null) =>
      `根因候选：${c}${ambiguous ? `（有歧义，分差 ${margin?.toFixed(2) ?? '-'}）` : ''}`,
    candidate: (i: number, c: string, s: number) => `${i}. ${c}（得分 ${s.toFixed(2)}）`,
    silent: '根因由探测卡发现，没有指向它的告警',
    conclusion: (lvl: string, c: string | null) => `研判结论：${lvl}${c ? ` · ${c}` : ''}`,
    proposal: (n: number, action: string, target: string, tier: string, state: string) =>
      `#${n} ${action} → ${target}（${tier} 档，${state}）`,
    proposalState: {
      awaiting_approval: '待审批',
      approved: '已批准，等待执行',
      held: '软暂停中',
      dispatched: '已下发',
      rejected: '已拒绝',
      rejected_by_policy: '策略拒绝',
      expired: '已过期',
      stale: '已失效',
      duplicate: '重复',
    } as Record<string, string>,
    execution: (phase: string) => `执行进度：${phase}`,
    hTier: 'H 档提议只能在控制台审批',
    runbook: (r: string) => `runbook：${r}`,
    noRemedy: '没有提议或建议',
    abnormal: (title: string, v: string | null) => `异常 · ${title}${v ? `：${v}` : ''}`,
    normal: (n: number) => `${n} 张证据卡正常（已排除）`,
    undeterminable: (n: number) => `${n} 张证据卡无法判定`,
    alertSource: (name: string) => `告警 ${name}`,
    changeSource: (src: string) => `变更 ${src}`,
    feedback: (v: string, who: string) => `已反馈：${v} · ${who}`,
    fbConfirm: '结论对',
    fbReject: '结论错',
    dpConfirm: '处置对',
    dpReject: '处置错',
    approve: (n: number) => `批准 #${n}`,
    reject: (n: number) => `拒绝 #${n}`,
    undo: (n: number) => `撤销 #${n}`,
    approveInConsole: (n: number) => `在控制台审批 #${n}`,
    resolved: '恢复确认',
    open: '在控制台打开',
  },
  en: {
    disposition: { act: 'Act', ignore: 'Ignore', escalate: 'Escalate', undetermined: 'Undetermined' } as Record<
      Disposition,
      string
    >,
    dispositionReason: {
      suppressed: 'matched a suppression rule',
      pack_exclude: 'matched a pack exclusion rule',
      forecast_or_chronic_only: 'only forecast and chronic alerts',
      rule_action: 'a rule proposal with a clear action',
      critical_ambiguous: 'critical with an ambiguous root cause',
      observability_blind: 'observability blind: at least half of the cards have no data',
      default: 'evidence does not support act or ignore',
    } as Record<string, string>,
    level: {
      evidence_consistent: 'evidence consistent',
      likely: 'likely',
      inconclusive: 'inconclusive',
      undetermined: 'undetermined',
    } as Record<string, string>,
    state: { firing: 'firing', resolved: 'resolved', merged: 'merged' } as Record<string, string>,
    banner: {
      degraded: 'State store degraded: built from in-memory data, written back on recovery',
      pending: 'Model research in progress; deterministic report below',
      invalid: 'Model output invalid; deterministic report below',
      failed: 'Model research failed; deterministic report below',
      stageAOnly: 'Deterministic report only: ',
      blind: 'Observability blind: at least half of the cards have no data',
    },
    skipReason: {
      budget: 'daily model budget reached',
      storm: 'alert storm, only the top-ranked roots are researched',
      capped: 'researched 3 times in the last 6 hours',
      no_model_route: 'no usable model route (all disabled by the egress policy)',
    } as Record<string, string>,
    title: (root: string | null, alerts: number) => `${root ?? 'root not located'} · ${alerts} alerts`,
    disp: (d: string, r: string) => `Disposition: ${d} (${r})`,
    members: (n: number, c: number) => `${n} alerts across ${c} components`,
    root: (c: string, ambiguous: boolean, margin: number | null) =>
      `Root candidate: ${c}${ambiguous ? ` (ambiguous, margin ${margin?.toFixed(2) ?? '-'})` : ''}`,
    candidate: (i: number, c: string, s: number) => `${i}. ${c} (score ${s.toFixed(2)})`,
    silent: 'Found by a probe card; no alert points at it',
    conclusion: (lvl: string, c: string | null) => `Conclusion: ${lvl}${c ? ` · ${c}` : ''}`,
    proposal: (n: number, action: string, target: string, tier: string, state: string) =>
      `#${n} ${action} → ${target} (tier ${tier}, ${state})`,
    proposalState: {
      awaiting_approval: 'awaiting approval',
      approved: 'approved, waiting for execution',
      held: 'held by soft pause',
      dispatched: 'dispatched',
      rejected: 'rejected',
      rejected_by_policy: 'rejected by policy',
      expired: 'expired',
      stale: 'stale',
      duplicate: 'duplicate',
    } as Record<string, string>,
    execution: (phase: string) => `Execution: ${phase}`,
    hTier: 'Tier H proposals can only be approved in the console',
    runbook: (r: string) => `Runbook: ${r}`,
    noRemedy: 'No proposals or recommendations',
    abnormal: (title: string, v: string | null) => `Abnormal · ${title}${v ? `: ${v}` : ''}`,
    normal: (n: number) => `${n} cards normal (ruled out)`,
    undeterminable: (n: number) => `${n} cards undeterminable`,
    alertSource: (name: string) => `alert ${name}`,
    changeSource: (src: string) => `change ${src}`,
    feedback: (v: string, who: string) => `Feedback: ${v} · ${who}`,
    fbConfirm: 'Root correct',
    fbReject: 'Root wrong',
    dpConfirm: 'Disposition correct',
    dpReject: 'Disposition wrong',
    approve: (n: number) => `Approve #${n}`,
    reject: (n: number) => `Reject #${n}`,
    undo: (n: number) => `Undo #${n}`,
    approveInConsole: (n: number) => `Approve #${n} in console`,
    resolved: 'Confirm recovery',
    open: 'Open in console',
  },
};

const text = (t: string, model = false): NotifyBlock => ({
  type: 'text',
  text: t,
  source: null,
  model_generated: model,
});
const item = (t: string, model = false): NotifyBlock => ({
  type: 'list_item',
  text: t,
  source: null,
  model_generated: model,
});
const quote = (t: string, source: string): NotifyBlock => ({ type: 'quote', text: t, source, model_generated: false });

const MAX_QUOTES = 3;

/** 消息里的提议编号与渠道按钮共用：按创建时间排序。 */
function numbered(ps: Proposal[]): Array<{ n: number; p: Proposal }> {
  return [...ps]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.proposal_id.localeCompare(b.proposal_id))
    .map((p, i) => ({ n: i + 1, p }));
}

function undoable(p: Proposal): boolean {
  return (
    (p.level === 'reversible' || p.level === 'reversible_recreatable') &&
    p.state === 'dispatched' &&
    p.execution !== null &&
    ['verified', 'verifying'].includes(p.execution.phase)
  );
}

/**
 * 从事件状态生成渠道无关的消息（DESIGN §11）：模板渲染，中英文文案固定，不经过模型。
 * 四段依次为现状与背景、问题根源、解决方案、相关证据；模型写的段落标注 model_generated；告警与变更原文放在引用块中并注明来源。
 */
export function composeMessage(i: ComposeInput): { message: NotifyMessage; targets: ButtonTarget[] } {
  const t = T[i.language];
  const inc = i.incident;
  const out = i.research?.state === 'completed' ? i.research.output : null;
  const members = inc.members.filter((m) => m.left_version === null);
  const alertsById = new Map(i.alerts.map((a) => [a.alert_id, a]));

  let banner: string | null = null;
  if (i.stageA.degraded) {
    banner = t.banner.degraded;
  } else if (i.researchPending) {
    banner = t.banner.pending;
  } else if (i.research?.state === 'failed') {
    banner = i.research.error?.kind === 'invalid_output' ? t.banner.invalid : t.banner.failed;
  } else if (i.research?.state === 'stage_a_only') {
    banner = `${t.banner.stageAOnly}${i.research.error?.message ?? ''}`;
  } else if (i.stageAOnlyReason) {
    banner = `${t.banner.stageAOnly}${t.skipReason[i.stageAOnlyReason] ?? i.stageAOnlyReason}`;
  } else if (i.stageA.observability_blind) {
    banner = t.banner.blind;
  }

  const disposition = out?.disposition ?? i.stageA.disposition;
  const situation: NotifyBlock[] = [
    text(
      t.disp(
        t.disposition[disposition],
        out
          ? (t.level[out.conclusion.level] ?? out.conclusion.level)
          : (t.dispositionReason[i.stageA.disposition_reason] ?? ''),
      ),
    ),
  ];
  if (out) {
    situation.push(text(out.situation, true));
  }
  situation.push(text(t.members(members.length, inc.components.length)));
  let quotes = 0;
  for (const m of members) {
    const a = alertsById.get(m.alert_id);
    const summary = a?.annotations.summary ?? a?.annotations.description;
    if (a && summary && quotes < MAX_QUOTES) {
      situation.push(quote(summary, t.alertSource(a.alertname)));
      quotes++;
    }
  }
  for (const c of inc.changes.slice(0, 2)) {
    situation.push(quote(c.summary, t.changeSource(c.source)));
  }

  const root: NotifyBlock[] = [];
  if (inc.root.component) {
    root.push(text(t.root(inc.root.component, inc.root.ambiguous, inc.root.margin)));
  }
  if (inc.root.silent_root) {
    root.push(text(t.silent));
  }
  inc.candidates.slice(0, 3).forEach((c, k) => root.push(item(t.candidate(k + 1, c.component, c.score))));
  if (out) {
    root.push(text(t.conclusion(t.level[out.conclusion.level] ?? out.conclusion.level, out.conclusion.root_component)));
    const h = out.hypotheses.find((x) => x.id === out.conclusion.hypothesis_id);
    if (h) {
      root.push(text(h.mechanism, true));
    } else if (out.conclusion.undetermined_reason) {
      root.push(text(out.conclusion.undetermined_reason, true));
    }
  }

  const remedy: NotifyBlock[] = [];
  const nums = numbered(i.proposals.filter((p) => p.state !== 'duplicate'));
  for (const { n, p } of nums) {
    remedy.push(item(t.proposal(n, p.action, p.target.display, p.tier, t.proposalState[p.state] ?? p.state)));
    if (p.execution) {
      remedy.push(text(t.execution(p.execution.phase)));
    }
    if (p.state === 'awaiting_approval' && p.tier === 'H') {
      remedy.push(text(t.hTier));
    }
  }
  for (const r of out?.recommendations.slice(0, 3) ?? []) {
    remedy.push(item(`${r.title}：${r.steps[0] ?? ''}`, r.generated_by === 'model'));
  }
  for (const r of i.stageA.runbooks.slice(0, 2)) {
    remedy.push(text(t.runbook(r)));
  }
  if (!remedy.length) {
    remedy.push(text(t.noRemedy));
  }

  const evidence: NotifyBlock[] = [];
  const cards = i.stageA.cards;
  for (const c of cards.filter((x) => x.verdict === 'abnormal').slice(0, 6)) {
    evidence.push(item(t.abnormal(c.card_id, c.value)));
  }
  const normal = cards.filter((x) => x.verdict === 'normal').length;
  const undet = cards.filter((x) => x.verdict === 'undeterminable').length;
  if (normal) {
    evidence.push(text(t.normal(normal)));
  }
  if (undet) {
    evidence.push(text(t.undeterminable(undet)));
  }
  if (i.feedback && !i.feedback.stale) {
    evidence.push(
      text(
        t.feedback(
          i.feedback.verdict ?? i.feedback.disposition_verdict ?? i.feedback.implicit ?? '',
          i.feedback.principal_id,
        ),
      ),
    );
  }

  const sections: NotifySection[] = [
    { kind: 'situation', blocks: situation },
    { kind: 'root_cause', blocks: root },
    { kind: 'remedy', blocks: remedy },
    { kind: 'evidence', blocks: evidence },
  ];

  const buttons: NotifyButton[] = [];
  const targets: ButtonTarget[] = [];
  const base = {
    incidentId: inc.incident_id,
    incidentVersion: inc.incident_version,
    researchRunId: i.research?.run_id ?? null,
    rootComponent: null,
    disposition: null,
    choices: [] as string[],
  };
  const add = (kind: NotifyButton['kind'], label: string, key: string, extra: Partial<ButtonTarget> = {}) => {
    buttons.push({ kind, label, callback: key, url: null });
    targets.push({ ...base, key, kind, proposalId: null, tier: null, ...extra });
  };
  const consoleLink = (path: string) => `${i.consoleUrl.replace(/\/+$/, '')}${path}`;
  for (const { n, p } of nums) {
    if (p.state === 'awaiting_approval') {
      if (p.tier === 'L') {
        add('approve', t.approve(n), `approve:${p.proposal_id}`, { proposalId: p.proposal_id, tier: 'L' });
      } else {
        buttons.push({
          kind: 'open_console',
          label: t.approveInConsole(n),
          callback: null,
          url: consoleLink(`/proposals/${p.proposal_id}`),
        });
      }
      add('reject', t.reject(n), `reject:${p.proposal_id}`, { proposalId: p.proposal_id, tier: p.tier });
    } else if (undoable(p)) {
      add('undo', t.undo(n), `undo:${p.proposal_id}`, { proposalId: p.proposal_id, tier: p.tier });
    }
  }
  const concluded = out?.conclusion.root_component ?? (i.research ? null : inc.root.component);
  const scope = i.research?.run_id ?? `v${inc.incident_version}`;
  if (concluded) {
    const choices = [
      ...new Set([
        ...inc.components,
        ...inc.candidates.map((c) => c.component),
        ...(out?.hypotheses.map((h) => h.root_component) ?? []),
      ]),
    ];
    add('feedback_confirm', t.fbConfirm, `fbc:${scope}`, { rootComponent: concluded });
    add('feedback_reject', t.fbReject, `fbr:${scope}`, { choices });
  }
  add('disposition_confirm', t.dpConfirm, `dpc:${scope}`, { disposition });
  add('disposition_reject', t.dpReject, `dpr:${scope}`, { disposition });
  if (inc.state === 'resolved') {
    add('resolved_confirm', t.resolved, `rc:${inc.incident_id}`);
  }
  buttons.push({
    kind: 'open_console',
    label: t.open,
    callback: null,
    url: consoleLink(`/incidents/${inc.incident_id}`),
  });

  return {
    message: {
      incident_id: inc.incident_id,
      incident_version: inc.incident_version,
      prefix: i.prefix,
      severity: inc.severity,
      title: `${t.title(inc.root.component, members.length)} · ${t.state[inc.state] ?? inc.state}`.slice(0, 200),
      sections,
      buttons,
      banner,
    },
    targets,
  };
}

export function laneOf(inc: Incident, proposals: Proposal[]): DesiredIncidentMessage['lane'] {
  if (inc.state === 'resolved' || inc.state === 'merged') {
    return 'recovery';
  }
  if (inc.severity === 'critical' || proposals.some((p) => p.state === 'awaiting_approval')) {
    return 'urgent';
  }
  return 'edit';
}
