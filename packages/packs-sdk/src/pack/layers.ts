// 用户层（DESIGN §6.3）：按声明的顺序合并（组织在前、集群在后）。每个层只修改一个包，
// 层内的操作按 extend → params → patch → disable 的顺序执行；结果重新按契约校验。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertValid, type PackUserLayer, type RcaParams } from '@srenautix/contract';
import jsonpointer from 'jsonpointer';
import { parse } from 'yaml';
import { PackLintError } from '../cel/errors.js';
import type { LoadedPack, PackContent } from './load.js';
import { mergeDomain } from './domains.js';

const PACK_SCHEMA = 'schemas/pack.schema.json';

export interface LoadedLayer {
  path: string;
  sha256: string;
  layer: PackUserLayer;
}

export function loadLayerFile(path: string): LoadedLayer {
  const raw = readFileSync(path);
  const doc = parse(raw.toString('utf8'), { uniqueKeys: true }) as unknown;
  let layer: PackUserLayer;
  try {
    layer = assertValid<PackUserLayer>(`${PACK_SCHEMA}#/$defs/UserLayer`, doc);
  } catch (err) {
    throw new PackLintError(path, err instanceof Error ? err.message : String(err));
  }
  return { path, sha256: createHash('sha256').update(raw).digest('hex'), layer };
}

/** patch 的 JSON Pointer 作用的文档：各数据文件按文件名组织 */
interface PatchDoc {
  signals: PackContent['signals'];
  components: PackContent['components'];
  alerts: PackContent['alerts'];
  chains: PackContent['chains'];
  checks: PackContent['checks'];
  rules: PackContent['rules'];
  domains: PackContent['domains'];
  issues: PackContent['issues'];
  rca_params: RcaParams | null;
}

function mergeRca(base: RcaParams | null, over: RcaParams): RcaParams {
  return {
    ...(base ?? {}),
    ...over,
    weights: { ...(base?.weights ?? {}), ...(over.weights ?? {}) },
    role_priors: { ...(base?.role_priors ?? {}), ...(over.role_priors ?? {}) },
  };
}

function appendUnique<T extends { id: string }>(where: string, list: T[], add: T[] | undefined): T[] {
  for (const x of add ?? []) {
    if (list.some((y) => y.id === x.id)) {
      throw new PackLintError(where, `extend 追加的 ${x.id} 已存在；修改已有条目请用 patch`);
    }
    list.push(x);
  }
  return list;
}

