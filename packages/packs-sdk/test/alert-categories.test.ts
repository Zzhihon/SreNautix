import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertCatalogEntry } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PACKS, REPO } from './support.js';

// 仓库自带的告警目录条目都声明类别（ADR 0183）：没有声明的条目在没有部署方规则时成为 unclassified，按类别筛选时总是返回
const files = [
  ...readdirSync(PACKS)
    .map((p) => join(PACKS, p, 'alerts.yaml'))
    .filter((f) => existsSync(f)),
  join(REPO, 'deploy/kind/gitops/srenautix/packs/kind-shop/alerts.yaml'),
];

describe('内置告警目录的类别', () => {
  it.each(files.map((f) => [f.slice(REPO.length), f]))('%s 的每个条目都声明了 category', (_, f) => {
    const entries = (parse(readFileSync(f, 'utf8')) as { entries: AlertCatalogEntry[] }).entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.category === undefined).map((e) => e.id)).toEqual([]);
  });

  it('同名告警的变体类别相同', () => {
    const byName = new Map<string, Set<string>>();
    for (const f of files) {
      for (const e of (parse(readFileSync(f, 'utf8')) as { entries: AlertCatalogEntry[] }).entries) {
        byName.set(e.alertname, (byName.get(e.alertname) ?? new Set()).add(e.category!));
      }
    }
    expect([...byName].filter(([, c]) => c.size > 1).map(([n]) => n)).toEqual([]);
  });
});
