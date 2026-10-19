import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  AlertCatalogEntry,
  ComponentType,
  HubComponents,
  LabelProfile,
  OperatorConvention,
  PackLock,
  RcaParams,
} from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import { AlertCatalog, resolveRcaParams, type ResolvedRcaParams } from '@srenautix/core';
import {
  detectLabelProfile,
  DatasourceError,
  loadPromqlEngine,
  PrometheusApiAdapter,
  toIso,
  type PromqlEngine,
} from '@srenautix/integration-sdk';
import {
  compileCard,
  compilePackSet,
  createBaseEnvironment,
  LiveDataSource,
  loadActionCatalog,
  loadPackDir,
  packDigest,
  PackLintError,
  PackLockMismatch,
  resolveSignal,
  type Capability,
  type CardDefinition,
  type CardEntry,
  type EvidenceDataSource,
  type LoadedPack,
  type PackSet,
  type SignalResolution,
} from '@srenautix/packs-sdk';
import { parse as parseYaml, parseDocument } from 'yaml';
import { logger } from '../log.js';

export interface PackRuntimeOptions {
  /** 每个目录下的子目录各是一个领域包。 */
  dirs: string[];
  /** 只加载这些包；不填时加载除 `_` 开头（示例包）以外的全部包。 */
  only: string[] | null;
  /** 已提交的 pack.lock；给出时加载结果必须与之一致，不一致时不加载任何包。 */
  lockFile: string | null;
  /** 动作目录（contract/gateway/v1/action-catalog.yaml）。 */
  catalogPath: string;
  /** 数据源具备的能力；requires 中的能力缺失时整个包禁用。 */
  capabilities: ReadonlySet<Capability>;
}

export type PackStatus = HubComponents['schemas']['PackStatus'];

export interface PackFailure {
  name: string;
  source: string;
  /** pack.yaml 本身不能解析时为 null */
  version: string | null;
  maturity: 'stable' | 'beta' | 'draft' | null;
  /** 目录中全部文件的内容摘要（与 pack.lock 的算法相同） */
  digest: string;
  error: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

/** 没有加载的包也在控制台列出：版本与成熟度尽量从 pack.yaml 读出，摘要按目录内容计算。 */
function failureOf(dir: string, name: string, source: string, error: string): PackFailure {
  const files = walk(dir).map((abs) => ({
    path: relative(dir, abs).split(sep).join('/'),
    sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
  }));
  let manifest: { version?: unknown; maturity?: unknown } = {};
  const mp = join(dir, 'pack.yaml');
  if (existsSync(mp)) {
    // pack.yaml 可能正是校验不通过的文件：有语法错误时不读取
    const doc = parseDocument(readFileSync(mp, 'utf8'));
    const js = doc.errors.length ? null : (doc.toJS() as unknown);
    manifest = js && typeof js === 'object' ? (js as typeof manifest) : {};
  }
  const maturity = manifest.maturity;
  return {
    name,
    source,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    maturity: maturity === 'stable' || maturity === 'beta' || maturity === 'draft' ? maturity : null,
    digest: packDigest(files),
    error,
  };
}

/** 阶段 B 输入中的知识条目（与 contract/schemas/eval-snapshot.schema.json 的 Knowledge 同形）。 */
export interface KnowledgeEntry {
  id: string;
  components: string[];
  text: string;
  learned_from: string[];
  learned_at: string | null;
  source: 'human' | 'model';
}

/** 区分性检查可用的查询模板（signals.yaml 的 templates），按模板附带的卡判定。 */
export interface CompiledTemplate {
  /** 全局 id <pack>/<template id> */
  id: string;
  pack: string;
  description: string;
  /** 参数的 JSON Schema（可移植子集） */
  args: Record<string, unknown>;
  /** set.cards 中的卡片键 <pack>/templates/<template id> */
  card: string;
}

const REF_KIND: Record<string, string> = { range: 'metrics', instant: 'metrics', logs: 'logs', traces: 'traces' };

/**
 * 编译查询模板：模板引用的信号与卡的每个引用都必须存在且类型相符，卡的 CEL 按阶段 A 的同一套环境编译。
 * 编译后的卡加入 set.cards（键 <pack>/templates/<id>），由 runCard 执行。没有附带卡的模板无法判定，不提供给阶段 B。
 */
function compileTemplates(set: PackSet): CompiledTemplate[] {
  const base = createBaseEnvironment();
  const out: CompiledTemplate[] = [];
  const signalKey = (pack: string, ref: string, where: string) => {
    const key = ref.includes('/') ? ref : `${pack}/${ref}`;
    if (!set.signals.has(key)) {
      throw new PackLintError(where, `引用的信号 ${ref} 不存在或所在的包被禁用`);
    }
    return key;
  };
  for (const p of set.packs) {
    for (const t of p.content.signals.templates ?? []) {
      const where = `${p.dir}/signals.yaml：templates ${t.id}`;
      signalKey(p.name, t.signal, where);
      if (!t.card) {
        logger.warn('查询模板没有附带卡，无法判定，不提供给阶段 B', { pack: p.name, template: t.id });
        continue;
      }
      const def = t.card as CardDefinition;
      const signals: Record<string, string> = {};
      for (const r of def.refs) {
        const key = signalKey(p.name, r.signal, where);
        const kind = set.signals.get(key)!.signal.kind;
        if (REF_KIND[r.mode] !== kind) {
          throw new PackLintError(where, `引用 ${r.name} 的模式 ${r.mode} 与信号 ${key} 的类型 ${kind} 不符`);
        }
        signals[r.name] = key;
      }
      const key = `${p.name}/templates/${t.id}`;
      const entry: CardEntry = {
        key,
        pack: p.name,
        chain: null,
        def,
        compiled: compileCard(base, def, { where }),
        signals,
      };
      set.cards.set(key, entry);
      out.push({ id: `${p.name}/${t.id}`, pack: p.name, description: t.description, args: t.args, card: key });
    }
  }
  return out;
}

/**
 * 领域包运行时（DESIGN §6.3）：加载并编译全部包，提供告警目录、组件类型、Operator 约定边、根因排序参数，
 * 阶段 A 执行证据卡与规则提议所需的包集合，以及阶段 B 的查询模板与知识条目。
 *
 * 单个包校验不通过时只禁用这个包并发布 PackLoadFailed 条件，其余包照常加载；pack.lock 不一致时不加载任何包。
 */
export class PackRuntime {
  private constructor(
    readonly set: PackSet,
    /** 参与编译的包（含因能力缺失或依赖被禁用的包）。 */
    private readonly inputs: LoadedPack[],
    readonly failures: PackFailure[],
    private readonly capabilities: ReadonlySet<Capability>,
    readonly templates: CompiledTemplate[],
  ) {}

