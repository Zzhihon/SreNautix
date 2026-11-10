#!/usr/bin/env node
// 生成 docs/adr/README.md：每篇 ADR 的编号、标题、状态，以及之后引用它的 ADR（反向链接），
// 读一篇 ADR 时据此找到后来的修订。同时校验：
//   - 状态行（标题下第一个非空行写成「状态：…」）取值合法，「部分取代」「已取代」要写出取代它的 ADR 编号；
//   - 正文里引用的 ADR 编号都存在（悬空引用会失败）。
// 用法：node hack/adr-index.mjs [--check]；--check 不写文件，生成结果与仓库不一致或校验失败时退出码为 1。

/* global console, process */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'docs', 'adr');
const OUT = join(DIR, 'README.md');
const STATUSES = ['提议', '已采纳', '部分取代', '已取代'];

const files = readdirSync(DIR)
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .sort();
const errors = [];
const adrs = files.map((file) => {
  const text = readFileSync(join(DIR, file), 'utf8');
  const lines = text.split('\n');
  const number = file.slice(0, 4);
  const heading = lines[0] ?? '';
  const title = heading.replace(/^#\s*\d{4}\s*/, '').trim();
  if (!heading.startsWith(`# ${number} `)) {
    errors.push(`${file}：第一行应为「# ${number} 标题」`);
  }
  const firstBody = lines.slice(1).find((l) => l.trim() !== '') ?? '';
  let status = '已采纳';
  let by = [];
  // 状态行：「状态：<状态>」，后面可以跟括号里的说明；「（见 NNNN、MMMM）」给出取代它的 ADR
  const m = /^状态：([^（。\s]+)/.exec(firstBody.trim());
  if (m) {
    status = m[1];
    const seeAlso = /（见 ([^）]+)）/.exec(firstBody);
    by = seeAlso ? [...seeAlso[1].matchAll(/\d{4}/g)].map((x) => x[0]) : [];
    if (!STATUSES.includes(status)) {
      errors.push(`${file}：状态只能是 ${STATUSES.join('、')}：${status}`);
    }
    if ((status === '部分取代' || status === '已取代') && by.length === 0) {
      errors.push(`${file}：${status} 要写出取代它的 ADR，例如「状态：${status}（见 0098）」`);
    }
  }
  const refs = [...new Set([...text.matchAll(/ADR (\d{4})/g)].map((x) => x[1]))].filter((n) => n !== number);
  return { file, number, title, status, by, refs };
});

const known = new Set(adrs.map((a) => a.number));
for (const a of adrs) {
  for (const n of [...a.refs, ...a.by]) {
    if (!known.has(n)) {
      errors.push(`${a.file}：引用的 ADR ${n} 不存在`);
    }
  }
}

const citedBy = new Map(adrs.map((a) => [a.number, []]));
for (const a of adrs) {
  for (const n of a.refs) {
    citedBy.get(n)?.push(a.number);
  }
}

const link = (n) => {
  const a = adrs.find((x) => x.number === n);
  return a ? `[${n}](${a.file})` : n;
};
const statusText = (a) => (a.by.length ? `${a.status}（见 ${a.by.map(link).join('、')}）` : a.status);
const rows = adrs.map((a) => {
  const later = (citedBy.get(a.number) ?? []).filter((n) => n > a.number);
  return `| ${link(a.number)} | ${a.title.replaceAll('|', '\\|')} | ${statusText(a)} | ${later.map(link).join(' ') || '—'} |`;
});

const out = `# 架构决策记录（ADR）

<!-- 由 hack/adr-index.mjs 生成，不要手工修改。新增或修改 ADR 后执行 node hack/adr-index.mjs -->

每篇 ADR 记一项决定。读一篇 ADR 时，看"之后引用它的 ADR"一列：后来的 ADR 可能修订了它。

新 ADR 在标题下第一行写状态：\`状态：提议\`、\`状态：已采纳\`、\`状态：部分取代（见 NNNN）\` 或 \`状态：已取代（见 NNNN）\`。
没有状态行的 ADR 按已采纳处理。编号取 docs/adr 中最大的编号加一。

| 编号 | 标题 | 状态 | 之后引用它的 ADR |
|---|---|---|---|
${rows.join('\n')}
`;

if (errors.length) {
  for (const e of errors) {
    console.error(e);
  }
  process.exit(1);
}
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    // 还没有生成
  }
  if (current !== out) {
    console.error('docs/adr/README.md 与 ADR 不一致：执行 node hack/adr-index.mjs');
    process.exit(1);
  }
  console.log(`一致：${adrs.length} 篇 ADR`);
} else {
  writeFileSync(OUT, out);
  console.log(`已生成 docs/adr/README.md：${adrs.length} 篇 ADR`);
}
