import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEMAS } from '@srenautix/contract';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { badRequest } from './errors.js';

const CONTRACT_DIR = resolve(import.meta.dirname, '../../../../contract');
const BASE = 'https://srenautix.io/contract/';

let ajv: Ajv2020 | null = null;

/**
 * OpenAPI 文档里 components/schemas 的校验器。文档整体以它在 contract/ 中的路径为 $id 注册，
 * 文档内的相对 $ref（例如工单协议引用的 approval-envelope.schema.json）按同一基准解析。
 */
function instance(): Ajv2020 {
  if (!ajv) {
    const a = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats.default(a);
    for (const s of Object.values(SCHEMAS)) {
      a.addSchema(s);
    }
    ajv = a;
  }
  return ajv;
}

const loaded = new Set<string>();

export function openapiValidator<T>(docPath: string, component: string): ValidateFunction<T> {
  const a = instance();
  const id = BASE + docPath;
  if (!loaded.has(id)) {
    const doc = parseYaml(readFileSync(resolve(CONTRACT_DIR, docPath), 'utf8')) as Record<string, unknown>;
    a.addSchema({ $id: id, ...doc });
    loaded.add(id);
  }
  const fn = a.getSchema<T>(`${id}#/components/schemas/${component}`);
  if (!fn) {
    throw new Error(`${docPath} 中没有 components/schemas/${component}`);
  }
  return fn;
}

/** 校验请求体，不合法时返回 400。 */
export function checkBody<T>(fn: ValidateFunction<T>, body: unknown): T {
  if (!fn(body)) {
    throw badRequest((fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；'));
  }
  return body;
}
