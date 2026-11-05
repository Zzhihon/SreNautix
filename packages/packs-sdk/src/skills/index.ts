// 技能（ADR 0181）：清单的读取与校验、引用、模板、绑定，以及 analyze.* 纯函数。宿主（apps/srenautix 的 skills/）负责
// 访问外部系统的步骤、能力与预算、去重与投递。

export { STEP_KINDS, EMPTY_OUTPUTS, type StepKind } from './kinds.js';
export {
  loadSkillDir,
  skillDirs,
  skillFiles,
  skillDigest,
  contractInRange,
  SkillLintError,
  type LoadedSkill,
  type LoadSkillOptions,
} from './manifest.js';
export { asRef, collectRefs, getPath, resolveRef, resolveRefs, truthy, type Ref, type RefScope } from './refs.js';
export { checkTemplate, renderTemplate, mdSafe, TemplateError } from './template.js';
export { bindingsFor, bindingOf, BindingError, type ResolvedBinding } from './bindings.js';
export { eventQuery, extractRecord, extractLogs, type Identifiers } from './logs.js';
export {
  classifyMemory,
  type ClassifiedOccurrence,
  type MemoryKindOutput,
  type MemorySignals,
  type MemoryThresholds,
} from './memory-kind.js';
export {
  rankSuspects,
  historyStats,
  peakSignals,
  peakExpr,
  type RankedSuspect,
  type SuspectDecl,
  type SuspectSeries,
  type SuspectThresholds,
  type SuspectsOutput,
} from './suspects.js';
export { topRecords, listProfiles, type ProfilesDecl, type ProfileItem, type TopOutput } from './report.js';
export { fmtTime, fmtSpan, fmtValue, localized, sumSeries, pearson, type ValueUnit } from './stats.js';
export type {
  AroundWindow,
  EvidenceRow,
  FieldType,
  HistoryWindow,
  KubeEvent,
  Lang,
  LogEventDecl,
  LogRecord,
  LogsOutput,
  MetricsRangeOutput,
  Occurrence,
  PodSummary,
  Point,
  Series,
  SignalData,
} from './data.js';
