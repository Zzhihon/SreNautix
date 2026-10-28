import type { ChatCompletion } from 'openai/resources/chat/completions/completions';
import { describe, expect, it } from 'vitest';
import {
  calibrate,
  callCost,
  dailyGate,
  DEFAULT_BUDGET,
  estimateTokens,
  newCalibration,
  plausibleRatio,
  rawEstimate,
  restoredCalibration,
  ResearchLedger,
} from '../../src/llm/budget.js';
import { RouteBreaker, touchesFailureDomain, DEFAULT_BREAKER } from '../../src/llm/breaker.js';
import { declaredProfile } from '../../src/llm/dialect.js';
import { FingerprintTracker } from '../../src/llm/fingerprint.js';
import { repairLocally } from '../../src/llm/repair.js';
import { assertPortable, bindSchema, modelSchema, salvage, validatorOf } from '../../src/llm/schema.js';
import type { LlmTurn } from '../../src/llm/types.js';
import { fromChatCompletion } from '../../src/llm/wire.js';
import { fixture } from '../support/llm-fixtures.js';

const turn = (text: string | null, over: Partial<LlmTurn> = {}): LlmTurn => ({
  text,
  reasoningChars: 0,
  refusal: null,
  toolCalls: [],
  incomplete: null,
  usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
  responseModel: null,
  systemFingerprint: null,
  ...over,
});

describe('失败型熔断', () => {
  it('60 秒内 5 次失败打开；每 30 秒放行一次探测；探测成功关闭', () => {
    const b = new RouteBreaker('r', DEFAULT_BREAKER);
    let t = 1_000_000;
    for (let i = 0; i < 4; i++) {
      b.failure((t += 1000), false);
    }
    expect(b.state(t)).toBe('closed');
    b.failure((t += 1000), false);
    expect(b.admit(t).allowed).toBe(false);
    expect(b.consumeOpened()).toBe(true);
    expect(b.admit(t + 29_000).allowed).toBe(false);
    const probe = b.admit(t + 30_000);
    expect(probe).toMatchObject({ allowed: true, probe: true });
    expect(b.admit(t + 30_001).allowed).toBe(false);
    b.failure(t + 31_000, true);
    expect(b.admit(t + 40_000).allowed).toBe(false);
    const p2 = b.admit(t + 61_000);
    expect(p2.probe).toBe(true);
    b.success(t + 62_000, 200, true);
    expect(b.state(t + 62_000)).toBe('closed');
  });

  it('窗口外的失败不累计', () => {
    const b = new RouteBreaker('r', DEFAULT_BREAKER);
    for (let i = 0; i < 10; i++) {
      b.failure(i * 20_000, false);
    }
    expect(b.state(200_000)).toBe('closed');
  });
});

