import { resolve } from 'node:path';
import { startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
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
import { parseCardCheckId, PER_COMPONENT, TOTAL } from '../../src/stage-a/card-checks.js';
import { PackEvidence, PackRules } from '../../src/stage-a/pack-evidence.js';
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
}, 120_000);

afterAll(async () => {
  await model?.close();
  await missing?.close();
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
  return { research, runner: new ReconstructedQueryRunner(evidence, rc.incident, rep.topology, asOf) };
}

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
    const { research, runner } = await caseOf(id);
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
    // 窗口覆盖：起点是事件首次触发之前 2 小时，终点取卡片定义（不晚于研判时刻）
    const t = research.templates.find((x) => x.id === c.template)!;
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
    expect(Date.parse(card.window.from)).toBe(Date.parse(research.incident.first_firing_at) - 2 * 3600_000);
    const k = parseStoredKey(parseCardCheckId(t.id)!.component);
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
});
