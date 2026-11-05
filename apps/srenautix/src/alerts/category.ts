import { ALERT_CATEGORIES, type AlertCatalogOptions, type CategoryRule } from '@srenautix/core';
import { z } from 'zod';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { alertMatcher } from './business-impact.js';

// 告警类别（ADR 0183）：srenautix_category 标签 → 告警目录条目的 category → ingest.category_rules 第一条命中 → unclassified。
// 规则的匹配器与业务影响告警（ADR 0166）写法相同，多一个 category。

/** ingest.category_rules 的一项 */
export const categoryRule = z
  .object({
    ...alertMatcher.shape,
    category: z.enum(ALERT_CATEGORIES),
  })
  .strict();

/**
 * 告警目录的类别选项：规则表与非法标签的处理。非法标签每次分类计一次指标
 * srenautix_alert_category_label_invalid_total；警告日志每个（告警名，取值）在进程内只写一次
 */
export function categoryOptions(rules: readonly CategoryRule[], metrics: ServerMetrics): AlertCatalogOptions {
  const warned = new Set<string>();
  return {
    categoryRules: rules,
    onInvalidCategoryLabel: (alertname, value) => {
      metrics.alertCategoryLabelInvalid.inc({ alertname });
      const key = `${alertname}\0${value}`;
      if (!warned.has(key)) {
        warned.add(key);
        logger.warn('告警的 srenautix_category 标签取值不在类别枚举里，已忽略', {
          alertname,
          value,
          allowed: ALERT_CATEGORIES,
        });
      }
    },
  };
}
