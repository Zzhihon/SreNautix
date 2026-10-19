// 告警角色分类（DESIGN §3.2）：标签契约 → 告警目录 → 规则表达式 → 默认 symptom。
// forecast 一律按表达式判断：目录条目或规则表达式含 predict_linear 才是 forecast。
import type { AlertCatalogEntry, AlertClassification, AlertRole, Labels } from '@srenautix/contract';

export const ALERT_ROLES: readonly AlertRole[] = ['cause', 'change', 'symptom', 'forecast', 'meta'];

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

  constructor(packs: ReadonlyArray<{ pack: string; entries: readonly AlertCatalogEntry[] }>) {
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

  has(alertname: string): boolean {
    return this.byName.has(alertname);
  }

  alertnames(): string[] {
    return [...this.byName.keys()].sort();
  }
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

/** 一个告警实例的角色分类 */
export function classifyAlert(input: ClassifyInput, catalog: AlertCatalog): AlertClassification {
  const { labels, ruleExpr, chronic } = input;
  const labelRole = labels.role;
  if (labelRole !== undefined && (ALERT_ROLES as readonly string[]).includes(labelRole)) {
    return { role: labelRole as AlertRole, source: 'label', confidence: 1, catalog_entry: null, chronic };
  }
  const hit = catalog.lookup(labels);
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
