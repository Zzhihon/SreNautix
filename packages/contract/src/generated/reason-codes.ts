// 本文件由 packages/contract/scripts/gen.ts 从 contract/ 生成，不要手工修改。
import type { ReasonCodeEntry, ReasonCodeGroup } from './types.js';

/** 各阶段登记的原因码 */
export interface ReasonCodesByStage {
  notify:
    | 'delivered'
    | 'final_edit'
    | 'ended_edit_cap'
    | 'entities_too_long'
    | 'message_too_long'
    | 'parse_error'
    | 'bad_request'
    | 'content_too_long'
    | 'invalid_card'
    | 'invalid_param'
    | 'withheld_planned_retirement'
    | 'withheld_external_digest'
    | 'withheld_suppressed'
    | 'withheld_severity';
  stage_a: 'stage_a_failed' | 'stage_a_missing';
  research:
    | 'model_unavailable'
    | 'breaker_open'
    | 'budget_exhausted'
    | 'deadline'
    | 'invalid_output'
    | 'datasource'
    | 'internal'
    | 'leader_supported'
    | 'no_change'
    | 'step_limit'
    | 'budget'
    | 'storm'
    | 'capped'
    | 'no_model_route'
    | 'lease_expired'
    | 'superseded'
    | 'not_researched';
  remediation:
    | 'not_applicable'
    | 'layout_missing'
    | 'input_failed'
    | 'evaluation_error'
    | 'skip_if'
    | 'target_not_found'
    | 'ambiguous_target'
    | 'no_change'
    | 'guard'
    | 'cause_scope'
    | 'topology_only'
    | 'no_runtime_evidence'
    | 'no_repo_fact'
    | 'not_benign'
    | 'duplicate_open'
    | 'duplicate_pending'
    | 'rejected_before'
    | 'rejected_cooldown'
    | 'incident_closed'
    | 'incident_changed'
    | 'no_root'
    | 'no_fingerprint'
    | 'no_template'
    | 'per_run_limit'
    | 'internal_error'
    | 'repository_missing'
    | 'plan_error'
    | 'validation_failed'
    | 'policy'
    | 'gateway_propose_only'
    | 'target_unresolved'
    | 'binding_stale';
  issue: 'opened' | 'external_root' | 'rate_limit' | 'failed';
  incident: 'resolved' | 'reopened' | 'suppressed' | 'persist_failed';
}

/** 各分组登记的原因码 */
export interface ReasonCodesByGroup {
  notify_delivery: 'delivered' | 'final_edit';
  notify_abandon:
    | 'ended_edit_cap'
    | 'entities_too_long'
    | 'message_too_long'
    | 'parse_error'
    | 'bad_request'
    | 'content_too_long'
    | 'invalid_card'
    | 'invalid_param';
  notify_permanent:
    | 'entities_too_long'
    | 'message_too_long'
    | 'parse_error'
    | 'bad_request'
    | 'content_too_long'
    | 'invalid_card'
    | 'invalid_param';
  notify_withheld:
    'withheld_planned_retirement' | 'withheld_external_digest' | 'withheld_suppressed' | 'withheld_severity';
  stage_a: 'stage_a_failed' | 'stage_a_missing';
  research_failure:
    | 'model_unavailable'
    | 'breaker_open'
    | 'budget_exhausted'
    | 'deadline'
    | 'invalid_output'
    | 'datasource'
    | 'internal';
  research_stop: 'model_unavailable' | 'deadline' | 'leader_supported' | 'no_change' | 'step_limit' | 'budget';
  research_skip: 'budget' | 'storm' | 'capped' | 'no_model_route';
  research_ended: 'lease_expired' | 'superseded' | 'not_researched';
  remediation_plan:
    | 'not_applicable'
    | 'layout_missing'
    | 'input_failed'
    | 'evaluation_error'
    | 'skip_if'
    | 'target_not_found'
    | 'ambiguous_target'
    | 'no_change'
    | 'guard';
  remediation_admission: 'cause_scope' | 'topology_only' | 'no_runtime_evidence' | 'no_repo_fact' | 'not_benign';
  remediation_dedupe: 'duplicate_open' | 'duplicate_pending' | 'rejected_before' | 'rejected_cooldown';
  remediation_run:
    | 'incident_closed'
    | 'incident_changed'
    | 'no_root'
    | 'no_fingerprint'
    | 'no_template'
    | 'per_run_limit'
    | 'internal_error';
  remediation_template:
    | 'per_run_limit'
    | 'repository_missing'
    | 'plan_error'
    | 'validation_failed'
    | 'policy'
    | 'gateway_propose_only'
    | 'target_unresolved'
    | 'binding_stale';
  issue: 'opened' | 'external_root' | 'rate_limit' | 'failed';
  incident: 'resolved' | 'reopened' | 'suppressed' | 'persist_failed';
}