describe('延迟型熔断', () => {
  it('成功调用的首 token 延迟 p50 超过阈值时打开；探测的首 token 回到阈值以内时关闭', () => {
    const b = new RouteBreaker('r', { ...DEFAULT_BREAKER, latencyThresholdMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      b.success(i, 70_000, false);
    }
    expect(b.state(10)).toBe('closed');
    b.success(5, 70_000, false);
    expect(b.openReason).toBe('latency');
    const p = b.admit(30_005);
    b.success(30_006, 10_000, p.probe);
    expect(b.state(30_007)).toBe('closed');
  });

  it('慢但成功（首 token 快、输出长、总耗时 100 秒）不打开延迟型熔断', () => {
    const b = new RouteBreaker('r', { ...DEFAULT_BREAKER, latencyThresholdMs: 60_000 });
    // 首 token 6 秒，总耗时 100 秒：只有首 token 进入延迟样本
    for (let i = 0; i < 20; i++) {
      b.success(i * 1000, 6_000, false);
    }
    expect(b.state(30_000)).toBe('closed');
    expect(b.p50(30_000)).toBe(6_000);
  });

  it('失败（超时）只计入失败型，不进入延迟样本', () => {
    const b = new RouteBreaker('r', { ...DEFAULT_BREAKER, latencyThresholdMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      b.success(i, 5_000, false);
    }
    for (let i = 0; i < 4; i++) {
      b.failure(100 + i, false);
    }
    expect(b.openReason).toBeNull();
    expect(b.p50(200)).toBe(5_000);
    b.failure(200, false);
    expect(b.openReason).toBe('failure');
  });
});

describe('故障域', () => {
  it('组件键相等，或落在声明的命名空间伪组件下', () => {
    expect(touchesFailureDomain(['Deployment:llm/gateway'], ['Deployment:llm/gateway'])).toBe('Deployment:llm/gateway');
    expect(touchesFailureDomain(['Pod:llm/gateway-abc'], ['Namespace:llm'])).toBe('Pod:llm/gateway-abc');
    expect(touchesFailureDomain(['Deployment:shop/api'], ['Namespace:llm'])).toBeNull();
  });
});

describe('预算与估算校准', () => {
  it('按实际 usage 校准估算，余量 10%', () => {
    let c = newCalibration('r');
    const raw = rawEstimate('x'.repeat(4000), 'byte_estimate');
    expect(raw).toBe(2000);
    expect(estimateTokens(c, raw)).toBe(2000);
    c = calibrate(c, raw, 1000);
    expect(estimateTokens(c, raw)).toBe(Math.ceil(2000 * 0.5 * 1.1));
    c = calibrate(c, raw, 3000);
    expect(estimateTokens(c, raw)).toBeGreaterThanOrEqual(Math.ceil(2000 * 1.5 * 1.1) - 1);
  });

  it('服务方计数异常的样本不计入校准；状态库里系数异常的校准从头开始（ADR 0129）', () => {
    let c = newCalibration('primary');
    // CCHP 的 primary：2.9k token 的请求报了 24,993 输入 token，之后的估算长期偏大数倍
    c = calibrate(c, 2877, 2877);
    const after = calibrate(c, 2877, 24_993);
    expect(after).toEqual(c);
    expect(estimateTokens(after, 20_000)).toBe(Math.ceil(20_000 * 1.1));
    expect(calibrate(c, 2877, 100)).toEqual(c);
    expect(plausibleRatio(0.45)).toBe(true);
    expect(plausibleRatio(8.7)).toBe(false);
    const polluted = { routeId: 'primary', factor: 1.3, recentMax: 8.7, samples: 40 };
    expect(restoredCalibration('primary', polluted)).toEqual(newCalibration('primary'));
    const healthy = { routeId: 'primary', factor: 0.98, recentMax: 1.1, samples: 40 };
    expect(restoredCalibration('primary', healthy)).toBe(healthy);
    expect(restoredCalibration('primary', null)).toEqual(newCalibration('primary'));
  });

  it('tiktoken 分词', () => {
    expect(rawEstimate('hello world', 'tiktoken_o200k')).toBe(2);
  });

  it('缓存命中的输入按缓存单价计费', () => {
    const price = { currency: 'USD' as const, input_per_mtok: 2, output_per_mtok: 8, cached_input_per_mtok: 0.5 };
    expect(callCost(price, { input: 1_000_000, cachedInput: 400_000, output: 100_000, reasoning: 0 })).toBeCloseTo(
      0.6 * 2 + 0.4 * 0.5 + 0.8,
    );
  });

  it('每日预算：80% 后 warning 只出阶段 A，100% 后只有 critical 进入阶段 B', () => {
    const cfg = { ...DEFAULT_BUDGET, dailyTokens: 15_000_000 };
    expect(dailyGate(cfg, 11_000_000, 'warning')).toEqual({ allowed: true });
    expect(dailyGate(cfg, 12_000_000, 'warning')).toEqual({ allowed: false, reason: 'daily_warn' });
    expect(dailyGate(cfg, 12_000_000, 'critical')).toEqual({ allowed: true });
    expect(dailyGate(cfg, 15_000_000, 'critical')).toEqual({ allowed: true });
    expect(dailyGate({ ...cfg, onExhausted: 'stage_a_only' }, 15_000_000, 'critical')).toEqual({
      allowed: false,
      reason: 'daily_exhausted',
    });
  });

  it('研判账本：阶段单次上限与研判合计上限', () => {
    const l = new ResearchLedger(DEFAULT_BUDGET);
    expect(l.check('hypothesize', 70_000)).toMatch(/单次上限/);
    l.record({ input: 140_000, cachedInput: 0, output: 1000, reasoning: 0 }, 0);
    expect(l.check('conclude', 20_000)).toMatch(/超过上限/);
  });
});

describe('服务方指纹', () => {
  it('新指纹连续出现 3 次才确认变化', () => {
    const f = new FingerprintTracker('r', 'fp:a');
    expect(f.observe('fp:b')).toBeNull();
    expect(f.observe('fp:a')).toBeNull();
    expect(f.observe('fp:b')).toBeNull();
    expect(f.observe('fp:b')).toBeNull();
    expect(f.observe('fp:b')).toEqual({ routeId: 'r', from: 'fp:a', to: 'fp:b' });
    expect(f.current).toBe('fp:b');
  });
});

describe('可移植 schema 与动态枚举', () => {
  const enums = {
    components: ['Deployment:shop/api', 'StatefulSet:shop/postgres'],
    evidence_refs: ['card:1', 'card:2', 'alert:1'],
    sample_refs: ['card:2'],
    check_templates: ['postgres/connections', 'metrics_query'],
    runbooks: [],
    actions: ['workload_scale'],
  };

  it('契约中的两个模型 schema 都在可移植子集内', () => {
    assertPortable(modelSchema('hypothesize'));
    assertPortable(modelSchema('conclude'));
  });

  it('绑定后：组件、证据引用只能取本次运行的值；可空的空枚举只允许 null', () => {
    const b = bindSchema(modelSchema('conclude'), enums);
    const s = JSON.stringify(b.portable);
    expect(s).not.toContain('x-srenautix');
    expect(s).not.toContain('maxLength');
    const props = b.full.properties as Record<string, { items: { properties: Record<string, { enum?: unknown[] }> } }>;
    const rec = props.recommendations?.items.properties;
    expect(rec?.runbook_ref?.enum).toEqual([null]);
    expect(rec?.evidence_refs).toMatchObject({ items: { enum: enums.evidence_refs } });
  });

  it('空的不可空枚举使所在数组只能为空', () => {
    const b = bindSchema(modelSchema('hypothesize'), { ...enums, check_templates: [] });
    const nc = (b.full.properties as Record<string, Record<string, unknown>>).next_checks;
    expect(nc?.maxItems).toBe(0);
  });

  it('按字段挽救：删除不合格的条目、截断超长文本、补齐可空字段', () => {
    const b = bindSchema(modelSchema('hypothesize'), enums);
    const notes: string[] = [];
    const r = salvage(
      b.full,
      {
        hypotheses: [
          {
            id: 'h1',
            parent_id: null,
            root_component: 'StatefulSet:shop/postgres',
            mechanism: 'x'.repeat(700),
            supporting: ['card:2', 'card:9'],
            refuting: [],
          },
          {
            id: 'h2',
            parent_id: null,
            root_component: 'Deployment:other/x',
            mechanism: 'y',
            supporting: [],
            refuting: [],
          },
        ],
        next_checks: [],
        extra: 1,
      },
      notes,
    );
    expect(r.ok).toBe(true);
    expect(validatorOf(b.full)(r.value)).toBe(true);
    const v = r.value as { hypotheses: Array<{ id: string; mechanism: string; supporting: string[] }> };
    expect(v.hypotheses.map((h) => h.id)).toEqual(['h1']);
    expect(v.hypotheses[0]?.supporting).toEqual(['card:2']);
    expect(v.hypotheses[0]?.mechanism).toHaveLength(600);
    expect(notes.join('\n')).toMatch(/多余字段/);
  });
});

describe('修复阶梯（本地四级）', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['component', 'verdict', 'refs'],
    properties: {
      component: { type: 'string', enum: ['Deployment:shop/api', 'StatefulSet:shop/postgres'] },
      verdict: { type: 'string', enum: ['abnormal', 'normal'] },
      refs: { type: 'array', items: { type: 'string', enum: ['card:1', 'card:2'] } },
    },
  };
  const p = declaredProfile('llamacpp');

  it('录制的 json_schema 输出直接通过校验', () => {
    const t = fromChatCompletion(fixture('llamacpp-qwen3-1.7b', 'chat-json-schema').body as ChatCompletion, p);
    expect(repairLocally(t, schema)).toMatchObject({ ok: true, step: 'validate' });
  });

  it('录制的 json_object 输出直接通过校验', () => {
    const t = fromChatCompletion(fixture('llamacpp-qwen3-1.7b', 'chat-json-object').body as ChatCompletion, p);
    expect(repairLocally(t, schema)).toMatchObject({ ok: true });
  });

  it('长度截断判为不完整', () => {
    const t = fromChatCompletion(fixture('llamacpp-qwen3-1.7b', 'chat-length').body as ChatCompletion, p);
    expect(repairLocally(t, schema)).toMatchObject({ ok: false, step: 'parse' });
  });

  it('代码块包裹与尾逗号由 jsonrepair 修复', () => {
    const r = repairLocally(
      turn('```json\n{"component":"Deployment:shop/api","verdict":"abnormal","refs":["card:1",],}\n```'),
      schema,
    );
    expect(r).toMatchObject({ ok: true, step: 'jsonrepair' });
  });

  it('枚举外的引用按字段挽救', () => {
    const r = repairLocally(
      turn('{"component":"Deployment:shop/api","verdict":"abnormal","refs":["card:1","card:7"]}'),
      schema,
    );
    expect(r).toMatchObject({ ok: true, step: 'field_salvage', value: { refs: ['card:1'] } });
  });

  it('必填字段无法挽救时失败；拒答直接失败', () => {
    expect(repairLocally(turn('{"component":"Pod:x/y","verdict":"abnormal","refs":[]}'), schema)).toMatchObject({
      ok: false,
      step: 'field_salvage',
    });
    expect(repairLocally(turn(null, { refusal: 'no' }), schema)).toMatchObject({ ok: false, refusal: true });
  });

  it('录制的 /v1/responses 输出不符合 schema（llama.cpp 不执行 json_schema）', () => {
    const body = fixture('llamacpp-qwen3-1.7b', 'responses-json-schema').body as {
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
    };
    const text = body.output.find((o) => o.type === 'message')?.content?.[0]?.text ?? null;
    expect(repairLocally(turn(text), schema)).toMatchObject({ ok: false, step: 'field_salvage' });
  });
});
