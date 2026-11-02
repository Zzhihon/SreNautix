import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

// 技能的指标（ADR 0181 §8）
export class SkillMetrics {
  readonly loaded: Gauge<'skill' | 'version' | 'source'>;
  readonly loadFailures: Counter<'skill'>;
  readonly runs: Counter<'skill' | 'trigger' | 'outcome'>;
  readonly runSeconds: Histogram<'skill'>;
  readonly calls: Counter<'skill' | 'capability' | 'outcome'>;
  readonly budgetExhausted: Counter<'skill' | 'budget'>;
  readonly issues: Counter<'skill' | 'repo' | 'outcome'>;

  constructor(registry: Registry) {
    this.loaded = new Gauge({
      name: 'srenautix_skill_loaded',
      help: '加载的技能，1 为当前使用的版本',
      labelNames: ['skill', 'version', 'source'] as const,
      registers: [registry],
    });
    this.loadFailures = new Counter({
      name: 'srenautix_skill_load_failures_total',
      help: '技能的新内容没有通过校验的次数（旧版本继续运行）',
      labelNames: ['skill'] as const,
      registers: [registry],
    });
    this.runs = new Counter({
      name: 'srenautix_skill_runs_total',
      help: '结束的技能运行，按技能、第一个触发的种类与终态原因码',
      labelNames: ['skill', 'trigger', 'outcome'] as const,
      registers: [registry],
    });
    this.runSeconds = new Histogram({
      name: 'srenautix_skill_run_seconds',
      help: '技能运行的耗时，单位秒',
      labelNames: ['skill'] as const,
      buckets: [1, 5, 10, 30, 60, 120, 300, 600, 900],
      registers: [registry],
    });
    this.calls = new Counter({
      name: 'srenautix_skill_calls_total',
      help: '技能的外部访问，按能力与结果（ok、denied 超出能力或作用范围没有发出、budget 超出预算没有发出、error）',
      labelNames: ['skill', 'capability', 'outcome'] as const,
      registers: [registry],
    });
    this.budgetExhausted = new Counter({
      name: 'srenautix_skill_budget_exhausted_total',
      help: '技能运行超出预算的次数，按预算项',
      labelNames: ['skill', 'budget'] as const,
      registers: [registry],
    });
    this.issues = new Counter({
      name: 'srenautix_skill_issues_total',
      help: '技能的 issue 与评论，按结果（opened、recovered、commented、counted、deferred、retry、failed、completed、not_planned）',
      labelNames: ['skill', 'repo', 'outcome'] as const,
      registers: [registry],
    });
  }
}
