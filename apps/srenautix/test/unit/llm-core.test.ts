import type { ChatCompletion } from 'openai/resources/chat/completions/completions';
import { describe, expect, it } from 'vitest';
import {
  calibrate,
  callCost,
  dailyGate,
  DEFAULT_BUDGET,
  estimateTokens,
  newCalibration,
  rawEstimate,
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
      b.failure((t += 1000), 100, false);
    }
    expect(b.state(t)).toBe('closed');
    b.failure((t += 1000), 100, false);
    expect(b.admit(t).allowed).toBe(false);
    expect(b.consumeOpened()).toBe(true);
    expect(b.admit(t + 29_000).allowed).toBe(false);
    const probe = b.admit(t + 30_000);
    expect(probe).toMatchObject({ allowed: true, probe: true });
    expect(b.admit(t + 30_001).allowed).toBe(false);
    b.failure(t + 31_000, 100, true);
    expect(b.admit(t + 40_000).allowed).toBe(false);
    const p2 = b.admit(t + 61_000);
    expect(p2.probe).toBe(true);
    b.success(t + 62_000, 200, true);
    expect(b.state(t + 62_000)).toBe('closed');
  });

  it('窗口外的失败不累计', () => {
    const b = new RouteBreaker('r', DEFAULT_BREAKER);
    for (let i = 0; i < 10; i++) {
      b.failure(i * 20_000, 100, false);
    }
    expect(b.state(200_000)).toBe('closed');
  });
});

describe('延迟型熔断', () => {
  it('p50 超过单次超时的一半时打开', () => {
    const b = new RouteBreaker('r', { ...DEFAULT_BREAKER, callTimeoutMs: 90_000 });
    for (let i = 0; i < 4; i++) {
      b.success(i, 50_000, false);
    }
    expect(b.state(10)).toBe('closed');
    b.success(5, 50_000, false);
    expect(b.openReason).toBe('latency');
    const p = b.admit(30_005);
    b.success(30_006, 10_000, p.probe);
    expect(b.state(30_007)).toBe('closed');
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
