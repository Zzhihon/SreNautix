import type {
  Alert,
  ChangeEvent,
  ConsistencyDetail,
  Disposition,
  EvidenceResult,
  Feedback,
  Hypothesis,
  Incident,
  NotifyBlock,
  NotifyButton,
  NotifyMessage,
  NotifyRun,
  NotifySection,
  Proposal,
  ResearchOutput,
  StageAReport,
} from '@srenautix/contract';
import { displayComponentName, displayKey, tryNodeKey } from '@srenautix/core';
import { formatValue, type Unit } from '@srenautix/packs-sdk';
import { parseStoredKey } from '../topology/keys.js';
import type { Subgraph } from '../research/types.js';
import {
  alertLink,
  cardConsoleLink,
  cardQueryLink,
  changeLink,
  consoleIncident,
  NO_LINKS,
  type LinkSettings,
} from './links.js';
import type { ButtonTarget, DesiredIncidentMessage } from './ports.js';
import { businessSignals, SIGNAL_CATEGORIES, type SignalItem } from './signals.js';

// 事件消息（ADR 0125）：现状 → 关键问题 → 拓扑联系 → 解决方案 → 证据链。全部由模板与确定性数据生成：
// Incident、阶段 A 报告（证据卡与时间线）、研判输出（账本、检查、结论阶梯）、变更与动作目录。
// 模型写的文字只有假设机制、结论摘要、修复建议、无法判定的原因四处，标注【模型】并以斜体显示。
// 块的 scope：summary 只在聊天渠道（摘要），full 只在 issue（全文），all 两处都有。

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
  /** 研判所用的事件版本；card:<n> 按这个版本的阶段 A 报告编号 */
  incident_version?: number;
  started_at?: string | null;
  finished_at?: string | null;
}

/** 动作目录中执行后的校验（verify） */
export interface ActionVerify {
  windowSeconds: number;
  checks: string[];
}

export interface ComposeInput {
  incident: Incident;
  stageA: StageAReport;
  alerts: Alert[];
  research: ResearchMirror | null;
  /** 最近一次完成的研判根因与事件根因按属主粒度不一致（ADR 0104 §14）；只提示，事件不拆分 */
  researchRootMismatch?: boolean;
  /** 阶段 B 排队或进行中。 */
  researchPending: boolean;
  /** 阶段 B 被跳过的原因（风暴、预算、上限）。 */
  stageAOnlyReason: string | null;
  proposals: Proposal[];
  /** gitops_pr 提议 → 已开出的 PR 地址（ADR 0108）；没有时省略 */
  pulls?: ReadonlyMap<string, string>;
  feedback: Feedback | null;
  prefix: string;
  consoleUrl: string;
  language: Lang;
  /** 研判所用事件版本的阶段 A 报告；研判输出中的 card:<n> 按它编号。没有时用 stageA */
  researchStageA?: StageAReport | null;
  /** 研判子图（拓扑联系）；没有时不写拓扑联系 */
  subgraph?: Subgraph | null;
  /** 告警目录中的可读标题 */
  alertTitle?: (a: Alert) => string | null;
  /** 动作目录中执行后的校验 */
  actionVerify?: (actionId: string) => ActionVerify | null;
  /** 数据源、告警与变更的链接模板（控制台地址取 consoleUrl） */
  links?: Omit<LinkSettings, 'consoleUrl'>;
  /**
   * 根因是外部上游、但伴随业务影响而即时发送的事件（ADR 0147）：业务影响的信号（告警名或影响卡与值）及括号中与这个
   * 上游事件相关的依据（ADR 0150），横幅写“上游故障已影响业务”。其余事件为 null 或省略
   */
  upstreamImpact?: string[] | null;
}

