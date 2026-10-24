import { Counter, Gauge, Histogram } from 'prom-client';
import { BaseMetrics } from '../metrics.js';

/** worker 角色的指标（阶段 B、模型层、出站、评测） */
export class WorkerMetrics extends BaseMetrics {
  readonly llmCalls = new Counter({
    name: 'srenautix_llm_calls_total',
    help: '模型调用次数，按阶段、路由、结果与错误类别',
    labelNames: ['phase', 'route', 'outcome', 'error_kind'] as const,
    registers: [this.registry],
  });

  readonly llmLatency = new Histogram({
    name: 'srenautix_llm_call_duration_seconds',
    help: '模型调用耗时',
    labelNames: ['phase', 'route'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 180, 300],
    registers: [this.registry],
  });

  readonly llmFirstToken = new Histogram({
    name: 'srenautix_llm_first_token_seconds',
    help: '成功的模型调用从发出请求到第一个输出增量的时间；延迟型熔断看它的 p50',
    labelNames: ['phase', 'route'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 90, 120, 180, 300],
    registers: [this.registry],
  });

  readonly promptTrims = new Counter({
    name: 'srenautix_llm_prompt_trims_total',
    help: '为放进路由窗口与输入预算而裁剪提示词的步数，按阶段与路由',
    labelNames: ['phase', 'route'] as const,
    registers: [this.registry],
  });

  readonly llmTokens = new Counter({
    name: 'srenautix_llm_tokens_total',
    help: '服务方 usage 计量的 token 数，按路由与方向（input、cached_input、output、reasoning）',
    labelNames: ['route', 'direction'] as const,
    registers: [this.registry],
  });

  readonly llmCost = new Counter({
    name: 'srenautix_llm_cost_total',
    help: '按路由单价计算的模型成本',
    labelNames: ['route', 'currency'] as const,
    registers: [this.registry],
  });

  readonly repair = new Counter({
    name: 'srenautix_llm_repair_total',
    help: '修复阶梯每一级的结果，按阶段与路由（level：parse、jsonrepair、salvage、reask、next_route、deterministic）',
    labelNames: ['phase', 'route', 'level', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly breakerOpen = new Gauge({
    name: 'srenautix_llm_breaker_open',
    help: '路由熔断器是否打开（1 打开）；打开原因见 srenautix_llm_breaker_opened_total',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  readonly breakerOpened = new Counter({
    name: 'srenautix_llm_breaker_opened_total',
    help: '路由熔断器打开次数，按原因（failure、latency）',
    labelNames: ['route', 'reason'] as const,
    registers: [this.registry],
  });

  readonly failureDomainSkips = new Counter({
    name: 'srenautix_llm_failure_domain_skips_total',
    help: '因事件涉及路由的故障域而提前熔断的次数',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  readonly estimateRatio = new Gauge({
    name: 'srenautix_llm_estimate_calibration',
    help: '发送前 token 估算的校准系数（实际 usage ÷ 原始估算）',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  readonly calibrationRejected = new Counter({
    name: 'srenautix_llm_calibration_rejected_total',
    help: '实际 usage 与原始估算之比在可信范围之外、没有计入校准的调用数（ADR 0129）',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  readonly budgetUsedRatio = new Gauge({
    name: 'srenautix_llm_budget_used_ratio',
    help: '已用 token 占上限的比例，scope=daily 为当天（UTC），scope=optimization 为主动优化用途的当天，scope=last_resort 为兜底路由合计的当天',
    labelNames: ['scope'] as const,
    registers: [this.registry],
  });

  readonly budgetStops = new Counter({
    name: 'srenautix_llm_budget_stops_total',
    help: '预算截停次数，按原因（stage、research、daily_warn、daily_exhausted、last_resort）',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly egressBytes = new Counter({
    name: 'srenautix_egress_bytes_total',
    help: '出站到模型服务的请求字节数，按路由与是否境内',
    labelNames: ['route', 'in_domain'] as const,
    registers: [this.registry],
  });

  readonly egressDropped = new Counter({
    name: 'srenautix_egress_dropped_segments_total',
    help: '出站前因数据类别不在 llm.egress.categories 中而删除的提示词片段数，按类别（ADR 0146 §3.6）',
    labelNames: ['category'] as const,
    registers: [this.registry],
  });

  readonly redactionHits = new Counter({
    name: 'srenautix_egress_redaction_hits_total',
    help: '出站前脱敏命中次数，按类别',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly routeDisabled = new Gauge({
    name: 'srenautix_llm_route_disabled',
    help: '启动时被出站策略禁用的模型路由（1 禁用），按原因（cross_border 等）；禁用的路由不会被调用',
    labelNames: ['route', 'reason'] as const,
    registers: [this.registry],
  });

  readonly routesAvailable = new Gauge({
    name: 'srenautix_llm_routes_available',
    help: '可用的模型路由数；为 0 时阶段 B 不运行，只出阶段 A',
    registers: [this.registry],
  });

  readonly egressHalted = new Gauge({
    name: 'srenautix_egress_halted',
    help: '出站是否因命中蜜标而停止（1 停止）；需要人工处理后重启 worker',
    registers: [this.registry],
  });

  readonly fingerprintDrift = new Counter({
    name: 'srenautix_llm_provider_fingerprint_changes_total',
    help: '服务方模型指纹变化次数；变化后该路由的回放分数作废，直到重新回放',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  readonly researchRuns = new Counter({
    name: 'srenautix_research_runs_total',
    help: '阶段 B 研判次数，按结果与停止原因',
    labelNames: ['outcome', 'stop'] as const,
    registers: [this.registry],
  });

  readonly researchDuration = new Histogram({
    name: 'srenautix_research_duration_seconds',
    help: '阶段 B 研判耗时',
    buckets: [5, 15, 30, 60, 120, 240, 360, 480],
    registers: [this.registry],
  });

  readonly conclusions = new Counter({
    name: 'srenautix_research_conclusions_total',
    help: '研判结论数，按结论阶梯档位、是否仍有未检验的竞争假设、是否没有执行任何区分性检查',
    labelNames: ['level', 'untested_competitor', 'zero_checks'] as const,
    registers: [this.registry],
  });

  readonly untestedCompetitorRatio = new Gauge({
    name: 'srenautix_research_untested_competitor_ratio',
    help: '最近 7 天的结论中仍有未检验竞争假设的比例（P0 指标，目标 <10%）',
    registers: [this.registry],
  });

  readonly zeroToolRatio = new Gauge({
    name: 'srenautix_research_zero_tool_ratio',
    help: '最近 7 天的研判中没有执行任何区分性检查的比例（诊断指标）',
    registers: [this.registry],
  });

  readonly incidentResearchRuns = new Histogram({
    name: 'srenautix_incident_research_runs',
    help: '每个事件的模型研判次数（事件结束时观测，P0 指标：≤3）',
    buckets: [1, 2, 3, 4, 5, 8],
    registers: [this.registry],
  });

  readonly checks = new Counter({
    name: 'srenautix_research_checks_total',
    help: '区分性检查执行次数，按类型（query、tool）与结果',
    labelNames: ['type', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly mcpCalls = new Counter({
    name: 'srenautix_mcp_tool_calls_total',
    help: 'MCP 服务角色的工具调用，按工具与结果',
    labelNames: ['tool', 'outcome'] as const,
    registers: [this.registry],
  });

  constructor(role: 'worker' | 'mcp', defaults = true) {
    super(role, defaults);
  }
}
