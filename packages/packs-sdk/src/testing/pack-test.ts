// srenautix pack test（DESIGN §6.3）：
// - 夹具（promtool input_series 写法）装进真实的 Prometheus 与 VictoriaMetrics，日志夹具装进真实的 Loki；
// - 每个测试在两个后端上各跑一遍，结论（verdict、显示状态、原因类型）必须与期望一致，两个后端之间也必须一致；
// - 每张卡自动生成三类测试：无数据（空后端）、部分无数据、数据源报错；
// - stable 的包要求每张卡都有夹具测试，并且全部通过。

import type { LabelProfile, PackTestFile } from '@srenautix/contract';
import {
  LokiAdapter,
  PrometheusApiAdapter,
  loadPromqlEngine,
  startLoki,
  startPrometheus,
  startVictoriaMetrics,
  toIso,
  type FixtureLogStream,
  type FixtureMetricSeries,
  type PromqlEngine,
  type RunningProcess,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { judgeCard } from '../judge/card.js';
import { denseLabels, type RefData } from '../judge/data.js';
import type { PackSet } from '../pack/compile.js';
import { LiveDataSource, type EvidenceDataSource } from '../runtime/datasource.js';
import { DEFAULT_WINDOW, durationSeconds, runCard, type RunCardResult } from '../runtime/run-card.js';
import { alertFires, primaryCardIndex, rulesForEntry, type AlertRule } from './alert-consistency.js';
import { resolveSignal, type SignalResolution } from '../signals/resolve.js';

/** 夹具的时间零点 */
export const FIXTURE_EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

type Backend = 'prometheus' | 'victoria-metrics';
const BACKENDS: Backend[] = ['prometheus', 'victoria-metrics'];

export interface CaseResult {
  pack: string;
  file: string;
  name: string;
  card: string;
  kind: 'fixture' | 'nodata' | 'partial_nodata' | 'datasource_error';
  passed: boolean;
  /** 后端 → verdict / display_state / reason.kind */
  results: Partial<Record<Backend, { verdict: string; display_state: string; reason_kind: string; reason: string }>>;
  failure: string | null;
}

export interface PackTestReport {
  packs: Array<{
    name: string;
    maturity: string;
    /** stable 包缺少夹具的卡片 */
    uncovered: string[];
    passed: boolean;
  }>;
  cases: CaseResult[];
  /** 主卡与告警规则的一致性核对次数（夹具测试 × 后端 × 告警） */
  alert_checks: number;
  passed: boolean;
}

interface Fixtures {
  metrics: FixtureMetricSeries[];
  logs: FixtureLogStream[];
  spanMs: number;
}

function expandFixtures(engine: PromqlEngine, file: PackTestFile, where: string): Fixtures {
  const step = durationSeconds(file.interval) * 1000;
  let maxPoints = 0;
  const metrics = (file.input_series ?? []).map((s) => {
    const parsed = engine.parseSeries(`${s.series} ${s.values}`);
    maxPoints = Math.max(maxPoints, parsed.values.length);
    const points = parsed.values.flatMap((v, i) => {
      if (v === null) {
        return [];
      }
      if (v === 'stale') {
        throw new Error(
          `${where}：夹具不支持 stale；VictoriaMetrics 的导入接口不接受 staleness marker，序列结束请省略后面的点`,
        );
      }
      const num = v === 'NaN' ? Number.NaN : v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : v;
      return [{ t: FIXTURE_EPOCH + i * step, v: num }];
    });
    return { labels: parsed.labels, points };
  });
  let lastLog = 0;
  const logs = (file.input_logs ?? []).map((s) => ({
    labels: denseLabels(s.labels),
    lines: s.lines.map((l) => {
      const t = FIXTURE_EPOCH + durationSeconds(l.offset) * 1000;
      lastLog = Math.max(lastLog, t - FIXTURE_EPOCH);
      return { t, line: l.line };
    }),
  }));
  return { metrics, logs, spanMs: Math.max(maxPoints * step, lastLog + step) };
}

function profileFor(intervalSeconds: number): LabelProfile {
  return {
    namespace: 'namespace',
    pod: 'pod',
    container: 'container',
    node: 'node',
    cluster: null,
    scrape_interval_seconds: intervalSeconds,
    tenant: null,
  };
}

const LOGS_PROFILE = { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null };

interface Env {
  tsdb: Record<Backend, TsdbInstance>;
  loki: RunningProcess | null;
  ds: Record<Backend, EvidenceDataSource>;
}

async function startEnv(fx: Fixtures, intervalSeconds: number, withLoki: boolean): Promise<Env> {
  const started = await Promise.allSettled([
    startPrometheus(fx.metrics),
    startVictoriaMetrics(fx.metrics),
    withLoki || fx.logs.length ? startLoki(fx.logs) : Promise.resolve(null),
  ]);
  const failed = started.find((r) => r.status === 'rejected');
  if (failed) {
    // 已启动的后端先停止，再报告第一个启动错误
    await Promise.all(started.map((r) => (r.status === 'fulfilled' ? r.value?.stop() : undefined)));
    throw failed.reason;
  }
  const [prom, vm, loki] = started.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [
    TsdbInstance,
    TsdbInstance,
    RunningProcess | null,
  ];
  const profile = profileFor(intervalSeconds);
  const ds = (b: Backend, t: TsdbInstance) =>
    new LiveDataSource({
      metrics: {
        adapter: new PrometheusApiAdapter({
          id: b,
          url: t.url,
          dialects: b === 'prometheus' ? ['promql'] : ['promql', 'metricsql'],
        }),
        profile,
      },
      ...(loki
        ? {
            logs: {
              adapter: new LokiAdapter({ id: 'loki', url: loki.url, labels: LOGS_PROFILE }),
              profile: LOGS_PROFILE,
            },
          }
        : {}),
    });
  return {
    tsdb: { prometheus: prom, 'victoria-metrics': vm },
    loki,
    ds: { prometheus: ds('prometheus', prom), 'victoria-metrics': ds('victoria-metrics', vm) },
  };
}

async function stopEnv(env: Env): Promise<void> {
  await Promise.all([env.tsdb.prometheus.stop(), env.tsdb['victoria-metrics'].stop(), env.loki?.stop()]);
}

async function resolveAll(
  set: PackSet,
  signalKeys: Set<string>,
  ds: EvidenceDataSource,
  engine: PromqlEngine,
  at: number,
  clock: { from: string; to: string },
) {
  const out = new Map<string, SignalResolution>();
  for (const k of signalKeys) {
    out.set(
      k,
      await resolveSignal(
        k,
        set.signals.get(k)!.signal,
        ds,
        engine,
        toIso(at),
        clock,
        Math.max(3600, (at - FIXTURE_EPOCH) / 1000),
      ),
    );
  }
  return out;
}

const summary = (r: RunCardResult) => ({
  verdict: r.verdict,
  display_state: r.display_state,
  reason_kind: r.reason.kind,
  reason: r.reason.text,
});

function cardKeyFor(pack: string, ref: string): string {
  return `${pack}/${ref}`;
}

export interface PackTestOptions {
  set: PackSet;
  /** 只测这些包；不填时测全部启用的包 */
  packs?: string[];
  /** 告警规则（loadAlertRules）：主卡的夹具测试同时核对告警规则在同一份夹具上是否触发 */
  alertRules?: Map<string, AlertRule[]>;
}

export async function runPackTests(opts: PackTestOptions): Promise<PackTestReport> {
  const engine = await loadPromqlEngine();
  const set = opts.set;
  const cases: CaseResult[] = [];
  const packsOut: PackTestReport['packs'] = [];
  const selected = set.packs.filter((p) => !opts.packs || opts.packs.includes(p.name));
  const primaries = primaryCardIndex(set);
  const consistency = { checked: 0 };

  for (const pack of selected) {
    const cardKeys = [...set.cards.values()].filter((c) => c.pack === pack.name).map((c) => c.key);
    const covered = new Set<string>();
    // 每张卡最近一次非无法判定的夹具结果，供自动测试变换
    const captured = new Map<string, RunCardResult>();

    for (const [file, tf] of Object.entries(pack.content.tests)) {
      const where = `${pack.name}/tests/${file}`;
      const fx = expandFixtures(engine, tf, where);
      const interval = durationSeconds(tf.interval);
      const env = await startEnv(fx, interval, false);
      try {
        const end = FIXTURE_EPOCH + fx.spanMs;
        const clock = { from: toIso(FIXTURE_EPOCH - 30 * DAY), to: toIso(end + 30 * DAY) };
        const used = new Set<string>();
        for (const t of tf.tests) {
          const e = set.cards.get(cardKeyFor(pack.name, t.card));
          if (!e) {
            throw new Error(`${where}：测试 ${t.name} 引用的卡片 ${t.card} 不存在`);
          }
          Object.values(e.signals).forEach((s) => used.add(s));
        }
        const res: Record<Backend, Map<string, SignalResolution>> = {
          prometheus: await resolveAll(set, used, env.ds.prometheus, engine, end, clock),
          'victoria-metrics': await resolveAll(set, used, env.ds['victoria-metrics'], engine, end, clock),
        };
        for (const t of tf.tests) {
          const key = cardKeyFor(pack.name, t.card);
          covered.add(key);
          const e = set.cards.get(key)!;
          const entity = {
            cluster_id: 'pack-test',
            kind: t.entity.kind,
            namespace: t.entity.namespace ?? null,
            name: t.entity.name,
          };
          const anchor = FIXTURE_EPOCH + durationSeconds(t.eval_time) * 1000;
          const results: CaseResult['results'] = {};
          const failures: string[] = [];
          for (const b of BACKENDS) {
            const r = await runCard({
              set,
              card: key,
              entity,
              anchor,
              now: Number.MAX_SAFE_INTEGER,
              ds: env.ds[b],
              engine,
              resolutions: res[b],
              clock,
              ...(t.params ? { params: t.params as Record<string, number | string | boolean> } : {}),
            });
            results[b] = summary(r);
            if (r.verdict !== t.expect.verdict) {
              failures.push(`${b}：期望 ${t.expect.verdict}，实际 ${r.verdict}（${r.reason.text}）`);
            }
            if (t.expect.display_state && r.display_state !== t.expect.display_state) {
              failures.push(`${b}：期望显示状态 ${t.expect.display_state}，实际 ${r.display_state}`);
            }
            if (t.expect.reason_kind && r.reason.kind !== t.expect.reason_kind) {
              failures.push(`${b}：期望原因 ${t.expect.reason_kind}，实际 ${r.reason.kind}（${r.reason.text}）`);
            }
            if (b === 'prometheus' && r.verdict !== 'undeterminable') {
              captured.set(`${key}\u0000${t.name}`, r);
            }
            // 这张卡是某些告警的主卡：告警在卡片窗口内触发 ⇔ 主卡判为异常
            for (const { entry } of primaries.get(key) ?? []) {
              const rules = opts.alertRules ? rulesForEntry(opts.alertRules, entry) : [];
              if (!rules.length) {
                continue;
              }
              const w = e.def.window ?? DEFAULT_WINDOW;
              // 任何一条规则（严重度变体）触发都算条目的告警在触发；后端不支持某条规则的方言时整体不核对
              const each = await Promise.all(
                rules.map((rule) =>
                  alertFires(
                    env.ds[b],
                    rule,
                    entry.entity.name_labels ?? [],
                    t.entity.name,
                    {
                      from: anchor - durationSeconds(w.before) * 1000,
                      to: anchor + durationSeconds(w.after) * 1000,
                    },
                    interval,
                    clock,
                  ),
                ),
              );
              if (each.some((x) => x === null)) {
                continue;
              }
              const fires = each.some((x) => x === true);
              if (fires !== (r.verdict === 'abnormal')) {
                failures.push(
                  `${b}：告警 ${entry.alertname}（${rules[0]!.file}）在卡片窗口内${fires ? '触发' : '没有触发'}，主卡判为 ${r.verdict}`,
                );
              }
              consistency.checked++;
            }
          }
          const p = results.prometheus!;
          const v = results['victoria-metrics']!;
          if (p.verdict !== v.verdict || p.display_state !== v.display_state || p.reason_kind !== v.reason_kind) {
            failures.push(
              `Prometheus 与 VictoriaMetrics 的结论不一致：${p.verdict}/${p.reason_kind} 对 ${v.verdict}/${v.reason_kind}`,
            );
          }
          cases.push({
            pack: pack.name,
            file,
            name: t.name,
            card: key,
            kind: 'fixture',
            passed: !failures.length,
            results,
            failure: failures.join('；') || null,
          });
        }
      } finally {
        await stopEnv(env);
      }
    }

    // 无数据：在空后端上执行每张卡（信号按全部夹具探测的结果选备选）
    if (cardKeys.length) {
      // 有日志卡的包同时启动空的 Loki，无数据测试才能覆盖日志引用
      const usesLogs = cardKeys.some((k) => set.cards.get(k)!.def.refs.some((r) => r.mode === 'logs'));
      const env = await startEnv({ metrics: [], logs: [], spanMs: 3600_000 }, 60, usesLogs);
      try {
        const end = FIXTURE_EPOCH + 3600_000;
        const clock = { from: toIso(FIXTURE_EPOCH - 30 * DAY), to: toIso(end + 30 * DAY) };
        for (const key of cardKeys) {
          const e = set.cards.get(key)!;
          const firstAlt = new Map<string, SignalResolution>(
            Object.values(e.signals).map((sk) => {
              const s = set.signals.get(sk)!.signal;
              return [sk, { signal: sk, kind: s.kind, index: 0, alternative: s.alternatives[0]!, rejected: [] }];
            }),
          );
          const kind = e.def.applies_to?.kinds?.[0] ?? 'Pod';
          const entity = {
            cluster_id: 'pack-test',
            kind,
            namespace: kind === 'Node' || kind === 'cluster' ? null : 'srenautix-nodata',
            name: 'srenautix-nodata',
          };
          const results: CaseResult['results'] = {};
          const failures: string[] = [];
          for (const b of BACKENDS) {
            const r = await runCard({
              set,
              card: key,
              entity,
              anchor: end - 600_000,
              now: Number.MAX_SAFE_INTEGER,
              ds: env.ds[b],
              engine,
              resolutions: firstAlt,
              clock,
            });
            results[b] = summary(r);
            if (r.verdict !== 'undeterminable') {
              failures.push(`${b}：没有数据时得出 ${r.verdict}（${r.reason.text}）；没有任何样本永远不是正常`);
            }
          }
          cases.push({
            pack: pack.name,
            file: '(自动)',
            name: '无数据',
            card: key,
            kind: 'nodata',
            passed: !failures.length,
            results,
            failure: failures.join('；') || null,
          });
        }
      } finally {
        await stopEnv(env);
      }
    }

    // 部分无数据与数据源报错：在真实夹具结果上变换单个引用后重新判定
    for (const [ck, r] of captured) {
      const [key, name] = ck.split('\u0000') as [string, string];
      const e = set.cards.get(key)!;
      const required = e.def.refs.filter((x) => (x.empty_is ?? 'no_data') === 'no_data');
      const rejudge = (refs: Record<string, RefData>) => judgeCard(e.compiled, { ...r.judgeInput, refs });
      for (const ref of required) {
        const empty: RefData =
          r.refs[ref.name]!.kind === 'logs'
            ? { kind: 'logs', lines: [], truncated: false }
            : r.refs[ref.name]!.kind === 'traces'
              ? { kind: 'traces', traces: [], truncated: false }
              : { kind: 'metrics', series: [], truncated: false };
        for (const [kind, data] of [
          ['partial_nodata', empty],
          ['datasource_error', { kind: 'error', message: '注入的数据源错误' } as RefData],
        ] as const) {
          const out = rejudge({ ...r.refs, [ref.name]: data });
          const ok = out.verdict !== 'normal';
          cases.push({
            pack: pack.name,
            file: '(自动)',
            name: `${name}：${kind === 'partial_nodata' ? '缺少' : '报错'} ${ref.name}`,
            card: key,
            kind,
            passed: ok,
            results: {
              prometheus: {
                verdict: out.verdict,
                display_state: out.display_state,
                reason_kind: out.reason.kind,
                reason: out.reason.text,
              },
            },
            failure: ok ? null : `引用 ${ref.name} ${kind === 'partial_nodata' ? '没有数据' : '报错'}时得出 normal`,
          });
        }
      }
      // 全部必需引用报错：无法判定，原因为数据源报错
      const allErr = Object.fromEntries(
        e.def.refs.map((x) => [
          x.name,
          required.includes(x) ? ({ kind: 'error', message: '注入的数据源错误' } as RefData) : r.refs[x.name]!,
        ]),
      );
      const out = rejudge(allErr);
      const ok = out.verdict !== 'normal' && (out.verdict === 'abnormal' || out.reason.kind === 'source_error');
      cases.push({
        pack: pack.name,
        file: '(自动)',
        name: `${name}：全部必需引用报错`,
        card: key,
        kind: 'datasource_error',
        passed: ok,
        results: {
          prometheus: {
            verdict: out.verdict,
            display_state: out.display_state,
            reason_kind: out.reason.kind,
            reason: out.reason.text,
          },
        },
        failure: ok ? null : `全部必需引用报错时得出 ${out.verdict}/${out.reason.kind}`,
      });
    }

    const maturity = pack.content.manifest.maturity;
    const uncovered = maturity === 'stable' ? cardKeys.filter((k) => !covered.has(k)) : [];
    const packCases = cases.filter((c) => c.pack === pack.name);
    packsOut.push({
      name: pack.name,
      maturity,
      uncovered,
      passed: !uncovered.length && packCases.every((c) => c.passed),
    });
  }
  return { packs: packsOut, cases, alert_checks: consistency.checked, passed: packsOut.every((p) => p.passed) };
}
