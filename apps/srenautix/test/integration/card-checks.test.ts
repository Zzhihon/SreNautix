import { resolve } from 'node:path';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import { DEFAULT_WINDOW, durationSeconds } from '@srenautix/packs-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBundle } from '../../src/eval/bundle.js';
import { loadLabels } from '../../src/eval/labels.js';
import {
  faultAlertIds,
  mainIncident,
  reconstructCase,
  ReconstructedQueryRunner,
  replay,
} from '../../src/eval/reconstruct.js';
import { LlmReplay } from '../../src/llm/replay.js';
import { ServerMetrics } from '../../src/metrics.js';
import { Catalog, DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { runStageB } from '../../src/research/controller.js';
import type { ResearchCase } from '../../src/research/types.js';
import { cardCheckId, parseCardCheckId, PER_COMPONENT, TOTAL } from '../../src/stage-a/card-checks.js';
import { memberLatest, PackEvidence, PackRules } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, PackRuntime } from '../../src/stage-a/packs.js';
import { parseStoredKey } from '../../src/topology/keys.js';
import { MemorySink, testEnv, testLayer, testRoute } from '../support/research-env.js';
import { PACKS } from '../support/packs.js';

/**
 * 卡片即检查（ADR 0116），用两次真实事故的重建包（脱敏，test/fixtures/eval/）与内置领域包：
 * 研判输入里有子图组件 × 适用的证据链卡；阶段 B 选中一项卡片检查时，执行方按 id 里的组件执行这张卡，
 * 结果成为新的证据卡并记入假设的检查（之前领域包没有查询模板，检查列表为空，阶段 B 从不执行检查）。
 */
const FIXTURES = resolve(import.meta.dirname, '../fixtures/eval');
const RECORDINGS = resolve(import.meta.dirname, '../fixtures/llm/card-checks');
const metrics = new ServerMetrics('server', false);

let prom: TsdbInstance;
let rt: PackRuntime;
let source: EvidenceSource;
let model: LlmReplay;
let modelUrl: string;
// 输出里 next_checks 缺少 template 的录制（fallback 路由的形态）
let missing: LlmReplay;
let missingUrl: string;
// 输出里 next_checks 为空的录制（ADR 0137）
let empty: LlmReplay;
let emptyUrl: string;

beforeAll(async () => {
  prom = await startPrometheus([]);
  rt = await PackRuntime.load({
    dirs: [PACKS],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series'] as const),
  });
  source = await EvidenceSource.create({
    id: 'prometheus',
    url: prom.url,
    dialect: 'promql',
    bearerTokenFile: null,
    timeoutMs: 5_000,
  });
  model = new LlmReplay({ dir: RECORDINGS });
  modelUrl = `http://127.0.0.1:${await model.listen('127.0.0.1', 0)}/v1`;
  missing = new LlmReplay({ dir: `${RECORDINGS}-missing-template` });
  missingUrl = `http://127.0.0.1:${await missing.listen('127.0.0.1', 0)}/v1`;
  empty = new LlmReplay({ dir: `${RECORDINGS}-empty` });
  emptyUrl = `http://127.0.0.1:${await empty.listen('127.0.0.1', 0)}/v1`;
}, 120_000);

afterAll(async () => {
  await model?.close();
  await missing?.close();
  await empty?.close();
  await prom?.stop();
});

async function caseOf(id: string) {
  const label = loadLabels(resolve(FIXTURES, 'labels.yaml')).labels.find((l) => l.id === id)!;
  const rep = await replay(
    readBundle(FIXTURES, id),
    Date.parse(label.window.to),
    {
      rt,
      params: rt.rcaParams(),
      revisionLabels: ['app.kubernetes.io/version', 'helm.sh/chart', 'acme.io/release-id'],
      groupWithinMs: 120_000,
      stepMs: 30_000,
    },
    Date.parse(label.as_of),
  );
  const main = mainIncident(rep, faultAlertIds(rep, label), 'captured')!;
  const asOf = Date.parse(label.as_of);
  const evidence = new PackEvidence(
    rt,
    source,
    async (_c, key) => rep.topology.componentType(key, asOf),
    { locale: 'zh-CN', concurrency: 2, queryTimeoutMs: 5_000 },
    metrics,
  );
  const rc = await reconstructCase(rep, label, main.incident, `snap-${id}`, 'test', rt.set.lockDigest ?? 'none', {
    evidence,
    rules: new PackRules(rt, metrics),
    rt,
    catalog: Catalog.load(),
    locale: 'zh-CN',
    signal: AbortSignal.timeout(60_000),
    impactLabels: {},
  });
  const s = rc.snapshot;
  const research: ResearchCase = {
    incident: s.context.incident,
    stageA: s.context.stage_a,
    subgraph: s.context.subgraph,
    feedback: [],
    actions: s.context.actions,
    runbooks: s.context.runbooks,
    knowledge: [],
    cases: [],
    templates: s.context.templates,
    tools: [],
    asOf: s.as_of,
  };
  return {
    research,
    alerts: s.context.alerts,
    runner: new ReconstructedQueryRunner(evidence, rc.incident, rep.topology, asOf, s.context.alerts),
  };
}

