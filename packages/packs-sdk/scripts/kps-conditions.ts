// 生成 packs/kps-conditions（kube-prometheus-stack 告警规则的条件卡与 kubernetes-mixin 测试转来的夹具），
// 并给 packs/alerts-kps 的每个条目加上这条证据链与 primary_card（ADR 0109）。
// 用法：pnpm --filter @srenautix/packs-sdk run gen:kps-conditions [--check]
// builtin-packs 测试按同样的生成结果核对仓库内容（不比较格式）。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { isMap, isSeq, parseDocument, stringify, type YAMLSeq } from 'yaml';
import { generateKpsConditions, KPS_CONDITIONS } from '../src/pack/kps-conditions.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const check = process.argv.includes('--check');
const catalogPath = join(repo, 'packs/alerts-kps/alerts.yaml');
const outDir = join(repo, 'packs', KPS_CONDITIONS);
const HEADER = '# 由 packages/packs-sdk/scripts/kps-conditions.ts 生成，不要手工修改。\n';
const TEST_HEADER =
  '# 由 packages/packs-sdk/scripts/kps-conditions.ts 从 kubernetes-mixin 的 promtool 测试（Apache-2.0，提交见 upstream/kubernetes-mixin-tests.json）转换，不要手工修改。\n';

const g = await generateKpsConditions(repo);

// 目录条目：证据链加上 kps-conditions/<id>，primary_card 指向条件卡
const doc = parseDocument(readFileSync(catalogPath, 'utf8'));
for (const item of (doc.get('entries') as YAMLSeq).items) {
  if (!isMap(item)) {
    throw new Error('alerts-kps 的条目必须是映射');
  }
  const id = String(item.get('id'));
  if (g.skip.has(id)) {
    continue;
  }
  const chain = `${KPS_CONDITIONS}/${id}`;
  const chains = item.get('chains', true);
  if (!isSeq(chains)) {
    throw new Error(`条目 ${id} 没有 chains`);
  }
  if (!chains.items.some((c) => String((c as { value?: unknown }).value ?? c) === chain)) {
    chains.add(doc.createNode(chain));
  }
  item.set('primary_card', `${chain}/condition`);
}

// 按仓库的 prettier 配置格式化，与 pnpm run lint 的结果相同
const pretty = async (path: string, text: string) =>
  format(text, { ...(await resolveConfig(path)), parser: 'yaml', filepath: path });
const yamlFile = (path: string, header: string, value: unknown) =>
  pretty(path, header + stringify(value, { lineWidth: 0 }));
const files = new Map<string, string>();
for (const [name, value] of [
  ['pack.yaml', g.manifest],
  ['signals.yaml', { signals: g.pack.signals }],
  ['chains.yaml', { chains: g.pack.chains }],
] as const) {
  files.set(join(outDir, name), await yamlFile(join(outDir, name), HEADER, value));
}
files.set(catalogPath, await pretty(catalogPath, doc.toString({ lineWidth: 0 })));
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

if (check) {
  const diff = [...files].filter(([p, text]) => !existsSync(p) || readFileSync(p, 'utf8') !== text).map(([p]) => p);
  if (diff.length || stale.length) {
    process.stderr.write(`生成结果与仓库不一致：${[...diff, ...stale].join('、')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`一致：${g.pack.chains.length} 张条件卡、${g.tests.size} 个夹具文件\n`);
  }
} else {
  stale.forEach((p) => rmSync(p));
  mkdirSync(testsDir, { recursive: true });
  for (const [p, text] of files) {
    writeFileSync(p, text);
  }
  process.stdout.write(
    `已生成：${g.pack.chains.length} 张条件卡、${g.pack.signals.length} 个信号、${g.tests.size} 个夹具文件（${g.firing} 个条目有触发夹具）\n`,
  );
}