export const REASON_CODE_GROUPS: Record<keyof ReasonCodesByGroup, ReasonCodeGroup> = {
  notify_delivery: { stage: 'notify', description: '事件消息的投递结果' },
  notify_abandon: {
    stage: 'notify',
    description: '放弃投递一版消息内容的原因（srenautix_notify_abandoned_total 的 reason 标签）',
  },
  notify_permanent: {
    stage: 'notify',
    description: '渠道以永久错误拒绝消息内容的原因（Telegram 的 400、飞书的内容错误）',
  },
  notify_withheld: { stage: 'notify', description: '通知引擎决定不推送事件消息的原因' },
  stage_a: { stage: 'stage_a', description: '阶段 A 没有报告的原因' },
  research_failure: {
    stage: 'research',
    description: 'worker 的研判失败类型（events.schema.json 的 ResearchFailed.kind）',
  },
  research_stop: {
    stage: 'research',
    description:
      '检验循环的停止原因（research-output.schema.json 的 stop_reason，openapi.yaml 的 ResearchRun.stop_reason）',
  },
  research_skip: {
    stage: 'research',
    description: '阶段 B 入队时跳过、只出阶段 A 的原因（server.research_queue.skip_reason）',
  },
  research_ended: { stage: 'research', description: 'server 判定的研判终态：租约过期、被取代、不进入阶段 B' },
  remediation_plan: { stage: 'remediation', description: '修复模板计划跳过的原因（packs-sdk 的 SkipCode）' },
  remediation_admission: { stage: 'remediation', description: '自愈 PR 的准入条件不满足的原因（ADR 0170）' },
  remediation_dedupe: { stage: 'remediation', description: '同一个修改已有提议、PR 或被拒绝过（ADR 0155）' },
  remediation_run: { stage: 'remediation', description: '整次研判没有可处理模板的原因（模板 key 为 -）' },
  remediation_template: { stage: 'remediation', description: '单个模板没有开出提议的原因' },
  issue: { stage: 'issue', description: '事件 issue 的结果' },
  incident: { stage: 'incident', description: '事件状态的变化与写入失败' },
};

