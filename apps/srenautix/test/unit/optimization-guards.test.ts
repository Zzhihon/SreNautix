import type { EvidenceResult } from '@srenautix/contract';
import type { PackSet } from '@srenautix/packs-sdk';
import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIMIZATION } from '../../src/optimize/config.js';
import { GoalDataUnavailable, type GoalEvidence } from '../../src/optimize/evidence.js';
import { packLoadGuard } from '../../src/optimize/guards.js';
import { BackendLimiter, OptimizationMetrics } from '../../src/optimize/limits.js';

// 不变量 16：领域包的负载保护卡接到 BackendLimiter 之后，保护卡异常或无法执行时，受保护后端的查询一个也不发出；
// 没有声明保护卡的后端不受影响

const CL = { cluster_id: 'c1', kind: 'Cluster.postgresql.cnpg.io', namespace: 'd', name: 'pg', node: null, uid: null };

const set = {
  domains: new Map([
    ['database', { load_guards: [{ pack: 'postgres', card: 'postgres/checks/load-guard', backends: ['dbstats'] }] }],
  ]),
} as unknown as PackSet;

function setup(verdict: () => EvidenceResult['verdict'] | 'error') {
  const evaluated: string[] = [];
  const evidence = {
    guardCard: async (card: string) => {
      evaluated.push(card);
      const v = verdict();
      if (v === 'error') {
        throw new GoalDataUnavailable('指标数据源不可达');
      }
      return { verdict: v, reason: { kind: 'rule', text: '主库 CPU 用量 82%' } } as EvidenceResult;
    },
  } as unknown as GoalEvidence;
  const now = { t: 1_000_000 };
  const guard = packLoadGuard(
    () => set,
    evidence,
    (b) => (b === 'dbstats' ? CL : null),
    () => now.t,
  );
  const limiter = new BackendLimiter(
    DEFAULT_OPTIMIZATION.limits,
    new OptimizationMetrics(new Registry()),
    guard,
    () => now.t,
  );
  return { limiter, evaluated, now };
}

describe('负载保护卡', () => {
  it('保护卡异常：dbstats 查询不发出，结果为 load_guard，原因带保护卡', async () => {
    const { limiter, evaluated } = setup(() => 'abnormal');
    let sent = 0;
    const r = await limiter.run('dbstats', 'optimization', async () => ++sent);
    expect(r).toMatchObject({ ok: false, outcome: 'load_guard' });
    expect(r.ok ? '' : r.reason).toMatch(/postgres\/checks\/load-guard.*CPU/);
    expect(sent).toBe(0);
    expect(evaluated).toEqual(['postgres/checks/load-guard']);
  });

  it('保护卡无法执行时同样不发出；保护卡正常时发出', async () => {
    let v: EvidenceResult['verdict'] | 'error' = 'error';
    const { limiter, now } = setup(() => v);
    let sent = 0;
    expect((await limiter.run('dbstats', 'optimization', async () => ++sent)).ok).toBe(false);
    expect(sent).toBe(0);
    v = 'normal';
    now.t += 61_000;
    expect(await limiter.run('dbstats', 'optimization', async () => ++sent)).toEqual({ ok: true, value: 1 });
  });

  it('没有声明保护卡的后端不评估保护卡；事件研判不经负载保护', async () => {
    const { limiter, evaluated } = setup(() => 'abnormal');
    expect(await limiter.run('metrics', 'optimization', async () => 1)).toEqual({ ok: true, value: 1 });
    expect(await limiter.run('dbstats', 'incident', async () => 2)).toEqual({ ok: true, value: 2 });
    expect(evaluated).toEqual([]);
  });
});
