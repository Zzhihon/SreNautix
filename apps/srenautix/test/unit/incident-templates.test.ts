import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackRuntime, usesDbstats } from '../../src/stage-a/packs.js';
import { PACKS } from '../support/packs.js';

// 事件研判的模板列表不含 dbstats 模板（ADR 0146 §3.1）：内置包加上 database 领域之后，事件研判的模板与之前完全相同

describe('事件研判的查询模板', () => {
  it('附带的卡引用 dbstats 信号的模板只留给主动优化', async () => {
    const rt = await PackRuntime.load({
      dirs: [PACKS],
      only: null,
      lockFile: null,
      catalogPath: DEFAULT_CATALOG_PATH,
      capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
    });
    const all = rt.set.templates.map((t) => t.id);
    const incident = rt.templates.map((t) => t.id);
    expect(all).toContain('postgres/statement-detail');
    expect(incident).not.toContain('postgres/statement-detail');
    // 其余模板一个不少，顺序不变
    expect(incident).toEqual(rt.set.templates.filter((t) => !usesDbstats(rt.set, t.card)).map((t) => t.id));
    expect(all.filter((id) => !incident.includes(id)).every((id) => id.startsWith('postgres/'))).toBe(true);
  });
});
