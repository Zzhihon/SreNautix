import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertValid, contractAjv } from '@srenautix/contract';
import type { ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

/** 动作目录中 server 用到的字段（contract/gateway/v1/action-catalog.schema.json）。 */
export interface CatalogAction {
  id: string;
  title: string;
  level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
  fallback_level?: 'irreversible';
  min_tier: 'L' | 'H';
  fallback_min_tier?: 'L' | 'H';
  auto_execution: 'allowed' | 'forbidden';
  target: {
    group: string;
    version: string;
    kind: string;
    resource: string;
    namespaced: boolean;
    kinds?: Array<{ group: string; version: string; kind: string; resource: string }>;
  };
  params: Record<string, unknown>;
  conflict_domain: string;
  prechecks?: Array<{ id: string; kind: string; description: string }>;
  verify?: { window_seconds: number; checks: Array<{ id: string; kind: string; description: string }> };
  undo: { kind: 'restore' | 'recreate' | 'compensate' | 'none'; description: string; compensation_action?: string };
  blast_radius: { unit: string; method: string; l_tier_max: number };
}

export interface ActionCatalog {
  version: 1;
  actions: CatalogAction[];
}

/** 默认读取仓库（镜像内为 /app）中的 contract/gateway/v1/action-catalog.yaml。 */
export const DEFAULT_CATALOG_PATH = resolve(import.meta.dirname, '../../../../contract/gateway/v1/action-catalog.yaml');

/** 互为撤销的动作对（DESIGN §9.1 的 reversible 动作）。 */
export const INVERSE_ACTIONS: Record<string, string> = {
  node_cordon: 'node_uncordon',
  rollout_pause: 'rollout_resume',
  cronjob_suspend: 'cronjob_resume',
  argocd_autosync_suspend: 'argocd_autosync_resume',
  flux_suspend: 'flux_resume',
};

export class Catalog {
  private readonly byId: Map<string, CatalogAction>;
  private readonly paramValidators = new Map<string, ValidateFunction>();

  constructor(readonly raw: ActionCatalog) {
    this.byId = new Map(raw.actions.map((a) => [a.id, a]));
    for (const a of raw.actions) {
      this.paramValidators.set(a.id, contractAjv().compile({ ...a.params, $id: undefined }));
    }
  }

  static load(path = DEFAULT_CATALOG_PATH): Catalog {
    const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
    return new Catalog(assertValid<ActionCatalog>('gateway/v1/action-catalog.schema.json', raw));
  }

  get(id: string): CatalogAction | undefined {
    return this.byId.get(id);
  }

  list(): CatalogAction[] {
    return [...this.byId.values()];
  }

  /** 参数校验：不合法时返回错误说明。verify（执行后校验条件）是参数的一部分，按目录的 promqlCondition 校验。 */
  validateParams(id: string, params: unknown): string | null {
    const v = this.paramValidators.get(id);
    if (!v) {
      return `动作 ${id} 不在目录中`;
    }
    const p = params as Record<string, unknown>;
    const { verify, ...rest } = p ?? {};
    if (!v(rest)) {
      return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；');
    }
    if (verify !== undefined) {
      const cv = contractAjv().getSchema(
        'https://srenautix.io/contract/gateway/v1/action-catalog.schema.json#/$defs/promqlCondition',
      );
      if (!cv || !Array.isArray(verify) || !verify.every((x) => cv(x))) {
        return 'verify 必须是 promqlCondition 数组';
      }
    }
    return null;
  }

  /** 撤销动作：互为撤销的动作对，或 restore 类动作以执行前的参数重新执行。 */
  undoAction(id: string): string | null {
    const inv = INVERSE_ACTIONS[id] ?? Object.entries(INVERSE_ACTIONS).find(([, v]) => v === id)?.[0];
    if (inv && this.byId.has(inv)) {
      return inv;
    }
    return this.byId.get(id)?.undo.kind === 'restore' ? id : null;
  }
}
