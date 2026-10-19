// 动作目录（contract/gateway/v1/action-catalog.yaml）。领域包的 rules.yaml 只能引用目录中已有的动作，
// 参数名必须是该动作 params schema 中声明的字段。

import { readFileSync } from 'node:fs';
import { assertValid } from '@srenautix/contract';
import { parse } from 'yaml';

export interface CatalogAction {
  id: string;
  level: string;
  params: { required?: string[]; properties?: Record<string, unknown> };
}

export interface ActionCatalog {
  version: number;
  actions: CatalogAction[];
}

export function loadActionCatalog(path: string): ActionCatalog {
  const doc = parse(readFileSync(path, 'utf8')) as unknown;
  return assertValid<ActionCatalog>('gateway/v1/action-catalog.schema.json', doc);
}
