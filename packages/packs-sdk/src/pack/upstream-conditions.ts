// upstream-conditions 包（ADR 0109）：社区包（argocd、cert-manager、ingress-nginx、kafka、longhorn、mysql、nacos、
// postgres、redis）告警目录中没有手写主卡的条目，按上游告警规则生成条件卡，作为条目的主卡。
// 上游规则的来源固定提交与 sha256（upstream/community-rules.json）；生成脚本（scripts/upstream-conditions.ts）
// 与 builtin-packs 测试共用 generateUpstreamConditions，后者核对仓库与生成结果一致。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertCatalogEntry, PackManifest, PackTestFile } from '@srenautix/contract';
import {
  backendsDir,
  ensureBackend,
  fetchVerified,
  loadPromqlEngine,
  placeAtomically,
} from '@srenautix/integration-sdk';
import { parse, parseAllDocuments } from 'yaml';
import { generateConditionPack, type ConditionPack, type ConditionRule } from './conditions.js';
import { convertPromtoolTests } from './promtool-fixtures.js';

export const UPSTREAM_CONDITIONS = 'upstream-conditions';

/** 本包管理的主卡前缀：重新生成时，主卡指向这里的条目仍算"没有手写主卡" */
const OWN = `${UPSTREAM_CONDITIONS}/`;

interface Replace {
  from: string;
  to: string;
  /** 按条目的实体类型取值（例如 CNPG 集群名：Cluster 条目用 $name，Pod 条目用任意集群名的正则） */
  by_kind?: Record<string, string>;
}

export interface UpstreamSource {
  id: string;
  /** 告警目录所在的内置包 */
  pack: string;
  title: string;
  license: string;
  format: 'rules' | 'commented' | 'markdown' | 'helm';
  url: string;
  sha256: string;
  /** commented：从内容等于它的那一行之后开始取注释；不填时从文件开头 */
  after?: string;
  /** helm：release 名、命名空间与 --set 的值 */
  release?: string;
  namespace?: string;
  set?: Record<string, string>;
  replace?: Replace[];
  /** 同一提交的 promtool 规则单元测试 */
  tests?: Array<{ url: string; sha256: string }>;
}

interface RawRule {
  group: string;
  alert: string;
  expr: string;
  for: string;
  labels: Record<string, string>;
}

