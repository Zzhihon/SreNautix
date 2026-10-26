import { createHash } from 'node:crypto';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { SCHEMAS } from '@srenautix/contract';

// 模型输出 schema 的三种形态（DESIGN §8.2）：
// - contract/model/ 中的原始 schema，x-srenautix-dynamic-enum 标出运行时取值的字段；
// - 绑定后的完整 schema：动态字段替换为本次运行的枚举，保留长度、条数等约束，用于本地校验与按字段挽救；
// - 发给模型的可移植 schema：只保留可移植子集的关键字（扁平、全部必填、additionalProperties:false、枚举、无 oneOf）。

/** findings：主动优化进入分析的候选发现（ADR 0146 §2.3） */
export type DynamicEnumName = 'components' | 'evidence_refs' | 'check_templates' | 'runbooks' | 'actions' | 'findings';
/** schema 用到的动态枚举都必须给出，没有用到的可以省略 */
export type DynamicEnums = Readonly<Partial<Record<DynamicEnumName, readonly string[]>>>;

/** contract/model/ 中的模型输出 schema */
export type ModelSchemaName = 'hypothesize' | 'conclude' | 'optimize-hypothesize' | 'optimize-conclude';

type Json = Record<string, unknown>;

const DYNAMIC = 'x-srenautix-dynamic-enum';
const PORTABLE_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
]);
const FORBIDDEN_KEYWORDS = ['oneOf', 'anyOf', 'allOf', '$ref', 'not', 'if', 'then', 'else', 'patternProperties'];

export class SchemaError extends Error {
  override name = 'SchemaError';
}

export function modelSchema(name: ModelSchemaName): Json {
  const s = SCHEMAS[`https://srenautix.io/contract/model/${name}.schema.json`];
  if (!s) {
    throw new SchemaError(`契约中没有 model/${name}.schema.json`);
  }
  return s;
}

function typesOf(node: Json): string[] {
  const t = node.type;
  return Array.isArray(t) ? (t as string[]) : typeof t === 'string' ? [t] : [];
}

/** 检查 schema 是否落在可移植子集内；违反时报错（契约 CI 与运行时绑定前都调用） */
export function assertPortable(node: Json, path = '$'): void {
  for (const k of FORBIDDEN_KEYWORDS) {
    if (k in node) {
      throw new SchemaError(`${path} 使用了可移植子集之外的 ${k}`);
    }
  }
  const types = typesOf(node);
  if (types.includes('object')) {
    if (node.additionalProperties !== false) {
      throw new SchemaError(`${path} 必须是 additionalProperties:false`);
    }
    const props = Object.keys((node.properties as Json | undefined) ?? {});
    const required = new Set((node.required as string[] | undefined) ?? []);
    const missing = props.filter((p) => !required.has(p));
    if (missing.length) {
      throw new SchemaError(`${path} 的字段必须全部必填，缺少 ${missing.join('、')}`);
    }
    for (const p of props) {
      assertPortable((node.properties as Json)[p] as Json, `${path}.${p}`);
    }
  }
  if (types.includes('array')) {
    assertPortable(node.items as Json, `${path}[]`);
  }
}

interface Bound {
  full: Json;
  portable: Json;
}

/**
 * 用本次运行的取值绑定动态枚举。可空字段的枚举加上 null。
 * 取值为空、字段又不可空时：完整 schema 把包含它的数组的 maxItems 设为 0（该数组只能为空），
 * 可移植 schema 不加枚举，由本地校验与挽救删除这些条目。
 */
export function bindSchema(source: Json, enums: DynamicEnums): Bound {
  assertPortable(source);
  const walk = (node: Json, arrays: Json[]): { full: Json; portable: Json } => {
    const full: Json = {};
    const portable: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties') {
        const fp: Json = {};
        const pp: Json = {};
        for (const [name, child] of Object.entries(v as Json)) {
          const r = walk(child as Json, arrays);
          fp[name] = r.full;
          pp[name] = r.portable;
        }
        full.properties = fp;
        portable.properties = pp;
      } else if (k === 'items') {
        const holder: Json = {};
        const r = walk(v as Json, [...arrays, holder]);
        full.items = r.full;
        portable.items = r.portable;
        if (holder.maxItems === 0) {
          full.maxItems = 0;
        }
      } else if (k === DYNAMIC || k === '$schema' || k === '$id' || k === 'title' || k.startsWith('x-')) {
        continue;
      } else {
        full[k] = v;
        if (PORTABLE_KEYWORDS.has(k)) {
          portable[k] = v;
        }
      }
    }
    const dyn = node[DYNAMIC] as DynamicEnumName | undefined;
    if (dyn) {
      const values = enums[dyn];
      if (!values) {
        throw new SchemaError(`没有提供动态枚举 ${dyn} 的取值`);
      }
      const nullable = typesOf(node).includes('null');
      if (values.length) {
        const e = nullable ? [...values, null] : [...values];
        full.enum = e;
        portable.enum = e;
      } else if (nullable) {
        full.enum = [null];
        portable.enum = [null];
      } else {
        const holder = arrays[arrays.length - 1];
        if (!holder) {
          throw new SchemaError(`动态枚举 ${dyn} 为空，且字段不在数组中，无法输出`);
        }
        holder.maxItems = 0;
      }
    }
    return { full, portable };
  };
  const bound = walk(source, []);
  // 根上的 description 是写给契约读者的说明（引用 DESIGN 与 ADR 的章节），不发给模型；字段的 description 照常发送
  delete bound.portable.description;
  return bound;
}

function newAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
}

const ajv = newAjv();
const compiled = new Map<string, ValidateFunction>();

export function schemaHash(schema: Json): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
}

export function validatorOf(schema: Json): ValidateFunction {
  const key = schemaHash(schema);
  let v = compiled.get(key);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(key, v);
  }
  return v;
}

export function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 12)
    .map(
      (e) =>
        `${e.instancePath || '/'} ${e.message ?? e.keyword}${e.keyword === 'enum' ? `（允许：${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues).slice(0, 200)}）` : ''}`,
    )
    .join('；');
}

export interface Salvaged {
  ok: boolean;
  value: unknown;
}

function typeMatches(types: string[], v: unknown): boolean {
  if (v === null) {
    return types.includes('null');
  }
  if (Array.isArray(v)) {
    return types.includes('array');
  }
  if (typeof v === 'number') {
    return types.includes('number') || (types.includes('integer') && Number.isInteger(v));
  }
  return types.includes(typeof v);
}

/**
 * 按字段挽救（修复阶梯的第 4 级）：在完整 schema 的约束下保留能保留的部分。
 * 数组中不合格的条目删除、超出 maxItems 的截断；超长字符串截断；缺失或不合格的可空字段置 null；
 * 多余字段删除。必填且不可空的字段无法挽救时整体失败。每处修改写入 notes。
 */
export function salvage(schema: Json, value: unknown, notes: string[], path = ''): Salvaged {
  const types = typesOf(schema);
  const nullable = types.includes('null');
  const fail = (why: string): Salvaged => {
    if (nullable) {
      notes.push(`${path || '/'}：${why}，置为 null`);
      return { ok: true, value: null };
    }
    return { ok: false, value };
  };
  if (value === undefined) {
    return types.includes('array') ? (notes.push(`${path}：缺失，补为空数组`), { ok: true, value: [] }) : fail('缺失');
  }
  if (!typeMatches(types, value)) {
    return fail(`类型不符（${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}）`);
  }
  if (value === null) {
    return { ok: true, value };
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    return fail(`取值 ${JSON.stringify(value).slice(0, 80)} 不在枚举中`);
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      return fail(`取值 ${JSON.stringify(value).slice(0, 80)} 不符合格式`);
    }
    const max = schema.maxLength as number | undefined;
    if (max !== undefined && [...value].length > max) {
      notes.push(`${path}：超过 ${max} 个字符，已截断`);
      return { ok: true, value: [...value].slice(0, max).join('') };
    }
    return { ok: true, value };
  }
  if (Array.isArray(value)) {
    const item = schema.items as Json;
    const kept: unknown[] = [];
    value.forEach((v, i) => {
      const before = notes.length;
      const r = salvage(item, v, notes, `${path}[${i}]`);
      if (r.ok) {
        kept.push(r.value);
      } else {
        notes.splice(before);
        notes.push(`${path}[${i}]：条目不合格，已删除`);
      }
    });
    const max = schema.maxItems as number | undefined;
    if (max !== undefined && kept.length > max) {
      notes.push(`${path}：超过 ${max} 条，删除末尾 ${kept.length - max} 条`);
      kept.splice(max);
    }
    const min = (schema.minItems as number | undefined) ?? 0;
    if (kept.length < min) {
      return fail(`有效条目少于 ${min} 条`);
    }
    return { ok: true, value: kept };
  }
  if (typeof value === 'object') {
    const props = (schema.properties as Json | undefined) ?? {};
    const out: Json = {};
    for (const extra of Object.keys(value).filter((k) => !(k in props))) {
      notes.push(`${path}/${extra}：多余字段，已删除`);
    }
    for (const [name, child] of Object.entries(props)) {
      const r = salvage(child as Json, (value as Json)[name], notes, `${path}/${name}`);
      if (!r.ok) {
        return fail(`字段 ${name} 无法挽救`);
      }
      out[name] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}
