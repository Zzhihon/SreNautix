import type { AlertCategory, IncidentCategory } from '@srenautix/contract';
import {
  ALERT_CATEGORIES,
  incidentCategories,
  incidentServices,
  isAlertCategory,
  isComponentKey,
  UNCLASSIFIED,
  type IncidentServices,
} from '@srenautix/core';
import { badRequest } from '../kernel/errors.js';
import type { IncidentRow } from '../incident/read.js';

// GET /v1/incidents 与导出的归类筛选：类别与组件（ADR 0183），业务领域与服务（ADR 0193）。参数都可以重复；取值不合法时
// 返回 400。

/** 业务领域与服务的 id：与契约的 BusinessDomainId、ServiceId 相同 */
const BUSINESS_ID = /^[a-z][a-z0-9-]{0,62}$/;

export interface ClassificationFilters {
  /** 保留类别与任一取值相同的事件 */
  category: IncidentCategory[];
  /** 去掉类别全部落在这些取值中的事件；unclassified 不能被排除 */
  excludeCategory: AlertCategory[];
  /** 去掉组件全部落在这些组件中的事件 */
  excludeComponent: string[];
  /** 保留主业务领域与任一取值相同的事件 */
  businessDomain: string[];
  /** 去掉主业务领域落在这些取值中的事件；没有业务领域的事件不去掉 */
  excludeBusinessDomain: string[];
  /** 保留服务与任一取值相同的事件 */
  service: string[];
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

export function parseClassificationFilters(query: Record<string, unknown>): ClassificationFilters {
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
  const ids = (key: string) =>
    values(query, key).map((v) => {
      if (!BUSINESS_ID.test(v)) {
        throw badRequest(`${key} 不是合法的 id：${v}`);
      }
      return v;
    });
  return {
    category,
    excludeCategory,
    excludeComponent,
    businessDomain: ids('business_domain'),
    excludeBusinessDomain: ids('exclude_business_domain'),
    service: ids('service'),
  };
}

/**
 * 筛选条件的 SQL（server.incidents 上），每项的 :p 是它的参数。categories 为空的行（数据修正还没有补上）不满足 category，
 * 也不被 exclude_category 去掉
 */
export function classificationConditions(f: ClassificationFilters): Array<{ sql: string; value: string[] }> {
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
  // 服务列为空的行（重新归类还没有补上）不满足 business_domain 与 service，也不被 exclude_business_domain 去掉
  if (f.businessDomain.length) {
    out.push({ sql: 'business_domain = ANY(:p::text[])', value: f.businessDomain });
  }
  if (f.excludeBusinessDomain.length) {
    out.push({ sql: 'NOT coalesce(business_domain = ANY(:p::text[]), false)', value: f.excludeBusinessDomain });
  }
  if (f.service.length) {
    out.push({ sql: 'services && :p::text[]', value: f.service });
  }
  return out;
}

/** GET /v1/incidents 与 GET /v1/incidents/export 共用的筛选条件（状态与搜索词除外） */
export interface IncidentFilters extends ClassificationFilters {
  clusterId: string | null;
  severity: string | null;
  /** 与 [from, to] 有重叠的事件：仍在触发的事件按当前时刻结束 */
  from: string | null;
  to: string | null;
  /** 根因组件或组件之一 */
  component: string | null;
}

/** 筛选条件的 SQL（server.incidents 上），每项的 :p 是它的参数 */
export function incidentConditions(f: IncidentFilters): Array<{ sql: string; value: unknown }> {
  const out: Array<{ sql: string; value: unknown }> = [];
  if (f.clusterId) out.push({ sql: 'cluster_id = :p', value: f.clusterId });
  if (f.severity) out.push({ sql: 'severity = :p', value: f.severity });
  if (f.from) out.push({ sql: 'coalesce(ended_at, now()) >= :p::timestamptz', value: f.from });
  if (f.to) out.push({ sql: 'first_firing_at <= :p::timestamptz', value: f.to });
  if (f.component) {
    out.push({ sql: "(root_component = :p OR jsonb_exists(body->'components', :p))", value: f.component });
  }
  return [...out, ...classificationConditions(f)];
}

/** 摘要里的类别：取列；数据修正还没有补上时按 body 的成员算（没有类别的成员按 unclassified） */
export function rowCategories(r: IncidentRow): { categories: IncidentCategory[]; primary_category: IncidentCategory } {
  if (r.categories && r.primary_category) {
    return { categories: r.categories, primary_category: r.primary_category };
  }
  return incidentCategories(r.body.members, r.body.root.component);
}

/** 摘要里的服务：取列；重新归类还没有补上时按 body 的成员算（没有服务的成员不计） */
export function rowServices(r: IncidentRow): IncidentServices {
  if (r.services) {
    return {
      services: r.services,
      primary_service: r.primary_service,
      primary_service_source: r.primary_service_source,
      business_domain: r.business_domain,
    };
  }
  return incidentServices(r.body.members, r.body.root.component);
}