const T = {
  zh: {
    disposition: { act: '处理', ignore: '忽略', escalate: '升级', undetermined: '无法判定' } as Record<string, string>,
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
    status: { supported: '支持', refuted: '推翻', pending: '待检验', inconclusive: '检验后仍无法判定' } as Record<
      string,
      string
    >,
    outcome: {
      supports: '支持',
      refutes: '推翻',
      inconclusive: '无法判定',
      failed: '失败',
      not_run: '未执行',
    } as Record<string, string>,
    verdict: { abnormal: '异常', normal: '正常', undeterminable: '无法判定', capability_missing: '能力缺失' } as Record<
      string,
      string
    >,
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
    sec: {
      situation: '现状',
      signals: '业务关键信号',
      timeline: '时间线',
      key_issue: '关键问题',
      topology: '拓扑联系',
      remedy: '解决方案',
      evidence: '证据链',
    },
    signal: { storage: '存储', memory: '内存', cpu: 'CPU', traffic: '流量负载', blocking: '阻塞' } as Record<
      string,
      string
    >,
    near: '接近阈值',
    signalCount: (cat: string, n: number) => `${cat} ${n} 项`,
    signalsMore: (counts: string) => `其余：${counts}，见控制台`,
    upstreamImpact: (signals: string) => `上游故障已影响业务：${signals}`,
    omitted: {
      signals: '业务关键信号已省略，见控制台',
      timeline: '时间线已省略，见控制台',
      key_issue: '关键问题已省略，见控制台',
      topology: '拓扑联系已省略，见控制台',
      remedy: '解决方案已省略，见控制台',
      evidence: '证据链已省略，见控制台',
    },
    title: (root: string | null, alerts: number) => `${root ?? '未定位根因'} · ${alerts} 条告警`,
    model: '【模型】',
    sep: '，',
    list: '、',
    colon: '：',
    console: '控制台',
    query: '查询',
    source: '来源',
    noRoot: '未定位根因',
    timelineHead: (d: string) => `时间线（UTC，${d}）`,
    firstAlert: '首个告警',
    created: '检测器建事件',
    firstCard: '首张异常卡',
    change: '变更',
    rolloutWord: '发布',
    rollbackWord: '回退到',
    runtimeConfigWord: '运行时配置',
    retireWord: '退役',
    plannedRetireWord: '计划内退役',
    pendingSyncNote: '（已合并、尚未同步）',
    pendingSyncCommits: (n: number) => `${n} 个已合并、尚未同步的提交`,
    and: '与',
    duringComma: '期间，',
    stop2: '。',
    firstAlertSince: ' 起首个告警',
    symptomsSince: ' 起出现症状',
    resolvedAfter: ' 恢复，持续 ',
    asOf: '截至 ',
    notResolved: ' 未恢复',
    escalated: '升为严重',
    symptom: '症状起点',
    stageA: (n: number, a: number, nn: number, u: number) => `阶段 A：${n} 张卡，${a} 异常、${nn} 正常、${u} 无法判定`,
    research: (h: number, c: number) => `研判结束：${h} 个假设、${c} 项检查`,
    researchPending: '研判中',
    alertFiring: '告警',
    alertResolved: '告警恢复',
    resolvedAt: '事件恢复',
    statementTail: (alerts: number, firing: number, comps: number) =>
      `${alerts} 条告警（${firing} 条触发中），${comps} 个组件。`,
    impact: '影响：',
    hours: (h: number, m: number) => (h ? `${h} 小时 ${m} 分` : `${m} 分钟`),
    conclusion: '结论：',
    lastResort: '由兜底线路研判：',
    lastResortWhy: '常规模型路由都依赖本事件涉及的组件',
    stageACandidate: '阶段 A 根因候选：',
    score: (s: number) => `得分 ${s.toFixed(2)}`,
    ambiguous: (m: number | null) => `有歧义，分差 ${m === null ? '-' : m.toFixed(2)}`,
    candidates: (n: number, s: number, m: number | null) =>
      `${n} 个候选，第一名得分 ${s.toFixed(2)}，与第二名分差 ${m === null ? '-' : m.toFixed(2)}`,
    dispositionLine: '处置：',
    stageAReason: '阶段 A：',
    why: (lvl: string, ok: number) => `为什么是“${lvl}”（代码判定，四项条件满足 ${ok} 项）：`,
    whyAll: '四项条件全部满足（代码判定）',
    ok: '满足',
    no: '不满足',
    c1: (n: number, checks: number) => `支持卡实体在假设范围内：${n} 张规则判定的卡（检查卡 ${checks} 张）`,
    c1alerts: (refs: string) => `只有成员告警支持（${refs}），没有范围内的异常卡`,
    c1none: '没有规则判定的支持卡',
    c2: '最早异常 ',
    c2b: '不晚于症状起点 ',
    c2late: '晚于症状起点 ',
    c2tol: (m: number) => ` + ${m} 分钟`,
    c2none: '支持卡没有可确定的异常起点',
    c3ok: '机制信号上没有相反的正常卡',
    c3: (n: number) => `同一信号上有 ${n} 张相反的正常卡：`,
    c4ok: (ids: string) => `检验并排除了竞争假设 ${ids}`,
    c4rivals: (ids: string) => `竞争假设 ${ids} 同样处于支持状态，检查没有区分它们`,
    c4none: '没有检验并排除任何竞争假设',
    ledgerPick: '模型弃权，由代码按账本选中，档位最高为“可能”',
    notChosen: '没有选中假设',
    mechanism: '机制：',
    summary: '摘要：',
    undeterminedReason: '无法判定的原因：',
    hypotheses: '假设：',
    hypStats: (s: number, c: number, k: number) => `支持证据 ${s}、相反卡 ${c}、检查 ${k} 项`,
    noCheck: '检查列表里没有这个组件，没有执行检查',
    rootMismatch: (research: string, incident: string) =>
      `研判根因（${research}）与发现根因（${incident}）不一致，事件没有拆分`,
    noTopology: '没有研判子图，拓扑联系见控制台',
    logical: '逻辑组件，没有拓扑边',
    noPath: '与根因之间没有两跳以内的拓扑边',
    alertsOn: (names: string) => `告警 ${names}`,
    proposal: (n: number) => `#${n} `,
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
    tier: (t: string) => `${t} 档`,
    execution: '执行进度：',
    pull: 'PR：',
    hTier: 'H 档提议只能在控制台审批',
    runbook: 'runbook：',
    noRemedy: '没有提议或建议',
    verify: '验证：',
    verifyCards: (refs: string) => `${refs} 重跑后转为正常`,
    verifyAlerts: (refs: string) => `${refs} 恢复`,
    verifyAction: (s: number, checks: string) => `执行后 ${s} 秒内：${checks}`,
    verifyNone: '没有关联的证据，按建议的步骤人工确认',
    steps: '步骤：',
    support: '支持',
    contrary: '相反',
    check: '检查',
    memberAlerts: (n: number) => `成员告警 ${n} 条：`,
    more: (n: number) => `其余 ${n} 张见控制台`,
    checks: '已执行的检查',
    abnormalCards: (n: number) => `阶段 A 的异常卡（${n} 张）`,
    noChecks: '没有执行区分性检查',
    checkFailed: '失败：',
    ruledOut: '排除与未定',
    refutedBy: '推翻：',
    excluded: '排除的信号：',
    excludedGroup: (n: number) => `${n} 张正常`,
    undet: (n: number) => `无法判定 ${n} 张：`,
    undetGroup: (titles: string, n: number, why: string) => `${titles} ${n} 张（${why}）`,
    alerts: '成员告警',
    changes: '变更',
    notes: '研判校验记录',
    since2: '自 ',
    threshold: '阈值 ',
    baseline: '基线 ',
    value: '值 ',
    noHit: '未命中异常条件',
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
    stopReason: {
      leader_supported: '第一的假设得到支持，竞争假设都已推翻或检验后无法判定',
      no_change: '连续两步没有变化或没有可执行的检查',
      step_limit: '达到步数上限',
      deadline: '达到期限',
      budget: '达到预算上限',
      model_unavailable: '模型不可用',
    } as Record<string, string>,
    stop: '停止原因：',
  },
  en: {
    disposition: { act: 'Act', ignore: 'Ignore', escalate: 'Escalate', undetermined: 'Undetermined' } as Record<
      string,
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
    status: { supported: 'supported', refuted: 'refuted', pending: 'pending', inconclusive: 'inconclusive' } as Record<
      string,
      string
    >,
    outcome: {
      supports: 'supports',
      refutes: 'refutes',
      inconclusive: 'inconclusive',
      failed: 'failed',
      not_run: 'not run',
    } as Record<string, string>,
    verdict: {
      abnormal: 'abnormal',
      normal: 'normal',
      undeterminable: 'undeterminable',
      capability_missing: 'capability missing',
    } as Record<string, string>,
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
    sec: {
      situation: 'Situation',
      signals: 'Business signals',
      timeline: 'Timeline',
      key_issue: 'Key issue',
      topology: 'Topology',
      remedy: 'Remedy',
      evidence: 'Evidence chain',
    },
    signal: { storage: 'Storage', memory: 'Memory', cpu: 'CPU', traffic: 'Traffic', blocking: 'Blocking' } as Record<
      string,
      string
    >,
    near: 'near the threshold',
    signalCount: (cat: string, n: number) => `${n} more ${cat.toLowerCase()}`,
    signalsMore: (counts: string) => `${counts} in the console`,
    upstreamImpact: (signals: string) => `Upstream failure is affecting the business: ${signals}`,
    omitted: {
      signals: 'Business signals omitted, see the console',
      timeline: 'Timeline omitted, see the console',
      key_issue: 'Key issue omitted, see the console',
      topology: 'Topology omitted, see the console',
      remedy: 'Remedy omitted, see the console',
      evidence: 'Evidence chain omitted, see the console',
    },
    title: (root: string | null, alerts: number) => `${root ?? 'root not located'} · ${alerts} alerts`,
    model: '[model] ',
    sep: ', ',
    list: ', ',
    colon: ': ',
    console: 'console',
    query: 'query',
    source: 'source',
    noRoot: 'root not located',
    timelineHead: (d: string) => `Timeline (UTC, ${d})`,
    firstAlert: 'first alert',
    created: 'incident created',
    firstCard: 'first abnormal card',
    change: 'change',
    rolloutWord: 'rollout',
    rollbackWord: 'rollback to',
    runtimeConfigWord: 'runtime config',
    retireWord: 'retirement',
    plannedRetireWord: 'planned retirement',
    pendingSyncNote: ' (merged, not synced)',
    pendingSyncCommits: (n: number) => `${n} merged commit${n === 1 ? '' : 's'} not synced`,
    and: ' and ',
    duringComma: ', during which ',
    stop2: '. ',
    firstAlertSince: ' first alert',
    symptomsSince: ' symptoms start',
    resolvedAfter: ' resolved after ',
    asOf: 'still firing at ',
    notResolved: '',
    escalated: 'escalated to critical',
    symptom: 'symptom onset',
    stageA: (n: number, a: number, nn: number, u: number) =>
      `stage A: ${n} cards, ${a} abnormal, ${nn} normal, ${u} undeterminable`,
    research: (h: number, c: number) => `research finished: ${h} hypotheses, ${c} checks`,
    researchPending: 'research in progress',
    alertFiring: 'alert',
    alertResolved: 'alert resolved',
    resolvedAt: 'incident resolved',
    statementTail: (alerts: number, firing: number, comps: number) =>
      `${alerts} alerts (${firing} firing), ${comps} components.`,
    impact: 'Impact: ',
    hours: (h: number, m: number) => (h ? `${h} h ${m} min` : `${m} min`),
    conclusion: 'Conclusion: ',
    lastResort: 'Researched on the last-resort route: ',
    lastResortWhy: 'every regular model route depends on a component of this incident',
    stageACandidate: 'Stage A root candidate: ',
    score: (s: number) => `score ${s.toFixed(2)}`,
    ambiguous: (m: number | null) => `ambiguous, margin ${m === null ? '-' : m.toFixed(2)}`,
    candidates: (n: number, s: number, m: number | null) =>
      `${n} candidates, top score ${s.toFixed(2)}, margin to the second ${m === null ? '-' : m.toFixed(2)}`,
    dispositionLine: 'Disposition: ',
    stageAReason: 'stage A: ',
    why: (lvl: string, ok: number) => `Why "${lvl}" (judged by code, ${ok} of 4 conditions hold):`,
    whyAll: 'All four conditions hold (judged by code)',
    ok: 'holds',
    no: 'fails',
    c1: (n: number, checks: number) => `support cards in scope: ${n} rule-judged cards (${checks} from checks)`,
    c1alerts: (refs: string) => `only member alerts support it (${refs}), no abnormal card in scope`,
    c1none: 'no rule-judged support card',
    c2: 'earliest anomaly ',
    c2b: ' is not later than the symptom onset ',
    c2late: ' is later than the symptom onset ',
    c2tol: (m: number) => ` + ${m} min`,
    c2none: 'no support card has a known anomaly onset',
    c3ok: 'no contrary normal card on the mechanism signals',
    c3: (n: number) => `${n} contrary normal cards on the same signals: `,
    c4ok: (ids: string) => `competitor ${ids} tested and ruled out`,
    c4rivals: (ids: string) => `competitor ${ids} is supported too; the checks did not separate them`,
    c4none: 'no competitor was tested and ruled out',
    ledgerPick: 'the model abstained; chosen from the ledger by code, at most "likely"',
    notChosen: 'no hypothesis chosen',
    mechanism: 'mechanism: ',
    summary: 'summary: ',
    undeterminedReason: 'why undetermined: ',
    hypotheses: 'Hypotheses:',
    hypStats: (s: number, c: number, k: number) => `${s} supporting, ${c} contrary, ${k} checks`,
    noCheck: 'no check is listed for this component; not checked',
    rootMismatch: (research: string, incident: string) =>
      `Research root (${research}) differs from the discovered root (${incident}); the incident was not split`,
    noTopology: 'no research subgraph; see the console for topology',
    logical: 'logical component, no topology edges',
    noPath: 'no topology edge within two hops of the root',
    alertsOn: (names: string) => `alerts ${names}`,
    proposal: (n: number) => `#${n} `,
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
    tier: (t: string) => `tier ${t}`,
    execution: 'Execution: ',
    pull: 'PR: ',
    hTier: 'Tier H proposals can only be approved in the console',
    runbook: 'Runbook: ',
    noRemedy: 'No proposals or recommendations',
    verify: 'Verify: ',
    verifyCards: (refs: string) => `${refs} turn normal on rerun`,
    verifyAlerts: (refs: string) => `${refs} resolve`,
    verifyAction: (s: number, checks: string) => `within ${s} s after execution: ${checks}`,
    verifyNone: 'no linked evidence; confirm by hand after the steps',
    steps: 'Steps: ',
    support: 'supports',
    contrary: 'contrary',
    check: 'check',
    memberAlerts: (n: number) => `${n} member alerts: `,
    more: (n: number) => `${n} more in the console`,
    checks: 'Checks run',
    abnormalCards: (n: number) => `Abnormal stage A cards (${n})`,
    noChecks: 'No discriminating checks were run',
    checkFailed: 'failed: ',
    ruledOut: 'Ruled out and undetermined',
    refutedBy: 'refuted: ',
    excluded: 'Ruled-out signals: ',
    excludedGroup: (n: number) => `${n} normal`,
    undet: (n: number) => `${n} undeterminable: `,
    undetGroup: (titles: string, n: number, why: string) => `${titles} ×${n} (${why})`,
    alerts: 'Member alerts',
    changes: 'Changes',
    notes: 'Validation notes',
    since2: 'from ',
    threshold: 'threshold ',
    baseline: 'baseline ',
    value: 'value ',
    noHit: 'no abnormal condition matched',
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
    stopReason: {
      leader_supported: 'the leading hypothesis is supported and the competitors are resolved',
      no_change: 'no change in two steps, or no runnable check',
      step_limit: 'step limit',
      deadline: 'deadline',
      budget: 'budget',
      model_unavailable: 'model unavailable',
    } as Record<string, string>,
    stop: 'Stop reason: ',
  },
};

