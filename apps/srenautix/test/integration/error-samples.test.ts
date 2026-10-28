import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvidenceResult, Incident, PackTestFile, ResearchOutput } from '@srenautix/contract';
import { validatorFor } from '@srenautix/contract';
import { startLoki, startPrometheus, type TsdbInstance } from '@srenautix/integration-sdk';
import { durationSeconds } from '@srenautix/packs-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LlmReplay } from '../../src/llm/replay.js';
import { ServerMetrics } from '../../src/metrics.js';
import { composeMessage, type ComposeInput } from '../../src/notify/compose.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { runStageB } from '../../src/research/controller.js';
import type { Subgraph } from '../../src/research/types.js';
import { PackEvidence } from '../../src/stage-a/pack-evidence.js';
import { EvidenceSource, evidenceCapabilities, PackRuntime, type LokiSource } from '../../src/stage-a/packs.js';
import { MemorySink, testEnv, testLayer, testRoute } from '../support/research-env.js';
import { incident, researchCase, stageA } from '../support/scenario.js';

/**
 * 错误样例（ADR 0177）的回放用例：packs-sdk 的测试包 llm-gateway 与它的日志夹具（四类上游错误）装进真实的 Loki，
 * server 的阶段 A 执行错误样例卡（出站模块的脱敏规则、证据期限与查询超时的原因码），阶段 B 用手写的黄金响应
 * 回放 hypothesize 与 conclude，校验提示词里有样例、机制引用保留、样例里的数字通过数值审计，群消息的关键问题写出样例计数。
 */
const PACKS = resolve(import.meta.dirname, '../../../../packages/packs-sdk/test/fixtures');
const RECORDINGS = resolve(import.meta.dirname, '../fixtures/llm/error-samples');
const MIN = 60_000;
const BASE = Math.floor(Date.now() / MIN) * MIN - 8 * 60 * MIN;
const GATEWAY = 'Deployment:llm/api-gateway';
const CARD = 'llm-gateway/gateway-errors/samples';
const metrics = new ServerMetrics('server', false);

const fixture = parse(readFileSync(join(PACKS, 'llm-gateway/tests/upstream-errors.yaml'), 'utf8')) as PackTestFile;

let prom: TsdbInstance;
let loki: Awaited<ReturnType<typeof startLoki>>;
let rt: PackRuntime;

const lokiSource = (timeoutMs: number): LokiSource => ({
  id: 'loki',
  url: loki.url,
  bearerTokenFile: null,
  tenant: null,
  labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
  timeoutMs,
});

async function evidence(timeoutMs = 15_000): Promise<PackEvidence> {
  return new PackEvidence(
    rt,
    await EvidenceSource.create(
      { id: 'prometheus', url: prom.url, dialect: 'promql', bearerTokenFile: null, timeoutMs: 5_000 },
      lokiSource(timeoutMs),
    ),
    async () => null,
    { locale: 'zh-CN', concurrency: 4, queryTimeoutMs: 5_000 },
    metrics,
  );
}

/** 网关上的事件：首次触发在 anchor 分钟，事件在 5 分钟后结束 */
function gatewayIncident(anchorMin: number): Incident {
  const base = incident();
  return {
    ...base,
    cluster_id: 'test',
    first_firing_at: new Date(BASE + anchorMin * MIN).toISOString(),
    ended_at: new Date(BASE + (anchorMin + 5) * MIN).toISOString(),
    state: 'resolved',
    root: {
      ...base.root,
      component: GATEWAY,
      entity: { cluster_id: 'test', kind: 'Deployment', namespace: 'llm', name: 'api-gateway', uid: null },
      ambiguous: false,
    },
    candidates: [{ ...base.candidates[0]!, component: GATEWAY }],
    components: [GATEWAY],
    members: [],
  };
}

