import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEMAS } from '@srenautix/contract';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

/**
 * 按 contract/openapi.yaml 校验接口响应：取 paths 下对应操作、状态码的 application/json schema。
 * 文档以 https://srenautix.io/contract/openapi.yaml 为 $id 注册，相对引用解析到契约中的 schema。
 */
const ID = 'https://srenautix.io/contract/openapi.yaml';
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats.default(ajv);
for (const s of Object.values(SCHEMAS)) {
  ajv.addSchema(s);
}
const doc = parseYaml(
  readFileSync(resolve(import.meta.dirname, '../../../../contract/openapi.yaml'), 'utf8'),
) as Record<string, unknown>;
ajv.addSchema({ $id: ID, ...doc });

const esc = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');

/** 返回校验错误的文字说明；通过时为 null。 */
export function responseErrors(path: string, method: string, status: number, body: unknown): string | null {
  const ptr = `${ID}#/paths/${esc(path)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const fn = ajv.getSchema(ptr);
  if (!fn) {
    throw new Error(`契约中没有 ${method} ${path} ${status} 的 JSON 响应`);
  }
  return fn(body) ? null : JSON.stringify(fn.errors?.slice(0, 5));
}
