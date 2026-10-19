import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCHEMAS } from '@srenautix/contract';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

/** reader 协议文件所在目录（contract/gateway/v1），镜像内为 /app/contract/gateway/v1。 */
export const DEFAULT_PROTOCOL_DIR = resolve(import.meta.dirname, '../../../../contract/gateway/v1');

const BASE = 'https://srenautix.io/contract/gateway/v1/';
const READER_ID = `${BASE}reader.openapi.yaml`;

const ANNOTATION_KEYWORDS = ['x-srenautix-dynamic-enum', 'x-srenautix-portable', 'x-srenautix-secret-ref'];

/** JSON Pointer 的一段（RFC 6901）。 */
const ptr = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * 中心与 reader 之间的协议（contract/gateway/v1/reader.openapi.yaml）的请求体校验。
 * 两个 OpenAPI 文件按各自的 $id 注册到 Ajv，相对引用（openapi.yaml、../../schemas/...）按 $id 解析；
 * 契约中的全部 JSON Schema 一起注册，拓扑事件等直接复用。
 */
export class ReaderProtocol {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(dir = DEFAULT_PROTOCOL_DIR) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats.default(this.ajv);
    for (const k of ANNOTATION_KEYWORDS) {
      this.ajv.addKeyword({ keyword: k, schemaType: ['string', 'boolean'] });
    }
    for (const s of Object.values(SCHEMAS)) {
      this.ajv.addSchema(s);
    }
    const reader = parseYaml(readFileSync(join(dir, 'reader.openapi.yaml'), 'utf8')) as Record<string, unknown>;
    const ticket = parseYaml(readFileSync(join(dir, 'openapi.yaml'), 'utf8')) as Record<string, unknown>;
    this.ajv.addSchema({ ...ticket, $id: `${BASE}openapi.yaml` });
    this.ajv.addSchema({ ...reader, $id: READER_ID });
  }

  private compiled(ref: string): ValidateFunction {
    let v = this.cache.get(ref);
    if (!v) {
      const got = this.ajv.getSchema(ref);
      if (!got) {
        throw new Error(`reader 协议中没有 ${ref}`);
      }
      v = got;
      this.cache.set(ref, v);
    }
    return v;
  }

  /** components.schemas 中的命名结构。 */
  component(name: string): ValidateFunction {
    return this.compiled(`${READER_ID}#/components/schemas/${ptr(name)}`);
  }

  /** 某个操作的 JSON 请求体。 */
  requestBody(path: string, method: 'post' | 'put'): ValidateFunction {
    return this.compiled(
      `${READER_ID}#/paths/${ptr(path)}/${method}/requestBody/content/${ptr('application/json')}/schema`,
    );
  }

  /** 校验失败时返回错误说明，成功时返回 null。 */
  static errors(v: ValidateFunction): string {
    return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；');
  }
}