describe('release-rollback-acme：发布之后又回退', () => {
  it('检查的锚点与阶段 A 相同：回退阶段才升级的成员告警重新锚定，检查窗口与阶段 A 的卡相同，覆盖回退之后的症状（ADR 0131）', async () => {
    const { research, runner } = await caseOf('release-rollback-acme');
    const worker = 'Deployment:acme-prod/worker';
    const first = Date.parse(research.incident.first_firing_at);
    // worker 上最晚开始的在场成员告警：回退（16:24:25）之后才出现
    const onWorker = research.incident.members.filter((m) => m.left_version === null && m.component === worker);
    const latest = Math.max(...onWorker.map((m) => Date.parse(m.starts_at)));
    expect(latest).toBeGreaterThan(Date.parse('2026-10-20T16:24:25Z'));
    // 阶段 A 在 worker 上重新锚定过的卡：窗口终点在首次触发的窗口之后
    const stage = research.stageA.cards.filter(
      (c) =>
        c.entity?.kind === 'Deployment' &&
        c.entity.name === 'worker' &&
        c.card_id.split('/').length === 3 &&
        Date.parse(c.window.from) > first,
    );
    expect(stage.length).toBeGreaterThan(0);
    for (const c of stage.slice(0, 3)) {
      const card = await runner.run(
        { id: cardCheckId(c.card_id, worker), description: '', args: {} },
        {},
        {
          hypothesisId: 'h1',
          rootComponent: worker,
          bounds: { from: 0, to: Date.parse(research.asOf) },
          signal: AbortSignal.timeout(30_000),
        },
      );
      expect(card.window, c.card_id).toEqual(c.window);
      expect(Date.parse(card.window.to)).toBeGreaterThanOrEqual(Math.min(latest, Date.parse(research.asOf)));
    }
  }, 120_000);
});