  static async load(o: PackRuntimeOptions): Promise<PackRuntime> {
    const catalog = loadActionCatalog(o.catalogPath);
    const failures: PackFailure[] = [];
    let active: LoadedPack[] = [];
    for (const root of o.dirs) {
      const names = readdirSync(root)
        .filter((n) => statSync(join(root, n)).isDirectory() && !n.startsWith('.'))
        .filter((n) => (o.only ? o.only.includes(n) : !n.startsWith('_')))
        .sort();
      for (const n of names) {
        try {
          active.push(loadPackDir(join(root, n), 'builtin'));
        } catch (e) {
          if (!(e instanceof PackLintError)) {
            throw e;
          }
          logger.error('领域包校验不通过，已禁用', { pack: n, error: e.message });
          failures.push(failureOf(join(root, n), n, 'builtin', e.message));
        }
      }
    }
    for (const n of o.only ?? []) {
      if (!active.some((p) => p.name === n) && !failures.some((f) => f.name === n)) {
        throw new Error(`packs.only 中的包 ${n} 不在 packs.dirs 中`);
      }
    }
    const expectedLock =
      o.lockFile && existsSync(o.lockFile)
        ? assertValid<PackLock>('schemas/pack.schema.json#/$defs/PackLock', parseYaml(readFileSync(o.lockFile, 'utf8')))
        : undefined;
    for (;;) {
      try {
        const set = await compilePackSet(active, {
          catalog,
          capabilities: o.capabilities,
          ...(expectedLock ? { expectedLock } : {}),
        });
        const templates = compileTemplates(set);
        return new PackRuntime(set, active, failures, o.capabilities, templates);
      } catch (e) {
        if (e instanceof PackLockMismatch) {
          logger.error('pack.lock 与加载的领域包不一致，不加载任何包', { error: e.message });
          const set = await compilePackSet([], { catalog });
          return new PackRuntime(
            set,
            [],
            [...failures, ...active.map((p) => failureOf(p.dir, p.name, p.source, e.message))],
            o.capabilities,
            [],
          );
        }
        if (!(e instanceof PackLintError)) {
          throw e;
        }
        // 编译错误的位置以包目录开头；禁用这个包后重新编译（依赖它的包随之禁用）
        const culprit = active.find(
          (p) => e.where === p.dir || e.where.startsWith(`${p.dir}/`) || e.where.startsWith(`${p.dir}：`),
        );
        if (!culprit) {
          throw e;
        }
        logger.error('领域包校验不通过，已禁用', { pack: culprit.name, error: e.message });
        failures.push(failureOf(culprit.dir, culprit.name, culprit.source, e.message));
        active = active.filter((p) => p !== culprit);
      }
    }
  }

