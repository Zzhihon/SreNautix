import type { ComponentType, Labels } from '@srenautix/contract';
import { matchTypeByName, parseKey, tryNodeKey } from '@srenautix/core';
import {
  resolveService,
  type ServiceCatalog,
  type ServiceResolution,
  type TypedObject,
} from '@srenautix/packs-sdk/business';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';

// 一条告警的服务（ADR 0193 §3）：接入与重新归类共用。对象的组件类型按阶段 A 的方式求出：拓扑节点上的
// component_type，没有时按 kind、命名空间与名称匹配领域包的组件类型。

export interface ServiceDeps {
  services: () => ServiceCatalog;
  componentTypes: () => readonly ComponentType[];
  /** 拓扑节点上记下的组件类型；节点不存在或没有类型时为 null */
  componentType(clusterId: string, key: string): Promise<string | null>;
  metrics: ServerMetrics;
}

export interface ServiceSubject {
  alertname: string;
  labels: Labels;
  /** 命中的告警目录条目声明的 service */
  catalogService?: string;
  /** 告警归属的组件键 */
  component: string | null;
  entity: { kind: string; namespace: string | null; name: string } | null;
  /** 告警实体的顶层属主键；与 component 相同时不再单独求 */
  owner: string | null;
}

/** 没有服务目录时（例如回放只需要类别）的结果 */
export const NO_SERVICE: ServiceResolution = { service: null, service_source: 'default', business_domain: null };

export async function alertService(
  deps: ServiceDeps,
  clusterId: string,
  s: ServiceSubject,
): Promise<ServiceResolution> {
  const typed = async (kind: string, namespace: string | null, name: string, key: string | null) => ({
    kind,
    namespace,
    name,
    componentType:
      (key ? await deps.componentType(clusterId, key) : null) ??
      matchTypeByName(kind, namespace, name, deps.componentTypes())?.id ??
      null,
  });
  const fromKey = async (key: string | null): Promise<TypedObject | null> => {
    if (!key) {
      return null;
    }
    const k = parseKey(key);
    return typed(k.kind, k.namespace, k.name, key);
  };
  const componentNamespace = s.component ? parseKey(s.component).namespace : null;
  return resolveService(
    {
      labels: s.labels,
      catalogService: s.catalogService,
      namespace: s.labels.namespace ?? s.entity?.namespace ?? componentNamespace,
      component: () => fromKey(s.component),
      entity: () => {
        const e = s.entity;
        return e ? typed(e.kind, e.namespace, e.name, tryNodeKey(e.kind, e.namespace, e.name)) : Promise.resolve(null);
      },
      owner: () => (s.owner && s.owner !== s.component ? fromKey(s.owner) : Promise.resolve(null)),
      onInvalidLabel: (value) => invalidLabel(deps.metrics, s.alertname, value),
    },
    deps.services(),
  );
}

const warned = new Set<string>();

/** srenautix_service 的取值不是已声明的服务：每次计数，警告日志每个（告警名，取值）在进程内只写一次 */
function invalidLabel(metrics: ServerMetrics, alertname: string, value: string): void {
  metrics.alertServiceLabelInvalid.inc({ alertname });
  const key = `${alertname}\0${value}`;
  if (!warned.has(key)) {
    warned.add(key);
    logger.warn('告警的 srenautix_service 标签不是已声明的服务，已忽略', { alertname, value });
  }
}
