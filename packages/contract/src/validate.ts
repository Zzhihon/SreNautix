import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { SCHEMAS } from './generated/schemas.js';

export const SCHEMA_BASE = 'https://srenautix.io/contract/';

// contract/ 中的扩展关键字，只作为标注，不参与校验
const ANNOTATION_KEYWORDS = ['x-srenautix-dynamic-enum', 'x-srenautix-portable', 'x-srenautix-secret-ref'];

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const keyword of ANNOTATION_KEYWORDS) {
    ajv.addKeyword({ keyword, schemaType: ['string', 'boolean'] });
  }
  for (const schema of Object.values(SCHEMAS)) {
    ajv.addSchema(schema);
  }
  return ajv;
}

let shared: Ajv2020 | undefined;

/** 全部契约 schema 都已注册的 Ajv 实例（进程内共享） */
export function contractAjv(): Ajv2020 {
  shared ??= createAjv();
  return shared;
}

/** 按相对 contract/ 的路径（可带 #/$defs/Name）取校验函数，例如 schemas/incident.schema.json */
export function validatorFor<T>(ref: string): ValidateFunction<T> {
  const id = ref.startsWith('https://') ? ref : SCHEMA_BASE + ref;
  const fn = contractAjv().getSchema<T>(id);
  if (fn === undefined) {
    throw new Error(`契约中没有 ${id}`);
  }
  return fn;
}

export class ContractViolation extends Error {
  constructor(
    readonly ref: string,
    readonly errors: ErrorObject[],
  ) {
    super(`${ref} 校验失败：${errors.map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；')}`);
  }
}

/** 校验并返回带类型的值；不合法时抛出 ContractViolation */
export function assertValid<T>(ref: string, value: unknown): T {
  const fn = validatorFor<T>(ref);
  if (!fn(value)) {
    throw new ContractViolation(ref, fn.errors ?? []);
  }
  return value;
}