export const REASON_CODES: readonly ReasonCodeEntry[] = [
  {
    code: 'delivered',
    stage: 'notify',
    level: 'info',
    groups: ['notify_delivery'],
    text: { 'zh-CN': '消息已送达', en: 'message delivered' },
  },
  {
    code: 'final_edit',
    stage: 'notify',
    level: 'warning',
    groups: ['notify_delivery'],
    text: {
      'zh-CN': '事件结束后编辑次数达到上限，最后一次编辑改为精简内容，之后不再更新',
      en: 'edit limit reached after the incident ended; the last edit condensed the message and updates stopped',
    },
  },
  {
    code: 'ended_edit_cap',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon'],
    text: {
      'zh-CN': '事件结束后编辑次数达到上限，最后一次编辑也被拒绝',
      en: 'edit limit reached after the incident ended and the last edit was rejected',
    },
  },
  {
    code: 'entities_too_long',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：格式实体超过上限', en: 'rejected by the channel: too many entities' },
  },
  {
    code: 'message_too_long',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：消息过长', en: 'rejected by the channel: message too long' },
  },
  {
    code: 'parse_error',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：格式无法解析', en: 'rejected by the channel: entities cannot be parsed' },
  },
  {
    code: 'bad_request',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：请求无效', en: 'rejected by the channel: bad request' },
  },
  {
    code: 'content_too_long',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：卡片内容过长', en: 'rejected by the channel: card content too long' },
  },
  {
    code: 'invalid_card',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：卡片无效', en: 'rejected by the channel: invalid card' },
  },
  {
    code: 'invalid_param',
    stage: 'notify',
    level: 'error',
    groups: ['notify_abandon', 'notify_permanent'],
    text: { 'zh-CN': '渠道拒绝：参数无效', en: 'rejected by the channel: invalid parameter' },
  },
  {
    code: 'withheld_planned_retirement',
    stage: 'notify',
    level: 'info',
    groups: ['notify_withheld'],
    text: {
      'zh-CN': '不推送：全部告警由计划内的退役解释',
      en: 'not pushed: every alert is explained by a planned retirement',
    },
  },
  {
    code: 'withheld_external_digest',
    stage: 'notify',
    level: 'info',
    groups: ['notify_withheld'],
    text: {
      'zh-CN': '不推送：根因是外部上游且没有业务影响，进入周期汇总',
      en: 'not pushed: external upstream root without business impact, included in the periodic digest',
    },
  },
  {
    code: 'withheld_suppressed',
    stage: 'notify',
    level: 'info',
    groups: ['notify_withheld'],
    text: { 'zh-CN': '不推送：事件被抑制', en: 'not pushed: the incident is suppressed' },
  },
  {
    code: 'withheld_severity',
    stage: 'notify',
    level: 'info',
    groups: ['notify_withheld'],
    text: {
      'zh-CN': '不推送：严重度不在推送范围内',
      en: 'not pushed: the severity is outside the notified severities',
    },
  },
  {
    code: 'stage_a_failed',
    stage: 'stage_a',
    level: 'error',
    groups: ['stage_a'],
    text: { 'zh-CN': '阶段 A 执行失败', en: 'stage A failed' },
  },
  {
    code: 'stage_a_missing',
    stage: 'stage_a',
    level: 'error',
    groups: ['stage_a'],
    text: {
      'zh-CN': '阶段 A 补跑 3 次仍然失败，当前版本没有报告',
      en: 'stage A still failed after 3 retries; the current version has no report',
    },
  },
  {
    code: 'model_unavailable',
    stage: 'research',
    level: 'warning',
    groups: ['research_failure', 'research_stop'],
    text: { 'zh-CN': '模型不可用', en: 'model unavailable' },
  },
  {
    code: 'breaker_open',
    stage: 'research',
    level: 'warning',
    groups: ['research_failure'],
    text: {
      'zh-CN': '模型路由不可用（熔断，或全部被出站策略禁用）',
      en: 'model routes unavailable (breaker open, or all disabled by the egress policy)',
    },
  },
  {
    code: 'budget_exhausted',
    stage: 'research',
    level: 'warning',
    groups: ['research_failure'],
    text: { 'zh-CN': '当日模型预算达到研判上限', en: 'daily model budget reached the research limit' },
  },
  {
    code: 'deadline',
    stage: 'research',
    level: 'warning',
    groups: ['research_failure', 'research_stop'],
    text: { 'zh-CN': '达到研判期限', en: 'research deadline reached' },
  },
  {
    code: 'invalid_output',
    stage: 'research',
    level: 'error',
    groups: ['research_failure'],
    text: { 'zh-CN': '模型输出无效', en: 'model output invalid' },
  },
  {
    code: 'datasource',
    stage: 'research',
    level: 'error',
    groups: ['research_failure'],
    text: { 'zh-CN': '数据源不可用', en: 'data source unavailable' },
  },
  {
    code: 'internal',
    stage: 'research',
    level: 'error',
    groups: ['research_failure'],
    text: { 'zh-CN': '研判内部错误', en: 'internal research error' },
  },
  {
    code: 'leader_supported',
    stage: 'research',
    level: 'info',
    groups: ['research_stop'],
    text: {
      'zh-CN': '第一的假设得到支持，竞争假设都已推翻或检验后无法判定',
      en: 'the leading hypothesis is supported and the competitors are resolved',
    },
  },
  {
    code: 'no_change',
    stage: 'research',
    level: 'info',
    groups: ['research_stop'],
    text: { 'zh-CN': '连续两步没有变化或没有可执行的检查', en: 'no change in two steps, or no runnable check' },
  },
  {
    code: 'step_limit',
    stage: 'research',
    level: 'info',
    groups: ['research_stop'],
    text: { 'zh-CN': '达到步数上限', en: 'step limit reached' },
  },
  {
    code: 'budget',
    stage: 'research',
    level: 'warning',
    groups: ['research_stop', 'research_skip'],
    text: { 'zh-CN': '模型预算达到上限', en: 'model budget reached' },
  },
  {
    code: 'storm',
    stage: 'research',
    level: 'info',
    groups: ['research_skip'],
    text: { 'zh-CN': '告警风暴中，只研判排名靠前的根因', en: 'alert storm, only the top-ranked roots are researched' },
  },
  {
    code: 'capped',
    stage: 'research',
    level: 'warning',
    groups: ['research_skip'],
    text: { 'zh-CN': '该事件 6 小时内已研判 3 次', en: 'researched 3 times in the last 6 hours' },
  },
  {
    code: 'no_model_route',
    stage: 'research',
    level: 'warning',
    groups: ['research_skip'],
    text: {
      'zh-CN': '没有可用的模型路由（全部被出站策略禁用）',
      en: 'no usable model route (all disabled by the egress policy)',
    },
  },
  {
    code: 'lease_expired',
    stage: 'research',
    level: 'error',
    groups: ['research_ended'],
    text: {
      'zh-CN': '研判任务的租约多次过期，超过恢复次数上限',
      en: 'the research task lease expired more times than the recovery limit',
    },
  },
  {
    code: 'superseded',
    stage: 'research',
    level: 'info',
    groups: ['research_ended'],
    text: {
      'zh-CN': '排队中的研判被同一事件更新的触发取代',
      en: 'the queued research was replaced by a newer trigger of the same incident',
    },
  },
  {
    code: 'not_researched',
    stage: 'research',
    level: 'info',
    groups: ['research_ended'],
    text: {
      'zh-CN': '事件不进入阶段 B（严重度不在研判范围内、被抑制或已合并）',
      en: 'the incident does not enter stage B (severity not researched, suppressed or merged)',
    },
  },
  {
    code: 'not_applicable',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '模板不适用于这个结论', en: 'the template does not apply to this conclusion' },
  },
  {
    code: 'layout_missing',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_plan'],
    text: {
      'zh-CN': '仓库布局没有声明模板需要的文件',
      en: 'the repository layout does not declare the files the template needs',
    },
  },
  {
    code: 'input_failed',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '模板的输入查询失败', en: 'a template input query failed' },
  },
  {
    code: 'evaluation_error',
    stage: 'remediation',
    level: 'error',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '模板表达式求值出错', en: 'a template expression failed to evaluate' },
  },
  {
    code: 'skip_if',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '模板的跳过条件成立', en: 'the template skip condition holds' },
  },
  {
    code: 'target_not_found',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '仓库中找不到要修改的对象', en: 'the object to change is not in the repository' },
  },
  {
    code: 'ambiguous_target',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '仓库中要修改的对象不唯一', en: 'the object to change is ambiguous in the repository' },
  },
  {
    code: 'no_change',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '补丁没有改动', en: 'the patch changes nothing' },
  },
  {
    code: 'guard',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_plan'],
    text: { 'zh-CN': '模板的安全约束不成立', en: 'a template safety guard does not hold' },
  },
  {
    code: 'cause_scope',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_admission'],
    text: { 'zh-CN': '根因范围不是本地或配置', en: 'the cause scope is neither local nor configuration' },
  },
  {
    code: 'topology_only',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_admission'],
    text: {
      'zh-CN': '结论只有成员告警与变更支持，没有证据卡',
      en: 'only member alerts and changes support the conclusion, no evidence card',
    },
  },
  {
    code: 'no_runtime_evidence',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_admission'],
    text: { 'zh-CN': '支撑卡中没有运行时证据', en: 'no supporting card is runtime evidence' },
  },
  {
    code: 'no_repo_fact',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_admission'],
    text: {
      'zh-CN': '仓库事实不成立：要修改的文件不存在，或根因不由 GitOps 仓库负责',
      en: 'no repository fact: the files do not exist, or the GitOps repository does not own the root',
    },
  },
  {
    code: 'not_benign',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_admission'],
    text: {
      'zh-CN': '告警调优只在处置为忽略并且系统状态正常时提出',
      en: 'alert tuning is proposed only when the disposition is ignore and the system is healthy',
    },
  },
  {
    code: 'duplicate_open',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_dedupe'],
    text: { 'zh-CN': '同一个修改的 PR 仍然打开', en: 'a PR with the same change is still open' },
  },
  {
    code: 'duplicate_pending',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_dedupe'],
    text: {
      'zh-CN': '同一个修改已有提议，PR 还没有开出',
      en: 'the same change is already proposed and its PR is not open yet',
    },
  },
  {
    code: 'rejected_before',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_dedupe'],
    text: { 'zh-CN': '同一个修改的 PR 被关闭且没有合并', en: 'a PR with the same change was closed without merging' },
  },
  {
    code: 'rejected_cooldown',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_dedupe'],
    text: {
      'zh-CN': '同一模板对这些文件的修改在冷却期内',
      en: 'a change by the same template to these files is cooling down',
    },
  },
  {
    code: 'incident_closed',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_run'],
    text: { 'zh-CN': '事件已合并、被抑制或不存在', en: 'the incident is merged, suppressed or gone' },
  },
  {
    code: 'incident_changed',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_run'],
    text: {
      'zh-CN': '事件已更新，新版本重新触发了研判',
      en: 'the incident changed and a newer version triggered research again',
    },
  },
  {
    code: 'no_root',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_run'],
    text: { 'zh-CN': '事件没有根因组件', en: 'the incident has no root component' },
  },
  {
    code: 'no_fingerprint',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_run'],
    text: { 'zh-CN': '没有当前版本的证据指纹', en: 'no evidence fingerprint for the current version' },
  },
  {
    code: 'no_template',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_run'],
    text: { 'zh-CN': '没有适用并启用的修复模板', en: 'no applicable and enabled remediation template' },
  },
  {
    code: 'per_run_limit',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_run', 'remediation_template'],
    text: { 'zh-CN': '达到每次研判的提议上限', en: 'per-research proposal limit reached' },
  },
  {
    code: 'internal_error',
    stage: 'remediation',
    level: 'error',
    groups: ['remediation_run'],
    text: { 'zh-CN': '处理出错', en: 'processing failed' },
  },
  {
    code: 'repository_missing',
    stage: 'remediation',
    level: 'error',
    groups: ['remediation_template'],
    text: { 'zh-CN': '没有配置模板需要的仓库角色', en: 'the repository role the template needs is not configured' },
  },
  {
    code: 'plan_error',
    stage: 'remediation',
    level: 'error',
    groups: ['remediation_template'],
    text: { 'zh-CN': '生成补丁计划出错', en: 'planning the patch failed' },
  },
  {
    code: 'validation_failed',
    stage: 'remediation',
    level: 'error',
    groups: ['remediation_template'],
    text: { 'zh-CN': '补丁校验不通过', en: 'the patch failed validation' },
  },
  {
    code: 'policy',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_template'],
    text: { 'zh-CN': '提议没有通过策略', en: 'the proposal did not pass the policy' },
  },
  {
    code: 'gateway_propose_only',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_template'],
    text: {
      'zh-CN': 'gateway 只提议，不接受 gitops_pr',
      en: 'the gateway is propose-only and does not accept gitops_pr',
    },
  },
  {
    code: 'target_unresolved',
    stage: 'remediation',
    level: 'warning',
    groups: ['remediation_template'],
    text: { 'zh-CN': '提议的目标无法解析', en: 'the proposal target cannot be resolved' },
  },
  {
    code: 'binding_stale',
    stage: 'remediation',
    level: 'info',
    groups: ['remediation_template'],
    text: { 'zh-CN': '提议的绑定已过时，稍后重试', en: 'the proposal binding is stale; retried later' },
  },
  {
    code: 'opened',
    stage: 'issue',
    level: 'info',
    groups: ['issue'],
    text: { 'zh-CN': '事件 issue 已开出', en: 'incident issue opened' },
  },
  {
    code: 'external_root',
    stage: 'issue',
    level: 'info',
    groups: ['issue'],
    text: {
      'zh-CN': '根因是外部上游且没有业务影响，不开 issue',
      en: 'external upstream root without business impact; no issue',
    },
  },
  {
    code: 'rate_limit',
    stage: 'issue',
    level: 'warning',
    groups: ['issue'],
    text: { 'zh-CN': '仓库每小时开出的 issue 达到上限', en: 'the repository reached its hourly issue limit' },
  },
  {
    code: 'failed',
    stage: 'issue',
    level: 'error',
    groups: ['issue'],
    text: { 'zh-CN': '开出 issue 的重试用尽', en: 'retries to open the issue ran out' },
  },
  {
    code: 'resolved',
    stage: 'incident',
    level: 'info',
    groups: ['incident'],
    text: { 'zh-CN': '事件恢复', en: 'incident resolved' },
  },
  {
    code: 'reopened',
    stage: 'incident',
    level: 'info',
    groups: ['incident'],
    text: { 'zh-CN': '事件恢复后重新触发', en: 'incident fired again after resolving' },
  },
  {
    code: 'suppressed',
    stage: 'incident',
    level: 'info',
    groups: ['incident'],
    text: { 'zh-CN': '事件被抑制', en: 'incident suppressed' },
  },
  {
    code: 'persist_failed',
    stage: 'incident',
    level: 'error',
    groups: ['incident'],
    text: {
      'zh-CN': '事件写入失败，本组回滚，下一轮重试',
      en: 'writing the incident failed; the group was rolled back and is retried next round',
    },
  },
];
