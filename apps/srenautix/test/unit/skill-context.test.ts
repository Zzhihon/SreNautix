import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { skillsConfig } from '../../src/skills/config.js';
import { Semaphore, SkillBudgetExceeded, SkillContext, SkillDenied } from '../../src/skills/context.js';
import { SkillMetrics } from '../../src/skills/metrics.js';
import { effectiveParams, fingerprint, runBudget } from '../../src/skills/runner.js';

// 技能运行的访问控制（ADR 0181 §7.1、§7.2，不变量 17）：没有授予的能力、运行对象之外的命名空间与 Pod、超出预算的访问
// 都不发出请求，并记下被拒绝的访问；预算取清单与 skills.limits 的较小者；指纹只由声明的值决定

const metrics = new SkillMetrics(new Registry());
const sems = { metrics: new Semaphore(1), logs: new Semaphore(1), kube: new Semaphore(1), github: new Semaphore(1) };
const budget = {
  metrics_queries: 2,
  logs_queries: 1,
  log_lines: 10,
  kube_reads: 1,
  github_requests: 1,
  code_files: 1,
  code_bytes: 100,
};

function ctx(caps: Record<string, object>) {
  return new SkillContext({
    skill: 't',
    capabilities: caps,
    namespace: 'shop',
    pods: () => new Set(['api-0']),
    budget,
    semaphores: sems,
    metrics,
    signal: new AbortController().signal,
  });
}

describe('SkillContext', () => {
  it('没有授予的能力不发出请求，记录为 denied', async () => {
    const c = ctx({ 'metrics.query_range': {} });
    let called = false;
    await expect(
      c.call('kube.read', 'kube', 'workload_pods', {}, async () => {
        called = true;
      }),
    ).rejects.toThrow(SkillDenied);
    expect(called).toBe(false);
    expect(c.calls.map((x) => [x.capability, x.outcome])).toEqual([['kube.read', 'denied']]);
  });

  it('运行对象之外的命名空间与 Pod 被拒绝', () => {
    const c = ctx({ 'kube.read': {} });
    expect(() => c.inScope('kube.read', 'pod_logs_previous', 'other', null)).toThrow(/不是运行对象的命名空间/);
    expect(() => c.inScope('kube.read', 'pod_logs_previous', 'shop', 'db-0')).toThrow(/不属于运行对象/);
    expect(() => c.inScope('kube.read', 'pod_logs_previous', 'shop', 'api-0')).not.toThrow();
    expect(c.calls.filter((x) => x.outcome === 'denied').length).toBe(2);
  });

  it('超出预算时不发出请求，记录为 budget', async () => {
    const c = ctx({ 'metrics.query_range': {} });
    await c.call('metrics.query_range', 'metrics', 'q', {}, async () => 1);
    await c.call('metrics.query_range', 'metrics', 'q', {}, async () => 1);
    let called = false;
    await expect(
      c.call('metrics.query_range', 'metrics', 'q', {}, async () => {
        called = true;
      }),
    ).rejects.toThrow(SkillBudgetExceeded);
    expect(called).toBe(false);
    expect(c.calls.map((x) => x.outcome)).toEqual(['ok', 'ok', 'budget']);
    expect(c.usage.metrics_queries).toBe(2);
  });

  it('请求失败时记录为 error 并抛出原错误', async () => {
    const c = ctx({ 'logs.query': {} });
    await expect(
      c.call('logs.query', 'logs', 'query', {}, async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(c.calls[0]).toMatchObject({ outcome: 'error', error: 'boom' });
  });
});

describe('预算、参数与指纹', () => {
  const manifest = {
    params: { a: 1, b: 'x' },
    budgets: {
      run: {
        duration: '10m',
        metrics_queries: 200,
        logs_queries: 30,
        log_lines: 5000,
        kube_reads: 20,
        github_requests: 80,
        code_files: 24,
        code_bytes: 2048,
      },
      hourly: { runs: 6, issues: 1, comments: 6 },
    },
  } as never;

  it('预算取清单与 skills.limits 的较小者', () => {
    const limits = skillsConfig.parse({ limits: { duration: '5m', metrics_queries: 100 } }).limits;
    expect(runBudget(manifest, limits)).toMatchObject({
      duration_ms: 300_000,
      metrics_queries: 100,
      logs_queries: 30,
      code_bytes: 2048,
    });
  });

  it('参数的覆盖必须是声明过的参数且类型相同', () => {
    expect(effectiveParams(manifest, { a: 2 })).toEqual({ a: 2, b: 'x' });
    expect(() => effectiveParams(manifest, { c: 1 })).toThrow(/没有声明的参数/);
    expect(() => effectiveParams(manifest, { a: 'y' })).toThrow(/类型应为 number/);
  });

  it('指纹只由技能、集群与声明的值决定，对象的键顺序不影响', () => {
    const a = fingerprint('oom-rootcause', 'c1', ['api', { x: 1, y: 2 }]);
    expect(a).toBe(fingerprint('oom-rootcause', 'c1', ['api', { y: 2, x: 1 }]));
    expect(a).not.toBe(fingerprint('oom-rootcause', 'c2', ['api', { x: 1, y: 2 }]));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('默认没有启用任何技能，也没有授予任何能力', () => {
    const c = skillsConfig.parse({});
    expect(c.enabled).toEqual([]);
    expect(c.grants).toEqual({});
    expect(c.sources).toEqual([{ kind: 'builtin' }]);
  });
});