type Dict = (typeof T)['zh'];

// ---- 富文本片段 ----
const P = (text: string): NotifyRun => ({ text, style: 'plain', href: null });
const B = (text: string): NotifyRun => ({ text, style: 'bold', href: null });
const C = (text: string): NotifyRun => ({ text, style: 'code', href: null });
const I = (text: string): NotifyRun => ({ text, style: 'italic', href: null });
const L = (text: string, href: string): NotifyRun => ({ text, style: 'plain', href });

type Scope = 'all' | 'summary' | 'full';

function blk(
  type: NotifyBlock['type'],
  runs: NotifyRun[],
  o: { scope?: Scope; model?: boolean; indent?: number } = {},
): NotifyBlock {
  const b: NotifyBlock = {
    type,
    text: runs.map((r) => r.text).join(''),
    source: null,
    model_generated: o.model ?? false,
    runs,
  };
  if (o.scope && o.scope !== 'all') {
    b.scope = o.scope;
  }
  if (o.indent) {
    b.indent = o.indent;
  }
  return b;
}
const text = (runs: NotifyRun[], o?: Parameters<typeof blk>[2]) => blk('text', runs, o);
const item = (runs: NotifyRun[], o?: Parameters<typeof blk>[2]) => blk('list_item', runs, o);
const heading = (t: string, o?: Parameters<typeof blk>[2]) => blk('heading', [B(t)], o);
/** 运行片段之间插入分隔 */
function joinRuns(parts: NotifyRun[][], sep: string): NotifyRun[] {
  return parts.flatMap((p, i) => (i ? [P(sep), ...p] : p));
}
/** 等宽写出的一串标识符 */
function codeList(items: readonly string[], sep: string): NotifyRun[] {
  const parts = items.map((s) => [C(s)]);
  return joinRuns(parts, sep);
}

// ---- 格式 ----
const ms = (iso: string) => Date.parse(iso);
/** HH:MM:SS（秒为 0 时 HH:MM）；日期与参照日不同时前面加 MM-DD */
function clock(iso: string, day?: string): string {
  const d = new Date(iso).toISOString();
  const hm = d.slice(11, 19).endsWith(':00') ? d.slice(11, 16) : d.slice(11, 19);
  return day && d.slice(0, 10) !== day ? `${d.slice(5, 10)} ${hm}` : hm;
}

/** 组件在消息中的写法（ADR 0101）：有可读名称时为“名称（组件键）”，否则为组件键；组件键可以直接在控制台搜索 */
function shortName(key: string, names?: Readonly<Record<string, string | undefined>> | null): string {
  return displayComponentName(key, names);
}

function entityKey(r: EvidenceResult): string | null {
  return r.entity ? tryNodeKey(r.entity.kind, r.entity.namespace, r.entity.name) : null;
}

function cardTitle(r: EvidenceResult, lang: Lang): string {
  const t = r.title as Record<string, string | undefined>;
  return (lang === 'zh' ? (t['zh-CN'] ?? t.en) : (t.en ?? t['zh-CN'])) ?? r.card_id;
}

function fmtNum(v: number, unit: string | undefined): string {
  return formatValue(v, (unit ?? 'none') as Unit);
}

function durationText(t: Dict, fromIso: string, toIso: string): string {
  const m = Math.max(0, Math.round((ms(toIso) - ms(fromIso)) / 60_000));
  return t.hours(Math.floor(m / 60), m % 60);
}

