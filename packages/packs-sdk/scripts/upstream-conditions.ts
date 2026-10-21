// 生成 packs/upstream-conditions（社区包上游告警规则的条件卡与上游 promtool 测试转来的夹具），
// 并给社区包告警目录中没有手写主卡的条目加上这条证据链与 primary_card（ADR 0109）。
// 用法：pnpm --filter @srenautix/packs-sdk run gen:upstream-conditions [--check]
// builtin-packs 测试按同样的生成结果核对仓库内容（不比较格式）。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { isMap, isSeq, parseDocument, stringify, type YAMLSeq } from 'yaml';
import { generateUpstreamConditions, UPSTREAM_CONDITIONS } from '../src/pack/upstream-conditions.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const check = process.argv.includes('--check');
const outDir = join(repo, 'packs', UPSTREAM_CONDITIONS);
const HEADER = '# 由 packages/packs-sdk/scripts/upstream-conditions.ts 生成，不要手工修改。\n';
const TEST_HEADER =
  '# 由 packages/packs-sdk/scripts/upstream-conditions.ts 从上游的 promtool 测试（来源与提交见 upstream/community-rules.json）转换，不要手工修改。\n';

const g = await generateUpstreamConditions(repo);

// 按仓库的 prettier 配置格式化，与 pnpm run lint 的结果相同
const pretty = async (path: string, text: string) =>
  format(text, { ...(await resolveConfig(path)), parser: 'yaml', filepath: path });
const yamlFile = (path: string, header: string, value: unknown) =>
  pretty(path, header + stringify(value, { lineWidth: 0 }));

const files = new Map<string, string>();
// 目录条目：证据链加上 upstream-conditions/<id>，primary_card 指向条件卡
for (const [pack, ids] of g.targets) {
  const catalogPath = join(repo, 'packs', pack, 'alerts.yaml');
  const doc = parseDocument(readFileSync(catalogPath, 'utf8'));
  for (const item of (doc.get('entries') as YAMLSeq).items) {
    if (!isMap(item)) {
      throw new Error(`${pack} 的告警目录条目必须是映射`);
    }
    const id = String(item.get('id'));
    if (!ids.includes(id)) {
      continue;
    }
    const chain = `${UPSTREAM_CONDITIONS}/${id}`;
    const chains = item.get('chains', true);
    if (!isSeq(chains)) {
      throw new Error(`条目 ${id} 没有 chains`);
    }
    if (!chains.items.some((c) => String((c as { value?: unknown }).value ?? c) === chain)) {
      chains.add(doc.createNode(chain));
    }
    // primary_card 放在 id 之后，与手写主卡的条目一致
    if (!item.has('primary_card')) {
      const at = item.items.findIndex((p) => String((p.key as { value?: unknown }).value ?? p.key) === 'id');
      item.items.splice(at + 1, 0, doc.createPair('primary_card', `${chain}/condition`));
    } else {
      item.set('primary_card', `${chain}/condition`);
    }
  }
  files.set(catalogPath, await pretty(catalogPath, doc.toString({ lineWidth: 0 })));
}
for (const [name, value] of [
  ['pack.yaml', g.manifest],
  ['signals.yaml', { signals: g.pack.signals }],
  ['chains.yaml', { chains: g.pack.chains }],
] as const) {
  files.set(join(outDir, name), await yamlFile(join(outDir, name), HEADER, value));
}
for (const [name, t] of g.tests) {
  const p = join(outDir, 'tests', name);
  files.set(p, await yamlFile(p, TEST_HEADER, t));
}
const testsDir = join(outDir, 'tests');
const stale = existsSync(testsDir)
  ? readdirSync(testsDir)
      .map((n) => join(testsDir, n))
      .filter((p) => !files.has(p))
  : [];

const gaps = g.missing.length ? `；上游没有规则的条目：${g.missing.join('、')}` : '';
if (check) {
  const diff = [...files].filter(([p, text]) => !existsSync(p) || readFileSync(p, 'utf8') !== text).map(([p]) => p);
  if (diff.length || stale.length) {
    process.stderr.write(`生成结果与仓库不一致：${[...diff, ...stale].join('、')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`一致：${g.pack.chains.length} 张条件卡、${g.tests.size} 个夹具文件${gaps}\n`);
  }
} else {
  stale.forEach((p) => rmSync(p));
  mkdirSync(testsDir, { recursive: true });
  for (const [p, text] of files) {
    writeFileSync(p, text);
  }
  process.stdout.write(
    `已生成：${g.pack.chains.length} 张条件卡、${g.pack.signals.length} 个信号、${g.tests.size} 个夹具文件（${g.firing} 个条目有触发夹具）${gaps}\n`,
  );
}