  /**
   * 与这些组件类型相关的知识条目（knowledge/*.yaml）：components 为空的通用条目，或 components 与之有交集的条目。
   * 文本取 language 对应的语言，没有时取另一种语言。id 为 <pack>/<entry id>。
   */
  knowledge(componentTypes: ReadonlySet<string>, language: 'zh-CN' | 'en'): KnowledgeEntry[] {
    const out: KnowledgeEntry[] = [];
    for (const p of this.set.packs) {
      for (const file of Object.values(p.content.knowledge)) {
        for (const e of file.entries) {
          const comps = e.components ?? [];
          if (comps.length && !comps.some((c) => componentTypes.has(c))) {
            continue;
          }
          const other = language === 'zh-CN' ? 'en' : 'zh-CN';
          out.push({
            id: `${p.name}/${e.id}`,
            components: comps,
            text: e.text[language] ?? e.text[other] ?? '',
            learned_from: e.learned_from,
            learned_at: e.learned_at ?? null,
            source: e.source,
          });
        }
      }
    }
    return out;
  }

  /** 告警目录（按包的加载顺序，同样具体时先声明的包优先）。 */
  alertCatalog(): AlertCatalog {
    return new AlertCatalog(
      this.set.packs.map((p) => ({ pack: p.name, entries: p.content.alerts.entries as AlertCatalogEntry[] })),
    );
  }

  /** 告警目录条目 `<pack>/<entry id>` 声明的证据链（全局键 `<pack>/<chain id>`）。 */
  alertChains(catalogEntry: string): string[] {
    const i = catalogEntry.indexOf('/');
    const pack = this.set.packs.find((p) => p.name === catalogEntry.slice(0, i));
    const entry = pack?.content.alerts.entries.find((e) => e.id === catalogEntry.slice(i + 1));
    return (entry?.chains ?? []).map((c) => (c.includes('/') ? c : `${pack!.name}/${c}`));
  }

  componentTypes(): ComponentType[] {
    return this.set.packs.flatMap((p) => p.content.components.component_types);
  }

  conventions(): OperatorConvention[] {
    return this.set.packs.flatMap((p) => p.content.components.conventions ?? []);
  }

  /** 组件类型声明的证据链（全局键）。 */
  typeChains(componentType: string): string[] {
    for (const p of this.set.packs) {
      const t = p.content.components.component_types.find((x) => x.id === componentType);
      if (t) {
        return (t.chains ?? []).map((c) => (c.includes('/') ? c : `${p.name}/${c}`));
      }
    }
    return [];
  }

