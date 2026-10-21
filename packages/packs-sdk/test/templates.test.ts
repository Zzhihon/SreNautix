// 查询模板（阶段 B 的区分性检查）由 compilePackSet 编译：附带的卡与证据卡一样严格检查，模板参数的 schema 要能约束模型给出的值。
import { describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { applyCheckArgs, checkArgsSchema } from '../src/judge/check-args.js';
import { checkTemplateArgs, compilePackSet } from '../src/pack/compile.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { CATALOG, PACKS } from './support.js';

const ok = {
  type: 'object',
  additionalProperties: false,
  properties: {
    k: { type: 'integer', minimum: 1, maximum: 20, description: '列出前几名' },
    other: { type: 'string', pattern: '^[a-z0-9-]+$', description: '对比的工作负载名' },
  },
};

describe('查询模板', () => {
  it('内置包的模板编译进 PackSet：键为 <pack>/templates/<id>，附带的卡在 cards 中', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
    const ids = set.templates.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'workload/cpu-by-pod',
        'workload/memory-by-pod',
        'workload/restarts-by-pod',
        'workload/compare-restarts',
      ]),
    );
    for (const t of set.templates) {
      expect(t.card).toBe(`${t.pack}/templates/${t.id.slice(t.pack.length + 1)}`);
      expect(set.cards.get(t.card)?.chain).toBeNull();
    }
  });

  it('卡片作为检查：schema 含窗口与全部 params，check.args 约束取值；合并只覆盖给出的部分', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS), { catalog: CATALOG });
    const hpa = set.cards.get('workload/capacity/hpa-latency')!.def;
    const schema = checkArgsSchema(hpa) as {
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['factor', 'min_seconds', 'window_after', 'window_before']);
    expect(schema.properties.factor).toMatchObject({ type: 'number', minimum: 1.1, maximum: 10 });
    // 没有 check 块的卡：类型取默认值的类型
    const plain = set.cards.get('workload/job/status')!.def;
    expect((checkArgsSchema(plain) as { properties: Record<string, unknown> }).properties.max_hours).toEqual({
      type: 'number',
    });
    expect(applyCheckArgs(hpa, { factor: 2, window_before: '2h' })).toEqual({
      params: { factor: 2 },
      // hpa-latency 没有声明窗口：没有给出的端点取默认窗口
      window: { before: '2h', after: '10m' },
    });
    expect(applyCheckArgs(hpa, {})).toEqual({ params: {}, window: undefined });
  });

  it('模板参数必须是卡的 params、有说明与取值约束，卡的默认值满足它', () => {
    expect(() => checkTemplateArgs(ok, { k: 5, other: 'web' }, 'x')).not.toThrow();
    const fails = (args: Record<string, unknown>, params: Record<string, unknown>, detail: RegExp) =>
      expect(() => checkTemplateArgs(args, params, 'x')).toThrow(detail);
    fails({ ...ok, additionalProperties: true }, { k: 5, other: 'web' }, /additionalProperties/);
    fails(ok, { k: 5 }, /other.*不是附带卡的 params/);
    fails({ ...ok, properties: { k: { type: 'integer', minimum: 1, maximum: 20 } } }, { k: 5 }, /缺少 description/);
    fails(
      { ...ok, properties: { other: { type: 'string', description: '名字' } } },
      { other: 'web' },
      /enum 或 pattern/,
    );
    fails(
      { ...ok, properties: { k: { type: 'integer', minimum: 1, description: 'k' } } },
      { k: 5 },
      /minimum 与 maximum/,
    );
    fails(ok, { k: 50, other: 'web' }, /不在 \[1, 20\] 内/);
    fails(ok, { k: 5, other: 'Web_1' }, /不满足参数的限定/);
    expect(() => checkTemplateArgs(ok, { k: 5 }, 'x')).toThrow(PackLintError);
  });
});