function applyOne(pack: LoadedPack, l: LoadedLayer): void {
  const where = `${l.path}（目标 ${pack.name}）`;
  const c = structuredClone(pack.content);
  const ext = l.layer.extend ?? {};
  appendUnique(where, c.signals.signals, ext.signals);
  appendUnique(where, c.components.component_types, ext.component_types);
  c.components.conventions = appendUnique(where, c.components.conventions ?? [], ext.conventions);
  appendUnique(where, c.alerts.entries, ext.alerts);
  appendUnique(where, c.chains.chains, ext.chains);
  appendUnique(where, c.checks.checks, ext.checks);
  appendUnique(where, c.rules.rules, ext.rules);
  // 指标、领域与业务 issue 模板（契约 2.28.0）：同 id 的领域按 DomainsFile 的规则合并进去，其余追加
  c.domains.indicators = appendUnique(where, c.domains.indicators ?? [], ext.indicators);
  const domains = c.domains.domains ?? [];
  for (const d of ext.domains ?? []) {
    const i = domains.findIndex((x) => x.id === d.id);
    if (i < 0) {
      domains.push(d);
    } else {
      domains[i] = mergeDomain(where, domains[i]!, d);
    }
  }
  c.domains.domains = domains;
  appendUnique(where, c.issues.issues, ext.issues);

  for (const [key, values] of Object.entries(l.layer.params ?? {})) {
    const [scope, id, extra] = key.split('/');
    const card =
      scope === 'checks' && extra === undefined
        ? c.checks.checks.find((x) => x.id === id)
        : c.chains.chains.find((x) => x.id === scope)?.cards.find((x) => x.id === id);
    if (!card || extra !== undefined) {
      throw new PackLintError(where, `params 的键 ${key} 没有对应的卡片（写作 <chain>/<card> 或 checks/<id>）`);
    }
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (!card.params || !(k in card.params)) {
        throw new PackLintError(where, `卡片 ${key} 没有声明参数 ${k}`);
      }
      if (typeof v !== typeof card.params[k]) {
        throw new PackLintError(where, `卡片 ${key} 的参数 ${k} 类型应为 ${typeof card.params[k]}`);
      }
      card.params[k] = v as number | string | boolean;
    }
  }

  const doc: PatchDoc = {
    signals: c.signals,
    components: c.components,
    alerts: c.alerts,
    chains: c.chains,
    checks: c.checks,
    rules: c.rules,
    domains: c.domains,
    issues: c.issues,
    rca_params: c.rca_params,
  };
  for (const p of l.layer.patch ?? []) {
    if (!p.path.startsWith('/') || p.path === '/') {
      throw new PackLintError(where, `patch 路径必须是指向已有字段的 JSON Pointer：${p.path}`);
    }
    // 只允许修改已存在的位置，防止拼写错误悄悄新增字段
    const parent = p.path.slice(0, p.path.lastIndexOf('/'));
    const exists = parent === '' ? true : jsonpointer.get(doc, parent) !== undefined;
    if (!exists || jsonpointer.get(doc, p.path) === undefined) {
      throw new PackLintError(where, `patch 路径不存在：${p.path}`);
    }
    jsonpointer.set(doc, p.path, structuredClone(p.value));
  }
  c.signals = doc.signals;
  c.components = doc.components;
  c.alerts = doc.alerts;
  c.chains = doc.chains;
  c.checks = doc.checks;
  c.rules = doc.rules;
  c.domains = doc.domains;
  c.issues = doc.issues;
  c.rca_params = doc.rca_params;

  for (const d of l.layer.disable ?? []) {
    const [kind, id, card, extra] = d.split('/');
    const fail = () => {
      throw new PackLintError(where, `disable 的条目不存在：${d}`);
    };
    if (extra !== undefined || !id) {
      fail();
    }
    const drop = <T extends { id: string }>(list: T[]): T[] => {
      const out = list.filter((x) => x.id !== id);
      if (out.length === list.length) {
        fail();
      }
      return out;
    };
    switch (kind) {
      case 'alerts':
        c.alerts.entries = drop(c.alerts.entries);
        break;
      case 'checks':
        c.checks.checks = drop(c.checks.checks);
        break;
      case 'rules':
        c.rules.rules = drop(c.rules.rules);
        break;
      case 'indicators':
        c.domains.indicators = drop(c.domains.indicators ?? []);
        break;
      case 'issues':
        c.issues.issues = drop(c.issues.issues);
        break;
      case 'domains':
        if (card === undefined) {
          c.domains.domains = drop(c.domains.domains ?? []);
        } else {
          // 领域内的一张诊断卡或份额卡
          const domain = (c.domains.domains ?? []).find((x) => x.id === id) ?? fail();
          const diagnostics = (domain.diagnostics ?? []).filter((x) => x.id !== card);
          const contribution = (domain.contribution ?? []).filter((x) => x.id !== card);
          if (
            diagnostics.length === (domain.diagnostics ?? []).length &&
            contribution.length === (domain.contribution ?? []).length
          ) {
            fail();
          }
          domain.diagnostics = diagnostics;
          domain.contribution = contribution;
        }
        break;
      case 'chains':
        if (card === undefined) {
          c.chains.chains = drop(c.chains.chains);
        } else {
          const chain = c.chains.chains.find((x) => x.id === id) ?? fail();
          const left = chain.cards.filter((x) => x.id !== card);
          if (left.length === chain.cards.length) {
            fail();
          }
          if (!left.length) {
            throw new PackLintError(where, `禁用后证据链 ${id} 没有卡片；请禁用整条证据链`);
          }
          chain.cards = left as typeof chain.cards;
        }
        break;
      default:
        fail();
    }
  }
  if (l.layer.rca_params) {
    c.rca_params = mergeRca(c.rca_params, l.layer.rca_params);
  }

  const check = <T>(ref: string, v: T) => {
    try {
      assertValid(`${PACK_SCHEMA}#/$defs/${ref}`, v);
    } catch (err) {
      throw new PackLintError(where, `合并后的内容不符合契约：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  check('SignalsFile', c.signals);
  check('ComponentsFile', c.components);
  check('AlertsFile', c.alerts);
  check('ChainsFile', c.chains);
  check('ChecksFile', c.checks);
  check('RulesFile', c.rules);
  check('DomainsFile', c.domains);
  check('IssuesFile', c.issues);
  if (c.rca_params) {
    check('RcaParams', c.rca_params);
  }
  pack.content = c;
}

/** 按声明顺序应用全部用户层 */
export function applyLayers(packs: LoadedPack[], layers: LoadedLayer[]): void {
  for (const l of layers) {
    const pack = packs.find((p) => p.name === l.layer.target);
    if (!pack) {
      throw new PackLintError(l.path, `目标包 ${l.layer.target} 没有加载`);
    }
    applyOne(pack, l);
  }
}