const SUBGRAPH: Subgraph = {
  topology_version: 1,
  root: GATEWAY,
  nodes: [
    {
      component: GATEWAY,
      kind: 'Deployment',
      namespace: 'llm',
      name: 'api-gateway',
      role: 'root',
      alerts: [],
      hops: 0,
    },
    {
      component: 'Service:llm/api-gateway',
      kind: 'Service',
      namespace: 'llm',
      name: 'api-gateway',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
  ],
  edges: [
    {
      from: 'Service:llm/api-gateway',
      to: GATEWAY,
      relation: 'selects',
      provenance: 'structural',
      confidence: 1,
      scope: 'instance',
    },
  ],
};

const terminal = async (code: string) =>
  (await metrics.terminalStates.get()).values.find((v) => v.labels.stage === 'stage_a' && v.labels.code === code)
    ?.value ?? 0;

beforeAll(async () => {
  prom = await startPrometheus([]);
  loki = await startLoki(
    (fixture.input_logs ?? []).map((s) => ({
      labels: s.labels as Record<string, string>,
      lines: s.lines.map((l) => ({ t: BASE + durationSeconds(l.offset) * 1000, line: l.line })),
    })),
  );
  rt = await PackRuntime.load({
    dirs: [PACKS],
    only: ['llm-gateway'],
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: evidenceCapabilities(true),
  });
}, 300_000);

afterAll(async () => {
  await loki?.stop();
  await prom?.stop();
});

describe('阶段 A 的错误样例卡', () => {
  it('没有日志数据源时声明 requires: logs.query 的包被禁用', async () => {
    const without = await PackRuntime.load({
      dirs: [PACKS],
      only: ['llm-gateway'],
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: evidenceCapabilities(false),
    });
    expect(without.set.cards.has(CARD)).toBe(false);
    expect(rt.set.cards.has(CARD)).toBe(true);
  });

  it('样例按出站模块的规则脱敏后写进结果，结果符合契约', async () => {
    const run = await (await evidence()).run(gatewayIncident(15), [], AbortSignal.timeout(60_000), BASE + 20 * MIN);
    const card = run.cards.find((c) => c.card_id === CARD)!;
    expect(validatorFor('schemas/evidence-result.schema.json')(card)).toBe(true);
    expect(card.verdict).toBe('abnormal');
    const s = card.samples!;
    expect(s.classes.map((k) => [k.class, k.count])).toEqual([
      ['quota_exhausted', 12],
      ['other', 2],
    ]);
    const texts = s.classes.flatMap((k) => k.samples.map((m) => m.text)).join('\n');
    // 最新的一行配额耗尽带 request_token：样例里只剩脱敏标记
    expect(texts).not.toContain('Tk7f9q2LmZ8w');
    expect(texts).toContain('request_token=[REDACTED:kv_secret]');
    expect(s.redactions).toBe(1);
    expect(card.table!.rows[0]!.slice(0, 7)).toEqual([
      'provider-a',
      'model-x',
      '429',
      'upstream_error',
      '-',
      '配额耗尽',
      '12',
    ]);
  }, 120_000);

  it('证据期限已到时样例卡照常出结果：无法判定，原因码 samples_deadline，并计入终态指标', async () => {
    const before = await terminal('samples_deadline');
    const run = await (await evidence()).run(gatewayIncident(15), [], AbortSignal.abort(), BASE + 20 * MIN);
    const card = run.cards.find((c) => c.card_id === CARD)!;
    expect(validatorFor('schemas/evidence-result.schema.json')(card)).toBe(true);
    expect(card).toMatchObject({
      verdict: 'undeterminable',
      reason: { kind: 'source_error', text: '证据期限内没有取完错误日志' },
      samples: { code: 'samples_deadline', lines: 0, classes: [] },
    });
    expect(await terminal('samples_deadline')).toBe(before + 1);
  }, 120_000);

  it('日志查询超时：原因码 samples_timeout', async () => {
    const before = await terminal('samples_timeout');
    const run = await (await evidence(1)).run(gatewayIncident(15), [], AbortSignal.timeout(60_000), BASE + 20 * MIN);
    const card = run.cards.find((c) => c.card_id === CARD)!;
    expect(card.verdict).toBe('undeterminable');
    expect(card.samples).toMatchObject({ code: 'samples_timeout', lines: 0 });
    expect(await terminal('samples_timeout')).toBe(before + 1);
  }, 120_000);
});

/** 四类上游错误：事件锚点（分钟）、黄金响应目录、期望的类别行数与机制里必须出现的内容 */
const CASES = [
  {
    name: '外部上游的配额耗尽（429）',
    dir: 'quota',
    anchor: 15,
    classes: [
      ['quota_exhausted', 12],
      ['other', 2],
    ],
    line: '配额耗尽 12，其他 2',
    mechanism: [/429/, /配额耗尽 12 行/],
  },
  {
    name: '能力不匹配（400 加 524）',
    dir: 'capability',
    anchor: 112,
    classes: [
      ['capability_mismatch', 6],
      ['origin_timeout', 4],
    ],
    line: '能力不匹配 6，上游源站超时（524） 4',
    mechanism: [/400/, /524/, /能力不匹配 6 行/],
  },
  {
    name: '单一端点返回 503',
    dir: 'endpoint',
    anchor: 210,
    classes: [['upstream_unavailable', 8]],
    line: '上游不可用（503） 8',
    mechanism: [/503/, /上游不可用 8 行/],
  },
  {
    name: '单一供给的首内容超时由网关返回 503，没有候选可以转移',
    dir: 'first-content',
    anchor: 308,
    classes: [['first_content_timeout', 6]],
    line: '首内容超时 6',
    mechanism: [/候选数 1/, /首内容超时阈值 30s/, /首内容超时 6 行/, /上游没有返回错误/],
  },
] as const;

describe.each(CASES)('回放：$name', (c) => {
  let model: LlmReplay;
  let modelUrl: string;

  beforeAll(async () => {
    model = new LlmReplay({ dir: join(RECORDINGS, c.dir) });
    modelUrl = `http://127.0.0.1:${await model.listen('127.0.0.1', 0)}/v1`;
  });

  afterAll(async () => {
    await model.close();
  });

  it('阶段 A 的样例与类别一致；研判的机制引用样例卡，样例里的数字通过数值审计；群消息写出样例计数', async () => {
    const inc = gatewayIncident(c.anchor);
    const run = await (await evidence()).run(inc, [], AbortSignal.timeout(60_000), BASE + (c.anchor + 5) * MIN);
    const card = run.cards.find((x) => x.card_id === CARD)! as EvidenceResult;
    expect(card.verdict).toBe('abnormal');
    expect(card.samples!.classes.map((k) => [k.class, k.count])).toEqual(c.classes);

    const report = { ...stageA(run.cards), incident_id: inc.incident_id, incident_version: inc.incident_version };
    const rc = researchCase({ incident: inc, stageA: report, subgraph: SUBGRAPH, actions: [], runbooks: [] });
    const sink = new MemorySink();
    const res = await runStageB(
      { runId: '7a1b2c3d-0000-4000-8000-0000000000e1', rc, previous: null, signal: new AbortController().signal },
      testEnv(testLayer([testRoute(modelUrl)]), [], false),
      sink,
    );
    expect(model.missing).toEqual([]);
    expect(res.state).toBe('completed');
    const out = res.output as ResearchOutput;
    expect(validatorFor('schemas/research-output.schema.json')(out)).toBe(true);

    // hypothesize 的请求带错误样例片段，输出 schema 的 sample_refs 只有这张卡
    const hyp = sink.llm.find((r) => r.phase === 'hypothesize')!;
    expect(hyp.categories).toContain('logs');
    expect(hyp.request).toContain('## 错误样例');
    expect(hyp.request).toContain(`\\"class\\":\\"${c.classes[0][0]}\\"`);
    // 输出 schema 带 mechanism_refs（字段说明随可移植 schema 发出）
    expect(hyp.request).toContain('支撑机制的错误样例卡');

    const h1 = out.hypotheses.find((h) => h.id === 'h1')!;
    expect(h1.mechanism_refs).toEqual([card.ref]);
    for (const re of c.mechanism) {
      expect(h1.mechanism).toMatch(re);
    }
    expect(out.validation_notes.filter((n) => n.includes('无法核实的数值'))).toEqual([]);

    const input: ComposeInput = {
      incident: inc,
      stageA: report,
      researchStageA: report,
      alerts: [],
      research: {
        run_id: '7a1b2c3d-0000-4000-8000-0000000000e1',
        state: 'completed',
        disposition: out.disposition,
        conclusion_level: out.conclusion.level,
        root_component: out.conclusion.root_component,
        output: out,
        error: null,
        incident_version: inc.incident_version,
        started_at: inc.ended_at,
        finished_at: inc.ended_at,
      },
      researchPending: false,
      stageAOnlyReason: null,
      proposals: [],
      feedback: null,
      prefix: '',
      consoleUrl: 'https://srenautix.example.test',
      language: 'zh',
    };
    const key = composeMessage(input)
      .message.sections.find((s) => s.kind === 'key_issue')!
      .blocks.map((b) => b.text);
    const mech = key.findIndex((t) => t.includes('机制：'));
    expect(key[mech + 1]).toBe(`样例：${card.ref}（共 ${card.samples!.lines} 行）${c.line}`);
  }, 180_000);
});
