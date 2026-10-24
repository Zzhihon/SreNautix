import { describe, expect, it } from 'vitest';
import { Egress } from '../../src/llm/egress.js';
import { DEFAULT_EGRESS_CATEGORIES, type LlmRequest, type Segment } from '../../src/llm/types.js';
import { workerConfigSchema } from '../../src/research/config.js';

// 出境类别（ADR 0146 §3.6）：llm.egress.categories 之外的类别在出站前删除，删除次数按类别计数；
// 没有配置时允许事件研判一直使用的类别，不含 sql 与 code。

const seg = (text: string, categories: Segment['categories']): Segment => ({ text, categories, egress: 'allow' });

const request = (): LlmRequest => ({
  items: [
    { type: 'system', segments: [seg('固定指令', [])] },
    {
      type: 'user',
      segments: [
        seg('卡片', ['metrics']),
        seg('SELECT * FROM t WHERE id = $1', ['sql']),
        seg('func f() {}', ['code']),
        seg('混合', ['metrics', 'code']),
      ],
    },
    { type: 'tool_call', callId: 'c1', name: 'code_excerpt', arguments: '{}' },
    { type: 'tool_result', callId: 'c1', output: seg('func g() {}', ['code']) },
  ],
  maxOutputTokens: 100,
});

const texts = (r: LlmRequest) =>
  r.items.flatMap((i) =>
    i.type === 'user' || i.type === 'system'
      ? i.segments.map((s) => s.text)
      : i.type === 'tool_result'
        ? [i.output.text]
        : [],
  );

describe('出境类别', () => {
  it('没有配置时只允许事件研判的类别，sql 与 code 的片段删除并计数', () => {
    expect(DEFAULT_EGRESS_CATEGORIES).not.toContain('sql');
    expect(DEFAULT_EGRESS_CATEGORIES).not.toContain('code');
    const e = new Egress({ allowCrossBorder: true, honeytokens: [] }, () => undefined);
    const p = e.prepare(request());
    expect(texts(p.request)).toEqual(['固定指令', '卡片', expect.stringContaining('不允许出境')]);
    expect(p.dropped).toEqual({ sql: 1, code: 3 });
  });

  it('配置了 sql 与 code 时原样出站，没有删除', () => {
    const e = new Egress(
      { allowCrossBorder: true, honeytokens: [], categories: [...DEFAULT_EGRESS_CATEGORIES, 'sql', 'code'] },
      () => undefined,
    );
    const p = e.prepare(request());
    expect(texts(p.request)).toEqual([
      '固定指令',
      '卡片',
      'SELECT * FROM t WHERE id = $1',
      'func f() {}',
      '混合',
      'func g() {}',
    ]);
    expect(p.dropped).toEqual({});
  });

  it('只允许部分类别时，携带任一不允许类别的片段都删除', () => {
    const e = new Egress({ allowCrossBorder: true, honeytokens: [], categories: ['metrics', 'sql'] }, () => undefined);
    const p = e.prepare(request());
    expect(texts(p.request)).toEqual(['固定指令', '卡片', 'SELECT * FROM t WHERE id = $1', expect.any(String)]);
    expect(p.dropped).toEqual({ code: 3 });
  });

  it('worker 配置的 llm.egress.categories 只接受已知类别', () => {
    const base = {
      cluster_id: 'c',
      code_sha: 'a'.repeat(40),
      hub: { url: 'http://hub:8080', token_file: '/t' },
      inbound: { token_sha256_file: '/s' },
      budget: { daily_tokens: 100000 },
    };
    const route = {
      id: 'r',
      base_url: 'http://m/v1',
      api: 'responses',
      model: 'm',
      dialect_profile: 'openai-responses',
      price: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
      in_domain: true,
      tier: 'large',
      retention_terms: 'x',
      api_key_file: '/k',
    };
    const ok = workerConfigSchema.parse({
      ...base,
      llm: { routes: [route], egress: { categories: ['metrics', 'sql', 'code'] } },
    });
    expect(ok.llm.egress?.categories).toEqual(['metrics', 'sql', 'code']);
    expect(workerConfigSchema.parse({ ...base, llm: { routes: [route] } }).llm.egress).toBeUndefined();
    expect(() =>
      workerConfigSchema.parse({ ...base, llm: { routes: [route], egress: { categories: ['rows'] } } }),
    ).toThrow();
  });
});