  /** 控制台"领域包"页（contract/openapi.yaml 的 PackStatus）。 */
  statuses(): PackStatus[] {
    const kind = (s: string): PackStatus['source'] =>
      s.startsWith('git+') ? 'git' : s.startsWith('oci://') ? 'oci' : 'builtin';
    const disabled = new Map(this.set.disabled.map((d) => [d.name, d.reason]));
    const loaded = this.set.lock.packs
      .filter((l) => !this.failures.some((f) => f.name === l.name))
      .map((l): PackStatus => {
        const m = this.inputs.find((x) => x.name === l.name)!.content.manifest;
        const reason = disabled.get(l.name) ?? null;
        return {
          name: l.name,
          version: l.version,
          source: kind(l.source),
          ref: l.source,
          digest: l.digest,
          maturity: m.maturity,
          layer: 'builtin',
          loaded: reason === null,
          load_error: reason,
          // requires 中缺失的能力使整个包禁用；optional 中缺失的能力使相应的卡显示"能力缺失"
          disabled_capabilities: [...m.requires, ...(m.optional ?? [])].filter(
            (c) => !this.capabilities.has(c as Capability),
          ),
          ci: null,
          user_layer_lines: null,
        };
      });
    const failed = this.failures.map((f): PackStatus => ({
      name: f.name,
      version: f.version ?? '',
      source: kind(f.source),
      ref: f.source,
      digest: f.digest,
      maturity: f.maturity ?? 'draft',
      layer: 'builtin',
      loaded: false,
      load_error: f.error,
      disabled_capabilities: [],
      ci: null,
      user_layer_lines: null,
    }));
    return [...loaded, ...failed].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** 各包的 rca-params.yaml 按加载顺序叠加在默认值之上。 */
  rcaParams(): ResolvedRcaParams {
    return resolveRcaParams(this.set.packs.map((p) => p.content.rca_params).filter((x): x is RcaParams => x !== null));
  }
}

export interface PrometheusSource {
  id: string;
  url: string;
  dialect: 'promql' | 'metricsql';
  bearerTokenFile: string | null;
  timeoutMs: number;
}

/** 标签档案探测失败时使用的规范标签名；查询照常发出，失败原因记在卡片的查询记录里。 */
const CANONICAL_PROFILE: LabelProfile = {
  namespace: 'namespace',
  pod: 'pod',
  container: 'container',
  node: 'node',
  cluster: null,
  scrape_interval_seconds: 30,
  tenant: null,
};

const PROFILE_RETRY_MS = 60_000;
const PROFILE_REFRESH_MS = 3600_000;
const RESOLUTION_TTL_MS = 10 * 60_000;

/**
 * 证据卡的指标数据源：Prometheus HTTP API 适配器、自动探测的标签档案与信号备选的选择结果。
 * 标签档案每小时重新探测，探测失败时 60 秒后重试；信号备选的选择缓存 10 分钟，探测失败的结果不缓存。
 */
export class EvidenceSource {
  private readonly adapter: PrometheusApiAdapter;
  private live: LiveDataSource | null = null;
  private profileAt = 0;
  private profileError: string | null = null;
  private readonly resolutions = new Map<string, { at: number; r: SignalResolution }>();

  private constructor(
    private readonly s: PrometheusSource,
    readonly engine: PromqlEngine,
  ) {
    this.adapter = new PrometheusApiAdapter({
      id: s.id,
      url: s.url,
      // VictoriaMetrics 同时接受 PromQL
      dialects: s.dialect === 'metricsql' ? ['promql', 'metricsql'] : ['promql'],
      bearer_token_file: s.bearerTokenFile,
    });
  }

  static async create(s: PrometheusSource): Promise<EvidenceSource> {
    return new EvidenceSource(s, await loadPromqlEngine());
  }

  /** 最近一次标签档案探测的错误；探测成功时为 null。 */
  get error(): string | null {
    return this.profileError;
  }

  async dataSource(now: number): Promise<EvidenceDataSource> {
    const due = this.profileError ? PROFILE_RETRY_MS : PROFILE_REFRESH_MS;
    if (this.live && now - this.profileAt < due) {
      return this.live;
    }
    let profile = CANONICAL_PROFILE;
    try {
      profile = await detectLabelProfile(this.adapter, toIso(now), { from: toIso(now - 2 * 3600_000), to: toIso(now) });
      this.profileError = null;
    } catch (e) {
      if (!(e instanceof DatasourceError)) {
        throw e;
      }
      this.profileError = e.message;
      logger.warn('证据数据源的标签档案探测失败，按规范标签名查询', { datasource: this.s.id, error: e.message });
    }
    this.profileAt = now;
    this.live = new LiveDataSource({ metrics: { adapter: this.adapter, profile } });
    return this.live;
  }

  /** 信号键 → 选中的备选。 */
  async resolve(set: PackSet, keys: Iterable<string>, ds: EvidenceDataSource, now: number) {
    const out = new Map<string, SignalResolution>();
    const clock = { from: toIso(now - 2 * 3600_000), to: toIso(now) };
    for (const k of keys) {
      const hit = this.resolutions.get(k);
      if (hit && now - hit.at < RESOLUTION_TTL_MS) {
        out.set(k, hit.r);
        continue;
      }
      const sig = set.signals.get(k);
      if (!sig) {
        continue;
      }
      const r = await resolveSignal(k, sig.signal, ds, this.engine, toIso(now), clock);
      if (!r.rejected.some((x) => x.reason.startsWith('探测失败'))) {
        this.resolutions.set(k, { at: now, r });
      }
      out.set(k, r);
    }
    return out;
  }
}
