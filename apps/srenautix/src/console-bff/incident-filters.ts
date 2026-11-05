import type { AlertCategory, IncidentCategory } from '@srenautix/contract';
import { ALERT_CATEGORIES, incidentCategories, isAlertCategory, isComponentKey, UNCLASSIFIED } from '@srenautix/core';
import { badRequest } from '../api/errors.js';
import type { IncidentRow } from '../incident/read.js';

// GET /v1/incidents 的类别与组件筛选（ADR 0183）。三个参数都可以重复；取值不合法时返回 400。

export interface CategoryFilters {
  /** 保留类别与任一取值相同的事件 */
  category: IncidentCategory[];
  /** 去掉类别全部落在这些取值中的事件；unclassified 不能被排除 */
  excludeCategory: AlertCategory[];
  /** 去掉组件全部落在这些组件中的事件 */
  excludeComponent: string[];
}

/** 查询参数的全部取值：没有时为空，出现一次为一个，重复时为多个 */
function values(query: Record<string, unknown>, key: string): string[] {
  const v = query[key];
  if (v === undefined) {
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => {
    if (typeof x !== 'string' || x === '') {
      throw badRequest(`${key} 不能为空`);
    }
    return x;
  });
}

export function parseCategoryFilters(query: Record<string, unknown>): CategoryFilters {
  const category = values(query, 'category').map((v) => {
    if (v !== UNCLASSIFIED && !isAlertCategory(v)) {
      throw badRequest(`category 只能是 ${[...ALERT_CATEGORIES, UNCLASSIFIED].join('、')}：${v}`);
    }
    return v as IncidentCategory;
  });
  const excludeCategory = values(query, 'exclude_category').map((v) => {
    if (v === UNCLASSIFIED) {
      throw badRequest('unclassified 不能被排除：没有类别的事件总是返回');
    }
    if (!isAlertCategory(v)) {
      throw badRequest(`exclude_category 只能是 ${ALERT_CATEGORIES.join('、')}：${v}`);
    }
    return v;
  });
  const excludeComponent = values(query, 'exclude_component').map((v) => {
    if (!isComponentKey(v)) {
      throw badRequest(`exclude_component 的组件键不合法：${v}`);
    }
    return v;
  });
  return { category, excludeCategory, excludeComponent };
}

/**
 * 筛选条件的 SQL（server.incidents 上），每项的 :p 是它的参数。categories 为空的行（数据修正还没有补上）不满足 category，
 * 也不被 exclude_category 去掉
 */
export function categoryConditions(f: CategoryFilters): Array<{ sql: string; value: string[] }> {
  const out: Array<{ sql: string; value: string[] }> = [];
  if (f.category.length) {
    out.push({ sql: 'categories && :p::text[]', value: f.category });
  }
  if (f.excludeCategory.length) {
    out.push({ sql: 'NOT coalesce(categories <@ :p::text[], false)', value: f.excludeCategory });
  }
  if (f.excludeComponent.length) {
    out.push({
      sql: "NOT (jsonb_array_length(body->'components') > 0 AND body->'components' <@ to_jsonb(:p::text[]))",
      value: f.excludeComponent,
    });
  }
  return out;
}

/** 摘要里的类别：取列；数据修正还没有补上时按 body 的成员算（没有类别的成员按 unclassified） */
export function rowCategories(r: IncidentRow): { categories: IncidentCategory[]; primary_category: IncidentCategory } {
  if (r.categories && r.primary_category) {
    return { categories: r.categories, primary_category: r.primary_category };
  }
  return incidentCategories(r.body.members, r.body.root.component);
}
