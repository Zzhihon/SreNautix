import { z } from 'zod';

// 业务影响告警的定义（ADR 0166）：首条消息时延的 business_impact 标签、外部上游汇总的业务影响、处置推导中
// "业务受影响时不给 ignore"与"计划内退役判为 ignore"的前提，都用同一组匹配器。
// 一条告警满足其中任一项即为业务影响告警；一项内 labels 的每个标签都要取列出的值之一，并且 exclude_labels 中任何一个标签
// 都不取列出的值。匹配只看告警的标签（severity 也按标签匹配）。没有匹配器时没有业务影响告警。

/** 标签条件：标签名 → 允许的取值（每个键都要满足，取值之一即可） */
export const labelCondition = z.record(z.string().min(1), z.array(z.string().min(1)).min(1));

export const alertMatcher = z
  .object({
    labels: labelCondition.refine((m) => Object.keys(m).length > 0, 'labels 至少要有一个标签'),
    // 排除：任何一个标签取列出的值之一时不匹配（例如 component: [provider]）
    exclude_labels: labelCondition.default({}),
  })
  .strict();

export type AlertMatcher = z.infer<typeof alertMatcher>;

type Labels = Readonly<Record<string, string | undefined>>;

/** 一项匹配器：labels 全部满足，exclude_labels 一个都不满足 */
export function matchesAlert(labels: Labels, m: AlertMatcher): boolean {
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

/** 满足任一项即为业务影响告警；没有匹配器时为 false */
export function isBusinessImpact(labels: Labels, matchers: readonly AlertMatcher[]): boolean {
  return matchers.some((m) => matchesAlert(labels, m));
}

/**
 * 匹配器的文字形式（汇总消息"业务影响：无"后面写明所用的条件，与语言无关），项之间用 " / " 分隔，
 * 例如 layer=L0|L1,severity=critical,component!=provider
 */
export function matchersText(matchers: readonly AlertMatcher[]): string {
  return matchers
    .map((m) =>
      [
        ...Object.entries(m.labels).map(([k, v]) => `${k}=${v.join('|')}`),
        ...Object.entries(m.exclude_labels).map(([k, v]) => `${k}!=${v.join('|')}`),
      ].join(','),
    )
    .join(' / ');
}

/** 匹配器用到的 labels 键的集合（状态库按 labels ?& keys 预先筛选，每项一组） */
export function matcherKeys(matchers: readonly AlertMatcher[]): string[][] {
  return matchers.map((m) => Object.keys(m.labels));
}

/**
 * 旧写法的转换（ADR 0166）：
 * - 一项是标签条件本身（{severity: [critical]}，ADR 0159 的写法）时，转为 {labels: <它>}；
 * - 只给出 notify.digest.external_roots.business_impact.alert_labels（ADR 0150、0163）时，转为 [{labels: <它>}]。
 * 返回转换后的匹配器（原样的 unknown，交给 schema 校验）与弃用说明
 */
export function upgradeMatchers(
  current: unknown,
  legacyLabels: unknown,
  keys: { current: string; legacy: string },
): { value: unknown; deprecated: string[] } {
  const deprecated: string[] = [];
  const legacyGiven =
    legacyLabels !== undefined &&
    legacyLabels !== null &&
    typeof legacyLabels === 'object' &&
    Object.keys(legacyLabels).length > 0;
  if (current === undefined) {
    if (!legacyGiven) {
      return { value: undefined, deprecated };
    }
    deprecated.push(
      `${keys.legacy} 已弃用，按 ${keys.current}: [{labels: ${JSON.stringify(legacyLabels)}}] 处理；` +
        `它不再隐含 severity=critical，需要时在 labels 里写明。下一个版本不再读取 ${keys.legacy}`,
    );
    return { value: [{ labels: legacyLabels }], deprecated };
  }
  if (legacyGiven) {
    deprecated.push(`${keys.legacy} 已弃用，同时给出了 ${keys.current}，${keys.legacy} 不生效`);
  }
  if (!Array.isArray(current)) {
    return { value: current, deprecated };
  }
  const value = current.map((item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const l = (item as Record<string, unknown>).labels;
      if (l === undefined || Array.isArray(l)) {
        deprecated.push(
          `${keys.current} 的项 ${JSON.stringify(item)} 是旧写法（标签条件本身），按 {labels: ${JSON.stringify(item)}} 处理；下一个版本不再接受`,
        );
        return { labels: item };
      }
    }
    return item;
  });
  return { value, deprecated };
}
