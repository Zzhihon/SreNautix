// 告警角色分类（DESIGN §3.2）：标签契约 → 告警目录 → 规则表达式 → 默认 symptom。
// forecast 一律按表达式判断：目录条目或规则表达式含 predict_linear 才是 forecast。
// 告警类别（ADR 0183）：srenautix_category 标签 → 告警目录条目 → 内置类别表（server 合成的告警）→ 部署方的类别规则
// （第一条命中）→ unclassified。
import type {
  AlertCatalogEntry,
  AlertCategory,
  AlertClassification,
  AlertRole,
  IncidentCategory,
  Labels,
} from '@srenautix/contract';

export const ALERT_ROLES: readonly AlertRole[] = ['cause', 'change', 'symptom', 'forecast', 'meta'];

/** 与契约 common.schema.json 的 AlertCategory 相同（packages/core 的测试核对） */
export const ALERT_CATEGORIES = [
  'availability',
  'performance',
  'provider',
  'platform',
  'observability',
] as const satisfies readonly AlertCategory[];

export const UNCLASSIFIED = 'unclassified' satisfies IncidentCategory;

/** 告警规则用这个标签覆盖告警目录声明的类别 */
export const CATEGORY_LABEL = 'srenautix_category';

export function isAlertCategory(v: string): v is AlertCategory {
  return (ALERT_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 告警的标签匹配器（ADR 0166）：labels 的每个标签都取列出的值之一，并且 exclude_labels 中任何一个标签都不取列出的值。
 * labels 为空的匹配器不匹配任何告警
 */
export interface LabelMatcher {
  labels: Readonly<Record<string, readonly string[]>>;
  exclude_labels: Readonly<Record<string, readonly string[]>>;
}

export function matchesLabels(labels: Readonly<Record<string, string | undefined>>, m: LabelMatcher): boolean {
  const include = Object.entries(m.labels);
  return (
    include.length > 0 &&
    include.every(([k, vs]) => {
      const v = labels[k];
      return v !== undefined && vs.includes(v);
    }) &&
    !Object.entries(m.exclude_labels).some(([k, vs]) => {
      const v = labels[k];
      return v !== undefined && vs.includes(v);
    })
  );
}

/** 部署方的类别规则（server 配置 ingest.category_rules 的一项） */
export interface CategoryRule extends LabelMatcher {
  category: AlertCategory;
}

export interface AlertCatalogOptions {
  /** 内置类别表：server 自己合成的告警（集群状态检测器）的告警名 → 类别，告警目录没有命中条目或条目没有声明类别时采用 */
  builtinCategories?: Readonly<Record<string, AlertCategory>>;
  /** 有序的类别规则，告警目录与内置类别表都没有给出类别时取第一条命中的 */
  categoryRules?: readonly CategoryRule[];
  /** srenautix_category 标签的取值不在枚举里时调用（标签被忽略） */
  onInvalidCategoryLabel?: (alertname: string, value: string) => void;
}

/** 告警目录里决定类别的部分（AlertCatalog.categoryInputs） */
export interface CategoryInputs {
  entries: Array<{ alertname: string; match_labels: Labels; category: AlertCategory | null }>;
  builtin: Array<{ alertname: string; category: AlertCategory }>;
  rules: CategoryRule[];
}

export interface CategoryResult {
  category: IncidentCategory;
  source: NonNullable<AlertClassification['category_source']>;
}

export interface ExpressionClass {
  role: AlertRole;
  confidence: number;
  /** 命中的特征，供 doctor 列出待确认条目 */
  feature: string;
}

interface Feature {
  role: AlertRole;
  confidence: number;
  name: string;
  test: RegExp;
}

// 按顺序匹配，先命中先用。forecast 优先：predict_linear 的规则描述的是将来
const FEATURES: readonly Feature[] = [
  { role: 'forecast', confidence: 0.95, name: 'predict_linear', test: /\bpredict_linear\s*\(/ },
  { role: 'change', confidence: 0.85, name: 'changes()', test: /\bchanges\s*\(/ },
  { role: 'change', confidence: 0.85, name: 'resets()', test: /\bresets\s*\(/ },
  { role: 'change', confidence: 0.8, name: 'generation', test: /_generation\b|\bgeneration\b/ },
  { role: 'meta', confidence: 0.7, name: 'absent()', test: /\babsent(_over_time)?\s*\(/ },
  { role: 'cause', confidence: 0.8, name: 'restarts', test: /restarts?_total|_restarts\b|\brestart/ },
  {
    role: 'cause',
    confidence: 0.8,
    name: 'terminated/waiting reason',
    test: /OOMKilled|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|last_terminated_reason|status_waiting_reason/,
  },
  { role: 'cause', confidence: 0.75, name: 'up==0', test: /\bup\b[^=!<>]*(==\s*0\b)|\bup\s*\{[^}]*\}\s*==\s*0\b/ },
  {
    role: 'symptom',
    confidence: 0.7,
    name: 'latency',
    test: /histogram_quantile\s*\(|_bucket\b|latency|duration_seconds/,
  },
  {
    role: 'symptom',
    confidence: 0.7,
    name: 'error ratio',
    test: /error|fail|code\s*=~?\s*"5|status\s*=~?\s*"5|5\.\.|_5xx/i,
  },
];

/** 按规则表达式分类；没有任何特征时返回 null */
export function classifyExpression(expr: string): ExpressionClass | null {
  for (const f of FEATURES) {
    if (f.test.test(expr)) {
      return { role: f.role, confidence: f.confidence, feature: f.name };
    }
  }
  return null;
}

export function isForecastExpression(expr: string): boolean {
  return /\bpredict_linear\s*\(/.test(expr);
}

/** 目录中同名告警的变体，按 match_labels 的条件数从多到少排列 */
export class AlertCatalog {
  private readonly byName = new Map<string, Array<{ pack: string; entry: AlertCatalogEntry }>>();
  private readonly builtinCategories: ReadonlyMap<string, AlertCategory>;
  private readonly categoryRules: readonly CategoryRule[];
  private readonly onInvalidCategoryLabel: (alertname: string, value: string) => void;

  constructor(
    packs: ReadonlyArray<{ pack: string; entries: readonly AlertCatalogEntry[] }>,
    options: AlertCatalogOptions = {},
  ) {
    this.builtinCategories = new Map(Object.entries(options.builtinCategories ?? {}));
    this.categoryRules = options.categoryRules ?? [];
    this.onInvalidCategoryLabel = options.onInvalidCategoryLabel ?? (() => undefined);
    for (const { pack, entries } of packs) {
      for (const entry of entries) {
        const list = this.byName.get(entry.alertname) ?? [];
        list.push({ pack, entry });
        this.byName.set(entry.alertname, list);
      }
    }
    for (const list of this.byName.values()) {
      list.sort((a, b) => specificity(b.entry) - specificity(a.entry));
    }
  }

  /** 标签最具体的命中条目；同样具体时取先声明的包 */
  lookup(labels: Labels): { pack: string; entry: AlertCatalogEntry } | undefined {
    const name = labels.alertname;
    if (name === undefined) {
      return undefined;
    }
    return this.byName
      .get(name)
      ?.find(({ entry }) => Object.entries(entry.match_labels ?? {}).every(([k, v]) => labels[k] === v));
  }

  /** 同名告警的全部条目，按 lookup 的查找顺序 */
  entries(alertname: string): AlertCatalogEntry[] {
    return (this.byName.get(alertname) ?? []).map((x) => x.entry);
  }

  has(alertname: string): boolean {
    return this.byName.has(alertname);
  }

  alertnames(): string[] {
    return [...this.byName.keys()].sort();
  }

  /**
   * 告警的类别（ADR 0183）：取值合法的 srenautix_category 标签 → 命中条目声明的 category → 内置类别表 → 第一条命中的
   * 类别规则 → unclassified。标签的取值不在枚举里时忽略标签，按后面的来源继续
   */
  category(labels: Labels): CategoryResult {
    const label = labels[CATEGORY_LABEL];
    if (label !== undefined) {
      if (isAlertCategory(label)) {
        return { category: label, source: 'label' };
      }
      this.onInvalidCategoryLabel(labels.alertname ?? '', label);
    }
    const declared = this.lookup(labels)?.entry.category;
    if (declared !== undefined) {
      return { category: declared, source: 'catalog' };
    }
    const builtin = labels.alertname === undefined ? undefined : this.builtinCategories.get(labels.alertname);
    if (builtin !== undefined) {
      return { category: builtin, source: 'builtin' };
    }
    const rule = this.categoryRules.find((r) => matchesLabels(labels, r));
    if (rule) {
      return { category: rule.category, source: 'rule' };
    }
    return { category: UNCLASSIFIED, source: 'default' };
  }

  /**
   * 类别解析的全部输入（ADR 0183 §4）：条目按告警名排序，同名的按 lookup 的查找顺序排列，每项只取 alertname、
   * match_labels 与 category（没有声明时为 null）；后面是按告警名排序的内置类别表与有序的类别规则。两个目录的输入相同时，
   * 任何告警在两个目录里求出的类别都相同；条目的标题、角色、证据链与包名不影响类别，不在其中
   */
  categoryInputs(): CategoryInputs {
    return {
      entries: this.alertnames().flatMap((name) =>
        this.byName.get(name)!.map(({ entry }) => ({
          alertname: entry.alertname,
          match_labels: entry.match_labels ?? {},
          category: entry.category ?? null,
        })),
      ),
      builtin: [...this.builtinCategories]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([alertname, category]) => ({ alertname, category })),
      rules: this.categoryRules.map((r) => ({
        labels: r.labels,
        exclude_labels: r.exclude_labels,
        category: r.category,
      })),
    };
  }
}

/**
 * 告警目录条目声明的服务（ADR 0193 §5），按 categoryInputs 的条目顺序；并入归类输入的指纹，条目的 service 改了就重新归类
 */
export function catalogServiceInputs(
  catalog: AlertCatalog,
): Array<{ alertname: string; match_labels: Labels; service: string | null }> {
  return catalog.alertnames().flatMap((name) =>
    catalog.entries(name).map((entry) => ({
      alertname: entry.alertname,
      match_labels: entry.match_labels ?? {},
      service: entry.service ?? null,
    })),
  );
}

function specificity(e: AlertCatalogEntry): number {
  return Object.keys(e.match_labels ?? {}).length;
}

export interface ClassifyInput {
  labels: Labels;
  /** rules API 中该告警规则的表达式；拿不到时为 undefined */
  ruleExpr?: string;
  chronic: boolean;
}

/** 一个告警实例的角色分类与类别 */
export function classifyAlert(input: ClassifyInput, catalog: AlertCatalog): AlertClassification {
  const { labels, ruleExpr, chronic } = input;
  const cat = catalog.category(labels);
  return { ...classifyRole(labels, ruleExpr, chronic, catalog), category: cat.category, category_source: cat.source };
}

function classifyRole(
  labels: Labels,
  ruleExpr: string | undefined,
  chronic: boolean,
  catalog: AlertCatalog,
): Omit<AlertClassification, 'category' | 'category_source'> {
  const labelRole = labels.role;
  const hit = catalog.lookup(labels);
  if (labelRole !== undefined && (ALERT_ROLES as readonly string[]).includes(labelRole)) {
    // 角色以标签为准；目录条目照样记下，它声明的证据链作为补充执行（ADR 0097）
    return {
      role: labelRole as AlertRole,
      source: 'label',
      confidence: 1,
      catalog_entry: hit ? `${hit.pack}/${hit.entry.id}` : null,
      chronic,
    };
  }
  if (hit) {
    // 实际规则的表达式优先于目录记录的上游表达式
    const expr = ruleExpr ?? hit.entry.expr;
    let role = hit.entry.role;
    if (expr !== undefined) {
      if (isForecastExpression(expr)) {
        role = 'forecast';
      } else if (role === 'forecast') {
        // 目录写成 forecast、表达式却描述当前状态（例如剩余 <3% 的 critical 变体）时属于 cause
        role = 'cause';
      }
    }
    return {
      role,
      source: 'catalog',
      confidence: hit.entry.role_confidence ?? 1,
      catalog_entry: `${hit.pack}/${hit.entry.id}`,
      chronic,
    };
  }
  if (ruleExpr !== undefined) {
    const c = classifyExpression(ruleExpr);
    if (c) {
      return { role: c.role, source: 'expression', confidence: c.confidence, catalog_entry: null, chronic };
    }
  }
  return { role: 'symptom', source: 'default', confidence: 0.3, catalog_entry: null, chronic };
}