/** 规则文件、PrometheusRule 或规则列表 → 告警规则 */
function rulesOf(docs: unknown[], fallbackGroup: string): RawRule[] {
  const out: RawRule[] = [];
  const push = (group: string, rules: Array<Record<string, unknown>>) => {
    for (const r of rules) {
      if (typeof r['alert'] !== 'string') {
        continue;
      }
      out.push({
        group,
        alert: r['alert'],
        expr: String(r['expr']),
        for: typeof r['for'] === 'string' ? r['for'] : '0m',
        labels: Object.fromEntries(
          Object.entries((r['labels'] as Record<string, unknown> | undefined) ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      });
    }
  };
  for (const d of docs) {
    if (Array.isArray(d)) {
      push(fallbackGroup, d as Array<Record<string, unknown>>);
      continue;
    }
    const o = d as { groups?: unknown; spec?: { groups?: unknown } } | null;
    const groups = (o?.spec?.groups ?? o?.groups ?? []) as Array<{
      name: string;
      rules?: Array<Record<string, unknown>>;
    }>;
    for (const g of groups) {
      push(g.name, g.rules ?? []);
    }
  }
  return out;
}

function yamlDocs(text: string, where: string): unknown[] {
  return parseAllDocuments(text).map((d) => {
    if (d.errors.length) {
      throw new Error(`${where} 不是合法的 YAML：${d.errors[0]!.message}`);
    }
    return d.toJS() as unknown;
  });
}

/** 注释掉的规则示例：after 之后（或文件开头）与第一行同一列的连续注释行，去掉 "# " 后解析 */
export function commentedRules(text: string, after: string | undefined, where: string): RawRule[] {
  const lines = text.split('\n');
  let start = 0;
  if (after !== undefined) {
    const hits = lines.flatMap((l, i) => (l.trim() === after ? [i] : []));
    if (hits.length !== 1) {
      throw new Error(`${where} 中内容为 "${after}" 的行应恰好一行，实际 ${hits.length} 行`);
    }
    start = hits[0]! + 1;
  }
  const column = lines[start]?.indexOf('#') ?? -1;
  if (column < 0 || lines[start]!.slice(0, column).trim() !== '') {
    throw new Error(`${where} 第 ${start + 1} 行不是注释`);
  }
  const body: string[] = [];
  for (const l of lines.slice(start)) {
    if (l.indexOf('#') !== column || l.slice(0, column).trim() !== '') {
      break;
    }
    body.push(l.slice(column + 1).replace(/^ /, ''));
  }
  return rulesOf(yamlDocs(body.join('\n'), where), 'commented');
}

/** 文档中的 yaml 代码块 */
export function markdownRules(text: string, where: string): RawRule[] {
  const blocks = [...text.matchAll(/^\s*```ya?ml\s*\n([\s\S]*?)^\s*```/gm)].map((m) => m[1]!);
  return blocks.flatMap((b) => rulesOf(yamlDocs(b, where), 'markdown'));
}

function cacheDir(s: { id: string; sha256: string }): string {
  return join(backendsDir(), 'upstream', `${s.id}-${s.sha256.slice(0, 12)}`);
}

/** 下载（校验 sha256）到后端缓存目录，带完整标记原子落位；返回本地路径 */
async function fetchPinned(dir: string, name: string, url: string, sha256: string): Promise<string> {
  await placeAtomically(dir, async (staging) => {
    writeFileSync(join(staging, name), await fetchVerified(url, sha256));
  });
  return join(dir, name);
}

async function loadSource(s: UpstreamSource): Promise<RawRule[]> {
  const where = `${s.id}（${s.url}）`;
  if (s.format === 'helm') {
    const tgz = await fetchPinned(cacheDir(s), 'chart.tgz', s.url, s.sha256);
    const { helm } = await ensureBackend('helm');
    const sets = Object.entries(s.set ?? {}).flatMap(([k, v]) => ['--set', `${k}=${v}`]);
    const out = execFileSync(helm!, ['template', s.release!, tgz, '--namespace', s.namespace!, ...sets], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return rulesOf(
      yamlDocs(out, where).filter((d) => (d as { kind?: string } | null)?.kind === 'PrometheusRule'),
      s.id,
    );
  }
  const text = readFileSync(await fetchPinned(cacheDir(s), 'source', s.url, s.sha256), 'utf8');
  switch (s.format) {
    case 'rules':
      return rulesOf(yamlDocs(text, where), s.id);
    case 'commented':
      return commentedRules(text, s.after, where);
    case 'markdown':
      return markdownRules(text, where);
  }
}

/** 按条目的实体类型替换渲染或模板留下的具体名字；替换后仍有模板语法或占位名时报错 */
function substitute(s: UpstreamSource, r: RawRule, kind: string): RawRule {
  let expr = r.expr;
  for (const x of s.replace ?? []) {
    const to = x.by_kind?.[kind] ?? x.to;
    expr = expr.split(x.from).join(to);
  }
  const left = (s.replace ?? []).find((x) => expr.includes(x.from));
  if (expr.includes('{{') || left) {
    throw new Error(`${s.id} 的 ${r.alert} 替换后仍有模板语法或占位名：${expr}`);
  }
  // 静态标签中含占位名或模板的（渲染出的命名空间、集群名）不是规则本身的属性，丢弃
  const labels = Object.fromEntries(
    Object.entries(r.labels).filter(([, v]) => !v.includes('{{') && !(s.replace ?? []).some((x) => v.includes(x.from))),
  );
  return { ...r, expr, labels };
}

export function upstreamConditionsManifest(sources: readonly UpstreamSource[]): PackManifest {
  return {
    api_version: 'srenautix.io/pack/v1',
    name: UPSTREAM_CONDITIONS,
    version: '1.0.0',
    description: `社区包告警目录中没有手写主卡的条目的条件卡：查询与上游告警规则（${[...new Set(sources.map((s) => s.pack))].join('、')} 共 ${sources.length} 个来源，固定提交与 sha256）相同，判定与规则的 for 相同，作为条目的主卡`,
    // 卡片由规则生成；只有上游带 promtool 测试的规则有夹具，所以不是 stable
    maturity: 'beta',
    min_srenautix_version: '0.1.0',
    requires: ['metrics.query', 'metrics.query_range'],
  };
}

export interface UpstreamConditions {
  manifest: PackManifest;
  pack: ConditionPack;
  /** 生成条件卡的条目：包名 → 条目 id */
  targets: Map<string, string[]>;
  /** 没有手写主卡、上游也没有同名规则的条目（包名/条目 id） */
  missing: string[];
  /** 条件卡用到的规则（替换前，pack test --alert-rules 用；替换过的来源没有夹具） */
  rules: RawRule[];
  /** 夹具文件名 → 内容 */
  tests: Map<string, PackTestFile>;
  /** 有"触发"夹具的条目数 */
  firing: number;
}

/** 条目没有手写主卡（没有主卡，或主卡由本包生成），且在接入时不丢弃（有证据链） */
export function needsCondition(e: AlertCatalogEntry): boolean {
  return Boolean(e.chains?.length) && (!e.primary_card || e.primary_card.startsWith(OWN));
}

/** 下载固定版本的上游规则与测试，生成条件卡与夹具 */
export async function generateUpstreamConditions(repo: string): Promise<UpstreamConditions> {
  const pin = JSON.parse(readFileSync(join(repo, 'packages/packs-sdk/upstream/community-rules.json'), 'utf8')) as {
    sources: UpstreamSource[];
  };
  const engine = await loadPromqlEngine();
  const packs = [...new Set(pin.sources.map((s) => s.pack))];
  const entriesOf = new Map(
    packs.map((p) => [
      p,
      (parse(readFileSync(join(repo, 'packs', p, 'alerts.yaml'), 'utf8')) as { entries: AlertCatalogEntry[] }).entries,
    ]),
  );
  const rules: ConditionRule[] = [];
  const raw: RawRule[] = [];
  const targets = new Map<string, string[]>();
  const missing: string[] = [];
  const all: AlertCatalogEntry[] = [];
  const converted = new Map<RawRule, Map<string, ConditionRule>>();
  for (const p of packs) {
    const sources = pin.sources.filter((s) => s.pack === p);
    const loaded = await Promise.all(sources.map(async (s) => ({ s, rules: await loadSource(s) })));
    for (const e of entriesOf.get(p)!.filter(needsCondition)) {
      const hits = loaded.flatMap(({ s, rules: rs }) =>
        rs.filter((r) => r.alert === e.alertname).map((r) => ({ s, r })),
      );
      if (!hits.length) {
        missing.push(`${p}/${e.id}`);
        continue;
      }
      // 同名规则在多个来源中出现时只取第一个来源（来源的顺序即优先级）；多个条目（match_labels 拆出的变体）共用规则
      const first = hits[0]!.s;
      for (const { s, r } of hits.filter((h) => h.s === first)) {
        const key = `${s.id}\u0000${e.entity.kind}`;
        const seen = converted.get(r) ?? new Map<string, ConditionRule>();
        converted.set(r, seen);
        if (!seen.has(key)) {
          const x = substitute(s, r, e.entity.kind);
          // 做过替换的来源在说明里注明，卡片的查询与上游只差实体变量；规则组名里的占位名写成 *
          const named = (s.replace ?? []).reduce((n, x) => n.split(x.from).join('*'), r.group);
          const group = s.replace?.length ? `${named}, names replaced by entity variables` : r.group;
          const c = { alert: x.alert, expr: x.expr, for: x.for, labels: x.labels, source: `${s.title} (${group})` };
          seen.set(key, c);
          if (seen.size > 1) {
            // 条件卡按告警名找规则，同一条规则不能按不同实体类型替换出两份
            throw new Error(`${r.alert} 被不同实体类型的条目引用，无法按实体类型替换`);
          }
          rules.push(c);
          if (!raw.includes(r)) {
            raw.push(r);
          }
        }
      }
      targets.set(p, [...(targets.get(p) ?? []), e.id]);
      all.push(e);
    }
  }
  const pack = generateConditionPack(engine, rules, all);
  const tests = new Map<string, PackTestFile>();
  const firing = new Set<string>();
  for (const s of pin.sources) {
    for (const [i, t] of (s.tests ?? []).entries()) {
      const file = await fetchPinned(
        cacheDir({ id: `${s.id}-tests-${i}`, sha256: t.sha256 }),
        'tests.yaml',
        t.url,
        t.sha256,
      );
      const own = all.filter((e) => entriesOf.get(s.pack)!.includes(e));
      const c = convertPromtoolTests(engine, `${s.id}-tests.yaml`, readFileSync(file, 'utf8'), own, pack.ruleOf);
      for (const [name, f] of c.files) {
        tests.set(name, f);
      }
      c.firing.forEach((id) => firing.add(id));
    }
  }
  return {
    manifest: upstreamConditionsManifest(pin.sources),
    pack,
    targets,
    missing,
    rules: raw,
    tests,
    firing: firing.size,
  };
}
