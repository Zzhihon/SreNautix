// 技能的步骤类型（ADR 0181 §3）：宿主内置、带版本。清单只能组合这里列出的类型；每个类型声明需要的能力与参数，
// 加载时校验清单（参数名、必填参数、能力），执行时宿主按同一张表检查。新增类型随 SreNautix 版本发布。

import type { SkillCapability } from '@srenautix/contract';

export interface StepKind {
  uses: string;
  /** 执行时需要的能力；清单的 capabilities 必须包含它们 */
  capabilities: readonly SkillCapability[];
  /** with 中允许的参数 */
  params: readonly string[];
  /** with 中必填的参数 */
  required: readonly string[];
}

const kind = (
  uses: string,
  capabilities: readonly SkillCapability[],
  params: readonly string[],
  required: readonly string[] = [],
): StepKind => ({ uses, capabilities, params, required });

export const STEP_KINDS: ReadonlyMap<string, StepKind> = new Map(
  [
    // 运行对象的 Pod 状态（含工作负载的 Pod 列表）、对象事件、上一次退出的容器日志尾部
    kind('kube.read@v1', ['kube.read'], ['object', 'pods', 'container', 'tail_lines'], ['object']),
    // 窗口内的发生：领域包信号的区间查询 + 触发带来的发生 + Pod 状态中最近一次终止的时刻
    kind(
      'trigger.occurrences@v1',
      ['metrics.query_range'],
      ['signal', 'window', 'step', 'pods', 'container'],
      ['signal', 'window'],
    ),
    // 领域包信号的区间查询：围绕每次发生（around）或整个工作负载的一段历史（history）
    kind(
      'metrics.range@v1',
      ['metrics.query_range'],
      ['mode', 'occurrences', 'before', 'after', 'last', 'step', 'signals', 'extra'],
      ['mode', 'signals', 'step'],
    ),
    // 按绑定声明的日志事件查询 Loki，只保留声明的字段
    kind(
      'logs.events@v1',
      ['logs.query'],
      ['events', 'container', 'occurrences', 'before', 'through', 'identifiers'],
      ['events', 'occurrences', 'before'],
    ),
    // 从已经读到的日志文本中按同样的事件声明取出字段
    kind('logs.extract@v1', [], ['logs', 'events', 'identifiers'], ['logs', 'events']),
    // 内存终止的分类：容器 limit 与节点压力；Go 服务的存活堆与 GC
    kind(
      'analyze.memory_kind@v1',
      [],
      ['runtime', 'occurrences', 'pods', 'kube_events', 'around', 'signals', 'thresholds'],
      ['runtime', 'occurrences', 'around', 'signals', 'thresholds'],
    ),
    // 嫌疑项的检验、分组、置信度、证据表
    kind(
      'analyze.suspects@v1',
      [],
      ['suspects', 'context', 'classified', 'around', 'history', 'logs', 'thresholds'],
      ['suspects', 'classified', 'around', 'history', 'logs', 'thresholds'],
    ),
    // 日志记录的排序与按某个字段汇总份额
    kind(
      'analyze.top@v1',
      [],
      ['logs', 'event', 'pods', 'by', 'limit', 'columns', 'group'],
      ['logs', 'event', 'by', 'limit', 'columns'],
    ),
    // 堆画像的文件名：按模式校验，每个 Pod 取最近几个，给出取出与分析的命令
    kind('analyze.profiles@v1', [], ['logs', 'profiles', 'limit_per_pod', 'container'], ['logs', 'profiles']),
    // 代码位置：业务仓库的文件中按字面量模式找出行号，链接固定到提交
    kind('code.locate@v1', ['code.read'], ['items'], ['items']),
    // 相关 issue：绑定声明的已有 issue 与本技能在同一对象上开过的其他 issue
    kind('issue.related@v1', [], ['references'], []),
    // 按指纹去重之后开 issue、评论或只计数
    kind('issue.publish@v1', ['issue.write'], ['output'], ['output']),
  ].map((k) => [k.uses, k]),
);

/** 步骤类型声明的空输出：when 为假或可选步骤失败时的输出 */
export const EMPTY_OUTPUTS: Record<string, unknown> = {
  'kube.read@v1': { pods: [], names: [], events: [], logs: [] },
  'trigger.occurrences@v1': { occurrences: [], pods: [] },
  'metrics.range@v1': { windows: [], history: null },
  'logs.events@v1': { records: [], queries: {}, truncated: false },
  'logs.extract@v1': { records: [], queries: {}, truncated: false, skipped: 0 },
  'analyze.memory_kind@v1': null,
  'analyze.suspects@v1': null,
  'analyze.top@v1': { columns: [], items: [], group: { key: '*', share: null, total: null, label: null } },
  'analyze.profiles@v1': { items: [] },
  'code.locate@v1': { commit: null, items: [], stale: [] },
  'issue.related@v1': { items: [] },
  'issue.publish@v1': null,
};