/** 卡片的实测值：命中的条件说明；正常时为没有命中的条件说明，或主值与阈值、基线，或观测值 */
function measure(t: Dict, r: EvidenceResult): NotifyRun[] {
  const conds = r.conditions ?? [];
  const hit = conds.find((c) => c.outcome === 'hit');
  const extras: NotifyRun[] = [];
  if (r.threshold !== null && r.threshold !== undefined) {
    extras.push(P(t.sep), P(t.threshold), C(fmtNum(r.threshold, r.unit)));
  }
  if (r.baseline !== null && r.baseline !== undefined) {
    extras.push(P(t.sep), P(t.baseline), C(fmtNum(r.baseline, r.unit)));
  }
  if (r.verdict === 'abnormal') {
    const said = hit?.say ?? r.reason.text;
    return [P(said), ...(r.value && !said.includes(r.value) ? [P(t.sep), P(t.value), C(r.value)] : []), ...extras];
  }
  if (r.verdict === 'normal') {
    const said = conds.filter((c) => c.outcome === 'miss' && c.say).map((c) => c.say as string);
    if (said.length) {
      return [P(said.join(t.sep)), ...extras];
    }
    if (r.value) {
      return [P(t.value), C(r.value), ...extras, P(t.sep), P(t.noHit)];
    }
    const obs = Object.entries(r.observations ?? {})
      .filter(([k, v]) => v !== null && k !== 'anomaly_started_at')
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(4)) : String(v)}`);
    return obs.length ? [C(obs.join(' ')), ...extras, P(t.sep), P(t.noHit)] : [P(r.reason.text), ...extras];
  }
  return [P(r.reason.text)];
}

/** 卡片的时间：异常起点或窗口 */
function cardTime(t: Dict, r: EvidenceResult, day: string): NotifyRun[] {
  if (r.verdict === 'abnormal' && r.anomaly_started_at) {
    return [P(t.since2), C(clock(r.anomaly_started_at, day))];
  }
  return [C(`${clock(r.window.from, day)}–${clock(r.window.to, day)}`)];
}

interface Ctx {
  t: Dict;
  lang: Lang;
  inc: Incident;
  names: Readonly<Record<string, string | undefined>> | undefined;
  links: LinkSettings;
  day: string;
  cards: Map<string, EvidenceResult>;
  alertsByRef: Map<string, Alert>;
  alertsById: Map<string, Alert>;
  changesByRef: Map<string, ChangeEvent>;
}

/** 一张证据卡的一行：标题 · 对象：实测 · 时间 · 判定 · 链接 */
function cardLine(x: Ctx, r: EvidenceResult, marker: string, scope: Scope, indent = 0): NotifyBlock {
  const t = x.t;
  const comp = entityKey(r);
  const links: NotifyRun[] = [P(' '), L(t.console, cardConsoleLink(x.links, x.inc.incident_id, r.ref))];
  const q = cardQueryLink(x.links, r);
  if (q) {
    links.push(P(' '), L(t.query, q));
  }
  return item(
    [
      P(`${marker} `),
      C(r.ref),
      P(' '),
      B(cardTitle(r, x.lang)),
      ...(comp ? [P(' · '), C(shortName(comp, x.names))] : []),
      P(t.colon),
      ...measure(t, r),
      P(' · '),
      ...cardTime(t, r, x.day),
      P(` · ${t.verdict[r.display_state] ?? r.verdict}`),
      ...links,
    ],
    { scope, indent },
  );
}

// ---- 拓扑 ----
const RELATION_REVERSE: Record<string, string> = { owned_by: 'owns', managed_by: 'manages' };
const RELATION_RANK: Record<string, number> = {
  owned_by: 0,
  owns: 0,
  managed_by: 0,
  manages: 0,
  depends_on: 1,
  egress_to: 1,
  calls: 1,
  routes_to: 1,
  selects: 1,
  runs_on: 2,
  mounts: 2,
  bound_to: 2,
  references: 3,
};

/** 根因到目标组件的路径（子图中最多 4 跳，无向搜索，记下每条边的方向） */
function pathTo(sg: Subgraph, from: string, to: string): Array<{ from: string; to: string; label: string }> | null {
  const adj = new Map<string, Array<{ next: string; label: string }>>();
  const add = (a: string, b: string, label: string) => adj.set(a, [...(adj.get(a) ?? []), { next: b, label }]);
  for (const e of sg.edges) {
    add(e.from, e.to, e.relation);
    add(e.to, e.from, RELATION_REVERSE[e.relation] ?? `←${e.relation}`);
  }
  // 同样跳数时优先走归属、管理与依赖边，最后才是配置引用
  const rank = (label: string) => RELATION_RANK[label.replace(/^←/, '')] ?? 4;
  for (const list of adj.values()) {
    list.sort((a, b) => rank(a.label) - rank(b.label));
  }
  const prev = new Map<string, { node: string; label: string }>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let d = 0; d < 4 && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of adj.get(n) ?? []) {
        if (!seen.has(e.next)) {
          seen.add(e.next);
          prev.set(e.next, { node: n, label: e.label });
          next.push(e.next);
        }
      }
    }
    frontier = next;
    if (seen.has(to)) {
      break;
    }
  }
  if (!seen.has(to)) {
    return null;
  }
  const out: Array<{ from: string; to: string; label: string }> = [];
  for (let cur = to; cur !== from;) {
    const p = prev.get(cur)!;
    out.unshift({ from: p.node, to: cur, label: p.label });
    cur = p.node;
  }
  return out;
}

/** 回退：版本退回到更早一次变更之前的版本（更早的变更从 c.revision 改到了 c.previous_revision） */
function isRollback(c: ChangeEvent, all: readonly ChangeEvent[]): boolean {
  return (
    c.revision !== null &&
    !!c.previous_revision &&
    all.some((o) => ms(o.time) < ms(c.time) && o.revision === c.previous_revision && o.previous_revision === c.revision)
  );
}

const DEPLOY_KINDS: ReadonlySet<string> = new Set(['rollout', 'gitops_sync', 'ci_deploy']);

/** 变更的动词：发布、回退到、计划内退役与退役（ADR 0161），其余为变更类型 */
function changeWord(t: Dict, c: ChangeEvent, all: readonly ChangeEvent[]): string {
  if (DEPLOY_KINDS.has(c.kind) && c.revision) {
    return isRollback(c, all) ? t.rollbackWord : t.rolloutWord;
  }
  if (c.kind === 'retire') {
    return c.planned_by?.length ? t.plannedRetireWord : t.retireWord;
  }
  return c.kind === 'runtime_config' ? t.runtimeConfigWord : c.kind;
}

/**
 * 变更的对象：版本；运行时配置变更（ADR 0151）的版本常常是整个配置对象的摘要，写改动的对象与动作；
 * 计划内的退役写计划依据的提交版本（ADR 0161）
 */
function changeSubject(c: ChangeEvent): string | null {
  if (c.kind === 'retire') {
    return c.planned_by?.[0]?.revision?.slice(0, 12) ?? null;
  }
  return c.kind === 'runtime_config' ? c.refs.join(' ') : c.revision;
}

/** 已合并、尚未同步的提交（ADR 0161） */
const pendingSync = (c: ChangeEvent) => (c.pending_sync?.length ?? 0) > 0;

function changeTitle(t: Dict, c: ChangeEvent, all: readonly ChangeEvent[]): string {
  const subject = changeSubject(c);
  return `${changeWord(t, c, all)}${subject ? ` ${subject}` : ''}${pendingSync(c) ? t.pendingSyncNote : ''}`;
}

/**
 * 事件里的变更按叙述分成两部分：其余变更逐条写；已合并、尚未同步的提交合成一句"N 个已合并、尚未同步的提交"，
 * 时刻取最早的一个（ADR 0161）。没有时为 null
 */
function changeRuns(
  t: Dict,
  changes: readonly ChangeEvent[],
  day: string,
): { each: ChangeEvent[]; pending: NotifyRun[] | null } {
  const pending = changes.filter(pendingSync);
  return {
    each: changes.filter((c) => !pendingSync(c)),
    pending: pending.length
      ? [
          P(`${t.pendingSyncCommits(pending.length)} `),
          C(pending.map((c) => changeSubject(c)?.slice(0, 7) ?? c.kind).join(' ')),
          P(`（${clock(pending.reduce((a, b) => (ms(a.time) <= ms(b.time) ? a : b)).time, day)}）`),
        ]
      : null,
  };
}

function topologySection(x: Ctx, sg: Subgraph | null, root: string | null, alerts: Alert[]): NotifyBlock[] {
  const t = x.t;
  if (!root) {
    return [text([P(t.noRoot)])];
  }
  const comps = [
    ...new Set([...x.inc.components, ...alerts.map((a) => a.component).filter((c): c is string => !!c)]),
  ].filter((c) => c !== root);
  const alertsOf = (c: string) => [...new Set(alerts.filter((a) => a.component === c).map((a) => a.alertname))];
  const changesFor = (keys: Set<string>) => x.inc.changes.filter((c) => c.targets.some((k) => keys.has(k)));
  const out: NotifyBlock[] = [];
  const rootAlerts = alertsOf(root);
  const rootChanges = changeRuns(t, changesFor(new Set([root])), x.day);
  out.push(
    text([
      ...rootChanges.each.flatMap((c) => [
        P(`${t.change} `),
        C(changeTitle(t, c, x.inc.changes)),
        P(`（${clock(c.time, x.day)}）⇒ `),
      ]),
      ...(rootChanges.pending ? [...rootChanges.pending, P('⇒ ')] : []),
      B(shortName(root, x.names)),
      ...(rootAlerts.length ? [P(' ⇒ '), P(t.alertsOn(rootAlerts.join(t.list)))] : []),
    ]),
  );
  if (!sg) {
    out.push(text([P(t.noTopology)]));
    return out;
  }
  comps.forEach((c, i) => {
    const scope: Scope = i < 5 ? 'all' : 'full';
    const names = alertsOf(c);
    const tail: NotifyRun[] = names.length ? [P(' ⇒ '), P(t.alertsOn(names.join(t.list)))] : [];
    if (c.startsWith('component:')) {
      out.push(item([C(shortName(c, x.names)), P(`（${t.logical}）`), ...tail], { scope }));
      return;
    }
    const path = pathTo(sg, root, c);
    if (!path) {
      out.push(item([C(shortName(c, x.names)), P(`（${t.noPath}）`), ...tail], { scope }));
      return;
    }
    // 每条链都从根因出发：根因写成纯文字，链上的其余对象写成等宽
    const runs: NotifyRun[] = [P(shortName(root, x.names))];
    for (const step of path) {
      const arrow = step.label.startsWith('←') ? ` ←${step.label.slice(1)}— ` : ` —${step.label}→ `;
      runs.push(P(arrow), C(shortName(step.to, x.names)));
    }
    out.push(item([...runs, ...tail], { scope }));
  });
  return out;
}

// ---- 业务关键信号（ADR 0148） ----
/**
 * 摘要中每类最多列出的项数，其余只在全文中。每项只有类别（粗体）、数值与阈值（等宽）三个实体，
 * 五类全满时 30 个，给消息其余部分留出 Telegram 的实体上限
 */
const SIGNALS_PER_CATEGORY = 2;

/** 信号的对象：可读名称，没有时为实体名（不带 kind 与命名空间，消息里一行要短） */
function signalObject(x: Ctx, r: EvidenceResult): string | null {
  const key = entityKey(r);
  if (!key) {
    return null;
  }
  return x.names?.[key] ?? r.entity?.name ?? null;
}

/** 一行一项：类别 对象 卡片标题 数值 / 阈值 · 命中的条件 · 时间 */
function signalLine(x: Ctx, s: SignalItem, scope: Scope): NotifyBlock {
  const t = x.t;
  const r = s.card;
  const obj = signalObject(x, r);
  const label = `${t.signal[s.category] ?? s.category}${t.colon}`;
  const runs: NotifyRun[] = [P(obj ? `${label}${obj} ${cardTitle(r, x.lang)}` : `${label}${cardTitle(r, x.lang)}`)];
  if (r.value) {
    runs.push(P(' '), C(r.value));
  }
  if (r.threshold !== null && r.threshold !== undefined) {
    runs.push(P(` / ${t.threshold}`), C(fmtNum(r.threshold, r.unit)));
  }
  if (s.near) {
    runs.push(P(` · ${t.near}`));
  } else {
    // 命中条件的说明；它已经写出了主值（例如“working set 峰值 96.5%”）时不再重复。只有一两个字符的主值（计数）不算
    const said = (r.conditions ?? []).find((c) => c.outcome === 'hit')?.say ?? r.reason.text;
    if (said && !(r.value && r.value.length >= 3 && said.includes(r.value))) {
      runs.push(P(` · ${said}`));
    }
  }
  const at =
    r.verdict === 'abnormal' && r.anomaly_started_at
      ? `${t.since2}${clock(r.anomaly_started_at, x.day)}`
      : `${clock(r.window.from, x.day)}–${clock(r.window.to, x.day)}`;
  runs.push(P(` · ${at}`));
  return item(runs, { scope });
}

function signalsBlocks(x: Ctx, cards: readonly EvidenceResult[]): NotifyBlock[] {
  const items = businessSignals(cards);
  const out: NotifyBlock[] = [];
  const rest: string[] = [];
  for (const cat of SIGNAL_CATEGORIES) {
    const of = items.filter((s) => s.category === cat);
    of.forEach((s, k) => out.push(signalLine(x, s, k < SIGNALS_PER_CATEGORY ? 'all' : 'full')));
    if (of.length > SIGNALS_PER_CATEGORY) {
      rest.push(x.t.signalCount(x.t.signal[cat] ?? cat, of.length - SIGNALS_PER_CATEGORY));
    }
  }
  if (rest.length) {
    out.push(item([P(x.t.signalsMore(rest.join(x.t.list)))], { scope: 'summary' }));
  }
  return out;
}

// ---- 研判 ----
function hypLabel(x: Ctx, h: Hypothesis): string {
  return `${h.id} ${shortName(h.root_component, x.names)}`;
}

function ladderBlocks(x: Ctx, out: ResearchOutput, chosen: Hypothesis | null): NotifyBlock[] {
  const t = x.t;
  const d: ConsistencyDetail | undefined = out.conclusion.consistency_detail;
  const lvl = t.level[out.conclusion.level] ?? out.conclusion.level;
  const blocks: NotifyBlock[] = [];
  if (!chosen) {
    blocks.push(text([B(t.notChosen)]));
    if (out.conclusion.undetermined_reason) {
      blocks.push(text([I(`${t.model}${t.undeterminedReason}${out.conclusion.undetermined_reason}`)], { model: true }));
    }
    return blocks;
  }
  const c = out.conclusion.consistency;
  const okCount = Object.values(c).filter(Boolean).length;
  if (out.conclusion.level === 'evidence_consistent') {
    blocks.push(text([P(t.whyAll)]));
  } else {
    blocks.push(text([P(t.why(lvl, okCount))]));
  }
  const mark = (ok: boolean) => B(ok ? t.ok : t.no);
  const refs = (rs: readonly string[]) => codeList(rs, t.list);
  if (!d) {
    for (const [k, v] of Object.entries(c)) {
      blocks.push(item([mark(v), P(`${t.colon}${k}`)]));
    }
    return blocks;
  }
  // 1. 实体在范围内
  const checkSupport = d.support_refs.filter((r) => x.cards.get(r)?.card_id.startsWith('check/')).length;
  blocks.push(
    item([
      mark(c.entity_in_scope),
      P(t.colon),
      P(
        d.support_refs.length
          ? t.c1(d.support_refs.length, checkSupport)
          : d.support_alerts.length
            ? t.c1alerts(d.support_alerts.join(t.list))
            : t.c1none,
      ),
    ]),
  );
  // 2. 异常起点
  blocks.push(
    item(
      d.onset
        ? [
            mark(c.onset_precedes_symptom),
            P(t.colon),
            P(t.c2),
            C(clock(d.onset.at, x.day)),
            P('（'),
            C(d.onset.ref),
            P('）'),
            P(c.onset_precedes_symptom ? t.c2b : t.c2late),
            C(clock(d.symptom_onset_at, x.day)),
            P(t.c2tol(d.tolerance_seconds / 60)),
          ]
        : [mark(false), P(t.colon), P(t.c2none)],
    ),
  );
  // 3. 相反的正常卡：按卡片标题归组，列出对象
  if (d.contrary_refs.length) {
    const groups = new Map<string, string[]>();
    for (const r of d.contrary_refs) {
      const card = x.cards.get(r);
      const k = card ? cardTitle(card, x.lang) : r;
      const comp = card ? entityKey(card) : null;
      groups.set(k, [...(groups.get(k) ?? []), comp ? parseStoredKey(comp).name : r]);
    }
    blocks.push(
      item([
        mark(false),
        P(t.colon),
        P(t.c3(d.contrary_refs.length)),
        ...refs(d.contrary_refs),
        P('（'),
        P([...groups].map(([k, v]) => `${k}：${[...new Set(v)].join(t.list)}`).join('；')),
        P('）'),
      ]),
    );
  } else {
    blocks.push(item([mark(true), P(t.colon), P(t.c3ok)]));
  }
  // 4. 竞争假设
  blocks.push(
    item([
      mark(c.competitor_tested),
      P(t.colon),
      P(
        d.supported_competitors.length
          ? t.c4rivals(d.supported_competitors.join(t.list))
          : d.tested_competitors.length
            ? t.c4ok(d.tested_competitors.join(t.list))
            : t.c4none,
      ),
    ]),
  );
  if (d.chosen_by === 'ledger') {
    blocks.push(text([P(t.ledgerPick)]));
  }
  return blocks;
}

function hypothesisOrder(out: ResearchOutput): Hypothesis[] {
  const rank: Record<string, number> = { supported: 0, pending: 1, inconclusive: 2, refuted: 3 };
  return [...out.hypotheses].sort(
    (a, b) =>
      Number(b.id === out.conclusion.hypothesis_id) - Number(a.id === out.conclusion.hypothesis_id) ||
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
      a.id.localeCompare(b.id),
  );
}

/** 支持卡排序：检查卡在前，其次按异常起点，最后按编号 */
function supportOrder(cards: EvidenceResult[]): EvidenceResult[] {
  const n = (r: string) => Number(r.split(':')[1]);
  return [...cards].sort(
    (a, b) =>
      Number(b.card_id.startsWith('check/')) - Number(a.card_id.startsWith('check/')) ||
      (a.anomaly_started_at ? ms(a.anomaly_started_at) : Infinity) -
        (b.anomaly_started_at ? ms(b.anomaly_started_at) : Infinity) ||
      n(a.ref) - n(b.ref),
  );
}

function evidenceBlocks(
  x: Ctx,
  out: ResearchOutput | null,
  report: StageAReport,
  subgraph: Subgraph | null,
): NotifyBlock[] {
  const t = x.t;
  const blocks: NotifyBlock[] = [];
  const shown = new Set<string>();
  if (out) {
    // 顺序：选中的假设、已执行的检查、其余假设；推翻的假设先列相反卡
    const groups: NotifyBlock[][] = [];
    for (const h of hypothesisOrder(out)) {
      const g: NotifyBlock[] = [];
      groups.push(g);
      // 摘要中选中的假设列 3 张支持卡与 2 张相反卡，其余假设列 2 张与 1 张
      const chosenHyp = h.id === out.conclusion.hypothesis_id;
      const maxSup = chosenHyp ? 3 : 2;
      const maxCon = chosenHyp ? 2 : 1;
      const sup = supportOrder(
        h.supporting.map((r) => x.cards.get(r)).filter((c): c is EvidenceResult => !!c && c.verdict === 'abnormal'),
      );
      const con = h.refuting.map((r) => x.cards.get(r)).filter((c): c is EvidenceResult => !!c);
      const alertRefs = h.supporting.filter((r) => r.startsWith('alert:'));
      const checks = out.next_checks.filter((c) => c.hypothesis_id === h.id && c.outcome !== 'failed').length;
      g.push(
        blk('heading', [
          B(hypLabel(x, h)),
          P(` · ${t.status[h.status] ?? h.status} · ${t.hypStats(sup.length + alertRefs.length, con.length, checks)}`),
        ]),
      );
      const supBlocks: NotifyBlock[] = [];
      sup.forEach((c, i) => {
        shown.add(c.ref);
        supBlocks.push(cardLine(x, c, '+', i < maxSup ? 'all' : 'full', 1));
      });
      if (sup.length > maxSup) {
        supBlocks.push(item([P(t.more(sup.length - maxSup))], { scope: 'summary', indent: 1 }));
      }
      const conBlocks: NotifyBlock[] = [];
      con.forEach((c, i) => {
        shown.add(c.ref);
        conBlocks.push(cardLine(x, c, '−', i < maxCon ? 'all' : 'full', 1));
      });
      if (con.length > maxCon) {
        conBlocks.push(item([P(t.more(con.length - maxCon))], { scope: 'summary', indent: 1 }));
      }
      g.push(...(h.status === 'refuted' ? [...conBlocks, ...supBlocks] : [...supBlocks, ...conBlocks]));
      if (alertRefs.length) {
        // 同名告警合并为一项，带条数
        const byName = new Map<string, Alert[]>();
        for (const r of alertRefs) {
          const a = x.alertsByRef.get(r);
          if (a) {
            byName.set(a.alertname, [...(byName.get(a.alertname) ?? []), a]);
          }
        }
        g.push(
          item(
            [
              P(t.memberAlerts(alertRefs.length)),
              ...joinRuns(
                [...byName].map(([name, as]) => {
                  const href = alertLink(x.links, as[0]!);
                  return [href ? L(name, href) : P(name), ...(as.length > 1 ? [P(` ×${as.length}`)] : [])];
                }),
                t.list,
              ),
            ],
            { indent: 1 },
          ),
        );
      }
      if (!sup.length && !con.length && !alertRefs.length && h.status === 'pending' && checks === 0) {
        g.push(item([P(t.noCheck)], { indent: 1 }));
      }
    }
    blocks.push(...(groups[0] ?? []));
    // 已执行的检查
    blocks.push(heading(t.checks));
    if (!out.next_checks.length) {
      blocks.push(item([P(t.noChecks)]));
    }
    for (const c of out.next_checks) {
      const card = c.result_ref ? x.cards.get(c.result_ref) : undefined;
      const target = c.template.includes('@') ? c.template.slice(c.template.lastIndexOf('@') + 1) : null;
      const name = card ? cardTitle(card, x.lang) : c.template;
      const runs: NotifyRun[] = [
        C(c.hypothesis_id),
        P(' · '),
        B(name),
        ...(target ? [P(' @ '), C(shortName(target, x.names))] : []),
        P(` → ${t.outcome[c.outcome] ?? c.outcome}`),
      ];
      if (card) {
        const verdict = t.verdict[card.display_state] ?? card.verdict;
        runs.push(P('（'), C(card.ref), P(` ${verdict}`), P(t.colon), ...measure(t, card), P('）'));
        runs.push(P(' '), L(t.console, cardConsoleLink(x.links, x.inc.incident_id, card.ref)));
        const q = cardQueryLink(x.links, card);
        if (q) {
          runs.push(P(' '), L(t.query, q));
        }
      }
      if (c.error) {
        runs.push(P(`（${t.checkFailed}${c.error}）`));
      }
      blocks.push(item(runs));
    }
    for (const g of groups.slice(1)) {
      blocks.push(...g);
    }
  } else {
    // 还没有研判：阶段 A 的异常卡按根因候选排序（候选上的卡在前），其次按异常起点
    const order = new Map(x.inc.candidates.map((c, k) => [c.component, k]));
    const abnormal = supportOrder(report.cards.filter((c) => c.verdict === 'abnormal')).sort((a, b) => {
      const ka = entityKey(a);
      const kb = entityKey(b);
      return (ka !== null ? (order.get(ka) ?? 99) : 99) - (kb !== null ? (order.get(kb) ?? 99) : 99);
    });
    if (abnormal.length) {
      blocks.push(heading(t.abnormalCards(abnormal.length)));
    }
    abnormal.forEach((c, k) => {
      shown.add(c.ref);
      blocks.push(cardLine(x, c, '+', k < 6 ? 'all' : 'full'));
    });
    if (abnormal.length > 6) {
      blocks.push(item([P(t.more(abnormal.length - 6))], { scope: 'summary' }));
    }
  }
  // 排除与未定
  blocks.push(heading(t.ruledOut));
  if (out) {
    for (const h of out.hypotheses.filter((y) => y.status === 'refuted')) {
      const why = h.status_reasons?.at(-1) ?? '';
      blocks.push(item([C(hypLabel(x, h)), P(` ${t.refutedBy}${why}`)]));
    }
  }
  // 根因、候选与它们拥有的对象上有数据的正常卡，按标题归组
  const focus = new Set<string>([
    ...(out?.conclusion.root_component ? [out.conclusion.root_component] : []),
    ...x.inc.candidates.map((c) => c.component),
    ...x.inc.components,
  ]);
  const owner = (k: string): string => {
    let cur = k;
    for (let i = 0; i < 4; i++) {
      const e = subgraph?.edges.find((y) => y.from === cur && y.relation === 'owned_by');
      if (!e) {
        break;
      }
      cur = e.to;
    }
    return cur;
  };
  const normal = report.cards.filter((c) => {
    const k = entityKey(c);
    return c.verdict === 'normal' && !shown.has(c.ref) && k !== null && (focus.has(k) || focus.has(owner(k)));
  });
  const groups = new Map<string, EvidenceResult[]>();
  for (const c of normal) {
    const k = cardTitle(c, x.lang);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  [...groups].forEach(([title, cs], i) => {
    const first = cs[0]!;
    const keys = cs.map((c) => entityKey(c)).filter((k): k is string => !!k);
    const comps = [...new Set(keys.map((k) => parseStoredKey(k).name))];
    blocks.push(
      item(
        [
          P(`${t.excluded}`),
          B(title),
          P(`（${t.excludedGroup(cs.length)}：${comps.slice(0, 6).join(t.list)}${comps.length > 6 ? '…' : ''}）`),
          P(t.colon),
          ...measure(t, first),
          P(' '),
          L(t.console, cardConsoleLink(x.links, x.inc.incident_id, first.ref)),
        ],
        { scope: i < 3 ? 'all' : 'full' },
      ),
    );
  });
  // 无法判定，按原因归组
  const undet = report.cards.filter((c) => c.verdict === 'undeterminable');
  if (undet.length) {
    const byReason = new Map<string, EvidenceResult[]>();
    for (const c of undet) {
      const k = c.reason.text;
      byReason.set(k, [...(byReason.get(k) ?? []), c]);
    }
    blocks.push(
      item([
        P(t.undet(undet.length)),
        P(
          [...byReason]
            .map(([why, cs]) =>
              t.undetGroup([...new Set(cs.map((c) => cardTitle(c, x.lang)))].join(t.list), cs.length, why),
            )
            .join('；'),
        ),
      ]),
    );
  }
  // 全文：成员告警、变更与校验记录
  blocks.push(heading(t.alerts, { scope: 'full' }));
  for (const [ref, a] of x.alertsByRef) {
    const href = alertLink(x.links, a);
    blocks.push(
      item(
        [
          C(ref),
          P(' '),
          href ? L(a.alertname, href) : B(a.alertname),
          P(` · ${a.severity} · `),
          ...(a.component ? [C(shortName(a.component, x.names)), P(' · ')] : []),
          C(clock(a.starts_at, x.day)),
          ...(a.ends_at ? [P('–'), C(clock(a.ends_at, x.day))] : []),
        ],
        { scope: 'full' },
      ),
    );
  }
  if (x.changesByRef.size) {
    blocks.push(heading(t.changes, { scope: 'full' }));
    for (const [ref, c] of x.changesByRef) {
      const href = changeLink(x.links, c);
      blocks.push(
        item(
          [
            C(ref),
            P(' '),
            C(clock(c.time, x.day)),
            P(' '),
            href ? L(changeTitle(t, c, x.inc.changes), href) : B(changeTitle(t, c, x.inc.changes)),
            P(` · ${c.source} ${c.kind} · `),
            P(c.summary),
            // 计划内退役的依据提交（ADR 0161）
            ...(c.planned_by ?? []).map((p) => P(` · ${p.summary}`)),
          ],
          { scope: 'full' },
        ),
      );
    }
  }
  if (out?.validation_notes.length) {
    blocks.push(heading(t.notes, { scope: 'full' }));
    for (const n of out.validation_notes) {
      blocks.push(item([P(n)], { scope: 'full' }));
    }
  }
  return blocks;
}

const fbVerdict = (f: Feedback) => f.verdict ?? f.disposition_verdict ?? f.implicit ?? '';

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
 * 从事件状态生成渠道无关的消息（DESIGN §11、ADR 0125）：模板渲染，中英文文案固定，数值只取确定性数据。
 */
export function composeMessage(i: ComposeInput): { message: NotifyMessage; targets: ButtonTarget[] } {
  const t = T[i.language];
  const inc = i.incident;
  const names = inc.component_names;
  const links: LinkSettings = { consoleUrl: i.consoleUrl, ...(i.links ?? NO_LINKS) };
  const out = i.research?.state === 'completed' ? i.research.output : null;
  const report = out && i.researchStageA ? i.researchStageA : i.stageA;
  const members = inc.members.filter((m) => m.left_version === null);
  const alertsById = new Map(i.alerts.map((a) => [a.alert_id, a]));
  const day = new Date(inc.first_firing_at).toISOString().slice(0, 10);
  // 证据编号：阶段 A 的卡、检查卡、成员告警（按事件成员顺序）、变更
  const cards = new Map<string, EvidenceResult>([...report.cards, ...(out?.check_cards ?? [])].map((c) => [c.ref, c]));
  const alertsByRef = new Map<string, Alert>();
  members.forEach((m, k) => {
    const a = alertsById.get(m.alert_id);
    if (a) {
      alertsByRef.set(`alert:${k + 1}`, a);
    }
  });
  const changesByRef = new Map(inc.changes.map((c, k) => [`change:${k + 1}`, c]));
  const x: Ctx = { t, lang: i.language, inc, names, links, day, cards, alertsByRef, alertsById, changesByRef };
  const alerts = members.map((m) => alertsById.get(m.alert_id)).filter((a): a is Alert => !!a);
  const root = out?.conclusion.root_component ?? inc.root.component;
  const rootShort = root ? shortName(root, names) : t.noRoot;
  /** 标题用可读名称，没有时用组件键 */
  const rootTitle = root ? (names?.[root] ?? displayKey(root)) : null;

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
  if (i.upstreamImpact?.length) {
    const impact = t.upstreamImpact(i.upstreamImpact.slice(0, 3).join(t.list));
    banner = banner ? `${impact}${i.language === 'zh' ? '；' : '; '}${banner}` : impact;
  }

  // ---- 症状短语：触发中的 symptom 告警，没有时为 critical 的告警；目录标题优先 ----
  const titleOf = (a: Alert) => i.alertTitle?.(a) ?? a.alertname;
  const firing = members.filter((m) => m.status === 'firing');
  const pick = firing.filter((m) => m.role === 'symptom');
  const pool = pick.length ? pick : firing.filter((m) => m.severity === 'critical');
  const symptoms = [
    ...new Set(
      (pool.length ? pool : members).map((m) => {
        const a = alertsById.get(m.alert_id);
        return a ? titleOf(a) : m.alertname;
      }),
    ),
  ].slice(0, 3);
  const headline: NotifyRun[] = [P(`${rootShort}${t.colon}${symptoms.join(t.list)}`)];

  // ---- 现状：问题陈述 ----
  const relevant = new Set([...inc.components, ...inc.candidates.map((c) => c.component), ...(root ? [root] : [])]);
  const changes = inc.changes.filter((c) => c.targets.some((k) => relevant.has(k)));
  const namespaces = [
    ...new Set(
      inc.components
        .map((k) => {
          try {
            return parseStoredKey(k).namespace;
          } catch {
            return null;
          }
        })
        .filter((n): n is string => !!n && !n.startsWith('argocd')),
    ),
  ].slice(0, 2);
  const nowIso = i.research?.finished_at ?? i.stageA.rendered_at;
  const symptomMembers = members.filter((m) => m.role === 'symptom').map((m) => m.starts_at);
  const symptomAt = symptomMembers.length ? symptomMembers.reduce((a, b) => (ms(a) <= ms(b) ? a : b)) : null;
  // 首个告警：事件的首次触发（包括之后离开事件的成员）
  const firstAlert = inc.first_firing_at;
  const impactCards = report.cards.filter((c) => c.impact && c.verdict === 'abnormal');
  const statement: NotifyRun[] = [
    C(`${inc.cluster_id}${namespaces.length ? `/${namespaces.join(',')}` : ''}`),
    P(t.colon),
  ];
  if (changes.length) {
    const split = changeRuns(t, changes, day);
    statement.push(
      ...joinRuns(
        [
          ...split.each.map((c) => [
            P(`${changeWord(t, c, inc.changes)} `),
            C(changeSubject(c) ?? c.kind),
            P(`（${clock(c.time, day)}）`),
          ]),
          ...(split.pending ? [split.pending] : []),
        ],
        t.and,
      ),
      P(t.duringComma),
    );
  }
  statement.push(B(rootShort), P(t.colon), P(symptoms.join(t.list)), P(t.stop2));
  statement.push(C(clock(firstAlert, day)), P(t.firstAlertSince));
  if (symptomAt) {
    statement.push(P(t.sep), C(clock(symptomAt, day)), P(t.symptomsSince));
  }
  statement.push(P(t.sep));
  if (inc.state === 'resolved' && inc.ended_at) {
    statement.push(C(clock(inc.ended_at, day)), P(t.resolvedAfter), P(durationText(t, firstAlert, inc.ended_at)));
  } else {
    statement.push(P(t.asOf), C(clock(nowIso, day)), P(t.notResolved));
  }
  statement.push(P(t.stop2));
  if (impactCards.length) {
    statement.push(
      P(t.impact),
      ...joinRuns(
        impactCards.map((c) => [
          P(`${cardTitle(c, i.language)} `),
          C(c.value ?? '-'),
          ...(c.threshold !== null ? [P(`（${t.threshold}`), C(fmtNum(c.threshold, c.unit)), P('）')] : []),
        ]),
        t.list,
      ),
      P(t.stop2),
    );
  }
  statement.push(P(t.statementTail(members.length, firing.length, inc.components.length)));
  const situation: NotifyBlock[] = [text(statement)];
  if (i.feedback && !i.feedback.stale) {
    situation.push(text([P(t.feedback(fbVerdict(i.feedback), i.feedback.principal_id))]));
  }
  // 告警注解原文（不可信文本）作为引用块：头条症状告警的第一条摘要在聊天里也出现，其余只在全文中，相同的摘要只引用一次
  const headlineIds = new Set(pool.map((m) => m.alert_id));
  const quoted = [...alerts].sort((a, b) => Number(headlineIds.has(b.alert_id)) - Number(headlineIds.has(a.alert_id)));
  const seenQuotes = new Set<string>();
  for (const a of quoted) {
    if (seenQuotes.size >= 3) {
      break;
    }
    const s = a.annotations.summary ?? a.annotations.description;
    if (!s || seenQuotes.has(s)) {
      continue;
    }
    seenQuotes.add(s);
    const source = `${t.alertFiring} ${a.alertname}`;
    situation.push({
      type: 'quote',
      text: s,
      source,
      model_generated: false,
      scope: seenQuotes.size === 1 ? 'all' : 'full',
    });
  }

  // ---- 时间线 ----
  interface Entry {
    at: string;
    runs: NotifyRun[];
    key: boolean;
  }
  const entries: Entry[] = [];
  const alertRun = (a: Alert | undefined, name: string): NotifyRun => {
    const href = a ? alertLink(links, a) : null;
    return href ? L(name, href) : B(name);
  };
  // 首个告警取全部成员（包括之后离开事件的），与检测器建事件同一时刻时写在同一行
  const firstMember = [...inc.members].sort((a, b) => ms(a.starts_at) - ms(b.starts_at))[0];
  const createdTogether = firstMember !== undefined && Math.abs(ms(firstMember.starts_at) - ms(inc.created_at)) < 1000;
  if (firstMember) {
    entries.push({
      at: firstMember.starts_at,
      key: true,
      runs: [
        P(`${t.firstAlert} `),
        alertRun(alertsById.get(firstMember.alert_id), firstMember.alertname),
        ...(firstMember.component ? [P(' · '), C(shortName(firstMember.component, names))] : []),
        ...(createdTogether ? [P(`${t.sep}${t.created}`)] : []),
      ],
    });
  }
  if (!createdTogether) {
    entries.push({ at: inc.created_at, key: true, runs: [P(t.created)] });
  }
  const firstCard = report.timeline.find((e) => e.kind === 'card_abnormal' && e.ref && cards.get(e.ref));
  if (firstCard) {
    const c = cards.get(firstCard.ref!)!;
    entries.push({
      at: firstCard.at,
      key: true,
      runs: [P(`${t.firstCard} `), C(c.ref), P(' '), B(cardTitle(c, i.language)), P(t.colon), ...measure(t, c)],
    });
  }
  inc.changes.forEach((c) => {
    const href = changeLink(links, c);
    entries.push({
      at: c.time,
      key: true,
      runs: [
        P(`${t.change} `),
        href ? L(changeTitle(t, c, inc.changes), href) : C(changeTitle(t, c, inc.changes)),
        P(' → '),
        P(
          c.targets
            .filter((k) => !k.startsWith('Job:') && !k.startsWith('Application.argoproj.io:'))
            .map((k) => parseStoredKey(k).name)
            .join(t.list),
        ),
      ],
    });
  });
  const firstCritical = [...members]
    .filter((m) => m.severity === 'critical')
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at))[0];
  if (firstCritical && firstCritical !== firstMember) {
    entries.push({
      at: firstCritical.starts_at,
      key: true,
      runs: [P(`${t.escalated} `), alertRun(alertsById.get(firstCritical.alert_id), firstCritical.alertname)],
    });
  }
  if (symptomAt) {
    const sm = members.filter((m) => m.role === 'symptom' && m.starts_at === symptomAt);
    const names2 = sm.map((m) => [alertRun(alertsById.get(m.alert_id), m.alertname)]);
    entries.push({ at: symptomAt, key: true, runs: [P(`${t.symptom} `), ...joinRuns(names2, t.list)] });
  }
  for (const m of members) {
    if (m === firstMember || m === firstCritical || (m.role === 'symptom' && m.starts_at === symptomAt)) {
      continue;
    }
    entries.push({
      at: m.starts_at,
      key: false,
      runs: [
        P(`${t.alertFiring} `),
        alertRun(alertsById.get(m.alert_id), m.alertname),
        ...(m.component ? [P(' · '), C(shortName(m.component, names))] : []),
      ],
    });
    if (m.ends_at) {
      entries.push({ at: m.ends_at, key: false, runs: [P(`${t.alertResolved} `), P(m.alertname)] });
    }
  }
  const counts = (v: string) => report.cards.filter((c) => c.verdict === v).length;
  const stageALine = t.stageA(report.cards.length, counts('abnormal'), counts('normal'), counts('undeterminable'));
  entries.push({ at: report.rendered_at, key: true, runs: [P(stageALine)] });
  if (out && i.research?.finished_at) {
    const researchLine = t.research(out.hypotheses.length, out.next_checks.length);
    entries.push({ at: i.research.finished_at, key: true, runs: [P(researchLine)] });
  }
  if (inc.state === 'resolved' && inc.ended_at) {
    entries.push({ at: inc.ended_at, key: true, runs: [P(t.resolvedAt)] });
  }
  entries.sort((a, b) => ms(a.at) - ms(b.at));
  const timeline: NotifyBlock[] = [];
  // 摘要中同一时刻的关键条目合并为一行，最多 9 行
  let keyLines = 0;
  for (const e of entries) {
    const scope: Scope = e.key && keyLines < 9 ? 'all' : 'full';
    if (scope === 'all') {
      keyLines++;
    }
    timeline.push(item([C(clock(e.at, day)), P(' '), ...e.runs], { scope }));
  }

  // ---- 关键问题 ----
  const keyIssue: NotifyBlock[] = [];
  const chosen = out ? (out.hypotheses.find((h) => h.id === out.conclusion.hypothesis_id) ?? null) : null;
  if (out) {
    keyIssue.push(
      text([
        B(`${t.conclusion}${t.level[out.conclusion.level] ?? out.conclusion.level}（${out.conclusion.level}）`),
        ...(chosen ? [P(' · '), C(shortName(chosen.root_component, names)), P(`（${chosen.id}）`)] : []),
      ]),
    );
    // 结论来自兜底路由（ADR 0152）：紧跟结论标明路由与模型
    if (out.last_resort_route) {
      keyIssue.push(
        text([
          B(t.lastResort),
          C(out.last_resort_route.route_id),
          P(`（${out.last_resort_route.model}）${t.sep}${t.lastResortWhy}`),
        ]),
      );
    }
  } else {
    const top = inc.candidates[0];
    const ambiguity = inc.root.ambiguous ? `${t.sep}${t.ambiguous(inc.root.margin)}` : '';
    keyIssue.push(
      text([B(t.stageACandidate), C(rootShort), ...(top ? [P(`（${t.score(top.score)}${ambiguity}）`)] : [])]),
    );
    inc.candidates.slice(1, 3).forEach((c, k) => {
      keyIssue.push(item([P(`${k + 2}. `), C(shortName(c.component, names)), P(`（${t.score(c.score)}）`)]));
    });
  }
  const disposition = out?.disposition ?? i.stageA.disposition;
  keyIssue.push(
    text([
      P(t.dispositionLine),
      B(t.disposition[disposition] ?? disposition),
      P(` · ${t.stageAReason}${t.dispositionReason[i.stageA.disposition_reason] ?? i.stageA.disposition_reason}`),
      ...(inc.root.ambiguous && inc.candidates[0]
        ? [P(`（${t.candidates(inc.candidates.length, inc.candidates[0].score, inc.root.margin)}）`)]
        : []),
    ]),
  );
  if (out) {
    keyIssue.push(...ladderBlocks(x, out, chosen));
    if (chosen) {
      keyIssue.push(text([I(`${t.model}${t.mechanism}${chosen.mechanism}`)], { model: true }));
    }
    if (out.summary) {
      keyIssue.push(text([I(`${t.model}${t.summary}${out.summary}`)], { model: true, scope: 'full' }));
    }
    if (i.researchRootMismatch && out.conclusion.root_component && inc.root.component) {
      const mismatch = t.rootMismatch(
        shortName(out.conclusion.root_component, names),
        shortName(inc.root.component, names),
      );
      keyIssue.push(text([P(mismatch)]));
    }
    if (out.stop_reason) {
      keyIssue.push(text([P(t.stop), P(t.stopReason[out.stop_reason] ?? out.stop_reason)], { scope: 'full' }));
    }
    keyIssue.push(text([P(t.hypotheses)], { scope: 'full' }));
    for (const h of hypothesisOrder(out)) {
      if (h.id === chosen?.id) {
        continue;
      }
      keyIssue.push(item([C(hypLabel(x, h)), P(` · ${t.status[h.status] ?? h.status}`)], { scope: 'full' }));
      keyIssue.push(text([I(`${t.model}${t.mechanism}${h.mechanism}`)], { model: true, scope: 'full', indent: 1 }));
    }
  }

  // ---- 拓扑联系 ----
  const topology = topologySection(x, i.subgraph ?? null, root, alerts);

  // ---- 解决方案 ----
  const remedy: NotifyBlock[] = [];
  const nums = numbered(i.proposals.filter((p) => p.state !== 'duplicate'));
  for (const { n, p } of nums) {
    remedy.push(
      item([
        B(t.proposal(n)),
        C(p.action),
        P(' → '),
        C(p.target.display),
        P(`（${t.tier(p.tier)}${t.sep}${t.proposalState[p.state] ?? p.state}）`),
      ]),
    );
    const v = i.actionVerify?.(p.action);
    if (v && v.checks.length) {
      remedy.push(text([P(t.verify), P(t.verifyAction(v.windowSeconds, v.checks.join('；')))], { indent: 1 }));
    }
    if (p.execution) {
      remedy.push(text([P(t.execution), C(p.execution.phase)], { indent: 1 }));
    }
    const pr = i.pulls?.get(p.proposal_id);
    if (pr) {
      remedy.push(text([P(t.pull), L(pr, pr)], { indent: 1 }));
    }
    if (p.state === 'awaiting_approval' && p.tier === 'H') {
      remedy.push(text([P(t.hTier)], { indent: 1 }));
    }
  }
  (out?.recommendations ?? []).forEach((r, k) => {
    const scope: Scope = k < 3 ? 'all' : 'full';
    const runs: NotifyRun[] = [C(r.id), P(' '), r.generated_by === 'model' ? I(`${t.model}${r.title}`) : B(r.title)];
    if (r.action_id) {
      runs.push(P(' · '), C(r.action_id));
    }
    remedy.push(item(runs, { scope, model: r.generated_by === 'model' }));
    if (r.steps.length) {
      const steps = [I(`${t.model}${t.steps}`), ...codeList(r.steps, '；')];
      remedy.push(text(steps, { scope: 'full', model: true, indent: 1 }));
    }
    const refCards = r.evidence_refs.filter((e) => cards.get(e)?.verdict === 'abnormal');
    const refAlerts = r.evidence_refs.filter((e) => {
      const a = alertsByRef.get(e);
      return a && a.status === 'firing';
    });
    const verify: NotifyRun[][] = [];
    if (refCards.length) {
      verify.push([P(t.verifyCards(refCards.join(t.list)))]);
    }
    if (refAlerts.length) {
      verify.push([P(t.verifyAlerts(refAlerts.map((e) => alertsByRef.get(e)!.alertname).join(t.list)))]);
    }
    if (r.action_id) {
      const v = i.actionVerify?.(r.action_id);
      if (v && v.checks.length) {
        verify.push([P(t.verifyAction(v.windowSeconds, v.checks.join('；')))]);
      }
    }
    const verifyRuns = verify.length ? joinRuns(verify, '；') : [P(t.verifyNone)];
    remedy.push(text([P(t.verify), ...verifyRuns], { scope, indent: 1 }));
  });
  if (i.stageA.runbooks.length) {
    remedy.push(text([P(t.runbook), ...codeList(i.stageA.runbooks.slice(0, 3), t.list)]));
  }
  if (!remedy.length) {
    remedy.push(text([P(t.noRemedy)]));
  }

  // ---- 证据链 ----
  const evidence = evidenceBlocks(x, out, report, i.subgraph ?? null);

  // ---- 业务关键信号：现状之后、关键问题之前；没有异常或接近阈值的信号时整段不出现 ----
  const signals = signalsBlocks(x, [...cards.values()]);

  const sections: NotifySection[] = [
    { kind: 'situation', title: t.sec.situation, priority: 0, blocks: situation },
    ...(signals.length
      ? [
          {
            kind: 'signals' as const,
            title: t.sec.signals,
            priority: 7,
            omitted: t.omitted.signals,
            blocks: signals,
          },
        ]
      : []),
    {
      kind: 'situation',
      title: t.timelineHead(day.slice(5)),
      priority: 4,
      omitted: t.omitted.timeline,
      blocks: timeline,
    },
    { kind: 'key_issue', title: t.sec.key_issue, priority: 6, omitted: t.omitted.key_issue, blocks: keyIssue },
    { kind: 'topology', title: t.sec.topology, priority: 3, omitted: t.omitted.topology, blocks: topology },
    { kind: 'remedy', title: t.sec.remedy, priority: 5, omitted: t.omitted.remedy, blocks: remedy },
    {
      kind: 'evidence',
      title: t.sec.evidence,
      priority: 2,
      folded: true,
      omitted: t.omitted.evidence,
      blocks: evidence,
    },
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
          url: consoleLink(`/actions/${p.proposal_id}`),
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
    url: consoleIncident(links, inc.incident_id),
  });

  return {
    message: {
      incident_id: inc.incident_id,
      incident_version: inc.incident_version,
      prefix: i.prefix,
      severity: inc.severity,
      title: `${t.title(rootTitle, members.length)} · ${t.state[inc.state] ?? inc.state}`.slice(0, 200),
      headline,
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
