import type { PackSet } from '@srenautix/packs-sdk';
import type { CatalogBody } from '../api/routes-goals.js';
import type { OptimizationCatalog } from './goals.js';

// 新建目标时可以选的指标与领域（GET /v1/optimization/catalog，ADR 0146 §5.1）：只来自加载的领域包。

export function optimizationCatalog(set: PackSet): OptimizationCatalog & { raw: CatalogBody } {
  const indicators = new Map([...set.indicators.values()].map((i) => [i.key, { pack: i.pack, def: i.def }] as const));
  const domains = new Map(
    [...set.domains.values()].map((d) => [d.id, { packs: d.packs, indicators: d.indicators }] as const),
  );
  return {
    indicators,
    domains,
    raw: {
      indicators: [...set.indicators.values()]
        .map((i) => ({ id: i.key, definition: i.def }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      domains: [...set.domains.values()]
        .map((d) => ({
          id: d.id,
          title: d.title ?? { 'zh-CN': d.id, en: d.id },
          packs: [...d.packs],
          indicators: [...d.indicators],
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}