describe.each(['pg-sync-restart-acme', 'metrics-scrape-blind-acme'])('%s', (id) => {
  it('研判输入有卡片检查：根因组件在前，按组件与总数截断，参数全部可选', async () => {
    const { research } = await caseOf(id);
    const checks = research.templates.filter((t) => parseCardCheckId(t.id) !== null);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.length).toBeLessThanOrEqual(TOTAL);
    const byComponent = new Map<string, number>();
    for (const t of checks) {
      const c = parseCardCheckId(t.id)!.component;
      byComponent.set(c, (byComponent.get(c) ?? 0) + 1);
      expect(t.args).toMatchObject({ type: 'object', additionalProperties: false });
      expect((t.args as { required?: unknown }).required).toBeUndefined();
    }
    expect([...byComponent.values()].every((n) => n <= PER_COMPONENT)).toBe(true);
    expect(parseCardCheckId(checks[0]!.id)!.component).toBe(research.incident.root.component);
    if (process.env.SHOW_CHECKS) {
      console.log(checks.map((t) => t.id).join('\n'));
    }
  }, 120_000);

  it('阶段 B 执行卡片检查：在 id 里的组件上执行，结果成为新的证据卡，记入假设的检查', async () => {
    const { research, runner, alerts } = await caseOf(id);
    const env = {
      ...testEnv(
        testLayer([
          testRoute(modelUrl, { id: 'primary', api: 'responses', model: 'gpt-5', dialect_profile: 'openai-responses' }),
        ]),
        [],
        true,
      ),
      query: runner,
    };
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000d1',
        rc: research,
        previous: null,
        signal: new AbortController().signal,
      },
      env,
      new MemorySink(),
    );
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    const checks = res.output!.next_checks;
    expect(checks.length).toBeGreaterThan(0);
    const c = checks[0]!;
    const parsed = parseCardCheckId(c.template)!;
    expect(parsed.component).toBe(research.incident.root.component);
    // 新的证据卡：检查的结果引用，不在阶段 A 的卡里
    expect(c.result_ref).not.toBeNull();
    expect(research.stageA.cards.map((x) => x.ref)).not.toContain(c.result_ref);
    expect(c.outcome).not.toBe('failed');
    // 窗口覆盖：起点是锚点之前 2 小时，终点取卡片定义（不晚于研判时刻）。锚点与阶段 A 相同（ADR 0131）：事件首次触发，
    // 实体上最晚开始的成员告警落在卡片窗口之后时按它重新锚定
    const t = research.templates.find((x) => x.id === c.template)!;
    const k = parseStoredKey(parseCardCheckId(t.id)!.component);
    const def = rt.set.cards.get(parseCardCheckId(t.id)!.card)!.def;
    const afterMs = durationSeconds((def.window ?? DEFAULT_WINDOW).after) * 1000;
    const first = Date.parse(research.incident.first_firing_at);
    const latest = memberLatest(alerts)({ cluster_id: research.incident.cluster_id, ...k, uid: null });
    const anchor = latest !== undefined && latest > first + afterMs ? latest : first;
    const card = await runner.run(
      t,
      { window_before: '2h' },
      {
        hypothesisId: 'h1',
        rootComponent: 'Node:elsewhere',
        bounds: { from: 0, to: Date.parse(research.asOf) },
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(Date.parse(card.window.from)).toBe(anchor - 2 * 3600_000);
    expect(card.entity).toMatchObject({ kind: k.kind, namespace: k.namespace, name: k.name });
  }, 120_000);

  it('next_checks 缺少 template：按条目里的检查 id 补全并执行；没有检查 id 的条目只删除它（ADR 0127）', async () => {
    const { research, runner } = await caseOf(id);
    const env = {
      ...testEnv(
        testLayer([
          testRoute(missingUrl, {
            id: 'fallback',
            api: 'responses',
            model: 'gpt-5',
            dialect_profile: 'openai-responses',
          }),
        ]),
        [],
        true,
      ),
      query: runner,
    };
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000d2',
        rc: research,
        previous: null,
        signal: new AbortController().signal,
      },
      env,
      new MemorySink(),
    );
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    const checks = res.output!.next_checks;
    expect(checks).toHaveLength(1);
    expect(parseCardCheckId(checks[0]!.template)!.component).toBe(research.incident.root.component);
    expect(checks[0]!.result_ref).not.toBeNull();
    expect(checks[0]!.outcome).not.toBe('failed');
    const notes = res.output!.validation_notes.join('\n');
    expect(notes).toMatch(/\/next_checks\[0\]：template 缺失，按检查 id cardcheck:\S+ 补为 cardcheck:/);
    expect(notes).toContain('/next_checks[1]：条目不合格，已删除');
  }, 120_000);

  it('next_checks 为空：事件的组件有适用的卡片检查时，控制器按相关性补选并执行，最多 3 项（ADR 0137）', async () => {
    const { research, runner } = await caseOf(id);
    const env = {
      ...testEnv(
        testLayer([
          testRoute(emptyUrl, { id: 'primary', api: 'responses', model: 'gpt-5', dialect_profile: 'openai-responses' }),
        ]),
        [],
        true,
      ),
      query: runner,
    };
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000d3',
        rc: research,
        previous: null,
        signal: new AbortController().signal,
      },
      env,
      new MemorySink(),
    );
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    const checks = res.output!.next_checks;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.length).toBeLessThanOrEqual(3);
    // 第一项落在 h1 的根因（事件根因）上，取候选清单里这个组件的第一项卡片检查，参数全部取默认值
    const first = research.templates.find(
      (t) => parseCardCheckId(t.id)?.component === research.incident.root.component,
    )!;
    expect(checks[0]).toMatchObject({ hypothesis_id: 'h1', type: 'query', template: first.id, args: {} });
    expect(checks[0]!.result_ref).not.toBeNull();
    expect(checks[0]!.outcome).not.toBe('failed');
    expect(res.output!.validation_notes.join('\n')).toMatch(
      /第 1 轮 hypothesize 没有给出 next_checks，控制器按相关性补选 \d 项卡片检查：cardcheck:\S+（假设 h1）/,
    );
  }, 120_000);
});
