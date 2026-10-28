import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  assertValid,
  CONTRACT_VERSION,
  ContractViolation,
  REASON_CODE_GROUPS,
  REASON_CODES,
  reasonEntry,
  reasonText,
  SCHEMAS,
  validatorFor,
} from '../src/index.js';

const contractDir = resolve(fileURLToPath(import.meta.url), '../../../../contract');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(fileURLToPath(import.meta.url), '../fixtures', name), 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith('.schema.json') ? [p] : [];
  });
}

describe('版本', () => {
  it('contract/VERSION、OpenAPI 与包版本一致', () => {
    const version = readFileSync(join(contractDir, 'VERSION'), 'utf8').trim();
    const doc = parse(readFileSync(join(contractDir, 'openapi.yaml'), 'utf8')) as { info: { version: string } };
    const pkg = JSON.parse(readFileSync(resolve(contractDir, '../packages/contract/package.json'), 'utf8')) as {
      version: string;
    };
    expect(doc.info.version).toBe(version);
    expect(pkg.version).toBe(version);
    expect(CONTRACT_VERSION).toBe(version);
  });
});

describe('schema 注册', () => {
  it('contract/ 下的每个 schema 都内嵌并在严格模式下编译', () => {
    const files = walk(contractDir).map((p) => relative(contractDir, p));
    expect(Object.keys(SCHEMAS).sort()).toEqual(files.map((f) => `https://srenautix.io/contract/${f}`).sort());
    for (const f of files) {
      const schema = SCHEMAS[`https://srenautix.io/contract/${f}`]!;
      if ('type' in schema || 'oneOf' in schema) {
        expect(() => validatorFor(f)).not.toThrow();
      }
      for (const name of Object.keys((schema.$defs as Record<string, unknown> | undefined) ?? {})) {
        expect(() => validatorFor(`${f}#/$defs/${name}`)).not.toThrow();
      }
    }
  });
});

describe('原因码登记表（ADR 0172）', () => {
  const registry = JSON.parse(readFileSync(join(contractDir, 'reason-codes.json'), 'utf8')) as {
    groups: Record<string, { stage: string }>;
    codes: Array<{ code: string; stage: string; groups: string[] }>;
  };
  const group = (g: string) =>
    registry.codes
      .filter((e) => e.groups.includes(g))
      .map((e) => e.code)
      .sort();
  const schemaEnum = (file: string, pointer: string): string[] => {
    const doc = file.endsWith('.yaml')
      ? (parse(readFileSync(join(contractDir, file), 'utf8')) as unknown)
      : (JSON.parse(readFileSync(join(contractDir, file), 'utf8')) as unknown);
    const node = pointer
      .split('/')
      .slice(1)
      .reduce<unknown>((n, k) => (n as Record<string, unknown>)[k.replaceAll('~1', '/')], doc) as { enum: unknown[] };
    return node.enum.filter((x): x is string => x !== null).sort();
  };

  it('符合登记表的 schema，生成的数据与文件相同', () => {
    expect(() => assertValid('schemas/reason-codes.schema.json', registry)).not.toThrow();
    expect(REASON_CODES).toEqual(registry.codes);
    expect(REASON_CODE_GROUPS).toEqual(registry.groups);
  });

  it('(stage, code) 唯一，分组存在且与原因码同一阶段，每个分组至少有一个原因码', () => {
    const keys = registry.codes.map((e) => `${e.stage}/${e.code}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of registry.codes) {
      for (const g of e.groups) {
        expect(registry.groups[g]?.stage, `${e.stage}/${e.code} 的分组 ${g}`).toBe(e.stage);
      }
    }
    for (const g of Object.keys(registry.groups)) {
      expect(group(g).length, g).toBeGreaterThan(0);
    }
  });

  it('研判失败类型与 ResearchFailed.kind 相同', () => {
    expect(group('research_failure')).toEqual(
      schemaEnum('schemas/events.schema.json', '/$defs/ResearchFailed/properties/payload/properties/kind'),
    );
  });

  it('停止原因与研判输出、研判运行、主动优化输出的 stop_reason 相同', () => {
    expect(group('research_stop')).toEqual(
      schemaEnum('schemas/research-output.schema.json', '/properties/stop_reason'),
    );
    expect(group('research_stop')).toEqual(
      schemaEnum('openapi.yaml', '/components/schemas/ResearchRun/properties/stop_reason'),
    );
    expect(group('research_stop')).toEqual(
      schemaEnum('schemas/optimization-output.schema.json', '/properties/stop_reason'),
    );
  });

  it('错误样例的原因码与 EvidenceResult 的 Samples.code 相同（ADR 0177）', () => {
    expect(group('evidence_samples')).toEqual(
      schemaEnum('schemas/evidence-result.schema.json', '/$defs/Samples/properties/code/oneOf/1'),
    );
  });

  it('通知放弃的原因是渠道永久错误加上编辑次数用完', () => {
    expect(group('notify_abandon')).toEqual([...group('notify_permanent'), 'ended_edit_cap'].sort());
  });

  it('反馈的原因码与 feedback.schema.json 的 ReasonCode 相同，阶段 feedback 只有这一个分组（ADR 0174）', () => {
    expect(group('feedback')).toEqual(schemaEnum('schemas/feedback.schema.json', '/$defs/ReasonCode'));
    const stage = registry.codes
      .filter((e) => e.stage === 'feedback')
      .map((e) => e.code)
      .sort();
    expect(stage).toEqual(group('feedback'));
  });

  it('reasonEntry 只认登记过的原因码', () => {
    expect(reasonEntry('research', 'lease_expired').level).toBe('error');
    expect(reasonText('notify', 'withheld_severity', 'zh')).toBe('不推送：严重度不在推送范围内');
    expect(() => reasonEntry('notify', 'lease_expired')).toThrow(/不在登记表/);
  });
});

describe('黄金夹具', () => {
  it('事件', () => {
    expect(() => assertValid('schemas/incident.schema.json', fixture('incident.valid.json'))).not.toThrow();
  });

  it('事件标签必须取整到 10 分钟', () => {
    const bad = { ...fixture('incident.valid.json'), label: 'Pod:shop/pg-1:2026-10-15T10:21:00Z' };
    expect(() => assertValid('schemas/incident.schema.json', bad)).toThrow(ContractViolation);
  });

  it('研判输出', () => {
    expect(() =>
      assertValid('schemas/research-output.schema.json', fixture('research-output.valid.json')),
    ).not.toThrow();
  });

  it('研判输出的证据引用只能是运行内编号', () => {
    const out = fixture('research-output.valid.json') as { hypotheses: Array<{ supporting: string[] }> };
    out.hypotheses[0]!.supporting = ['card:pg/1'];
    expect(() => assertValid('schemas/research-output.schema.json', out)).toThrow(ContractViolation);
  });

  it('反馈：结论错且根因未知时 root_component 为 null', () => {
    expect(() => assertValid('schemas/feedback.schema.json', fixture('feedback.valid.json'))).not.toThrow();
  });

  it('反馈的渠道必须是已知渠道；github 只用于 server 读到的关闭', () => {
    const bad = { ...fixture('feedback.valid.json'), channel: 'pager' };
    expect(() => assertValid('schemas/feedback.schema.json', bad)).toThrow(ContractViolation);
    const closed = {
      ...fixture('feedback.valid.json'),
      verdict: null,
      disposition_verdict: null,
      reason_code: null,
      channel: 'github',
      principal_id: 'github:alice',
      linked: false,
      implicit: 'pr_closed',
    };
    expect(() => assertValid('schemas/feedback.schema.json', closed)).not.toThrow();
  });

  it('反馈的原因码只能是登记的取值', () => {
    const bad = { ...fixture('feedback.valid.json'), reason_code: 'bad_model' };
    expect(() => assertValid('schemas/feedback.schema.json', bad)).toThrow(ContractViolation);
  });

  it('outbox 事件按 type 区分 payload', () => {
    const header = {
      seq: 12,
      event_id: '9e7f9a52-4f0e-4b64-9e8e-1c2d3e4f5a6b',
      owner: 'server',
      schema_version: '2.0.0',
      cluster_id: 'kind-demo',
      occurred_at: '2026-10-15T10:24:00Z',
    };
    const merged = {
      ...header,
      type: 'incident.merged',
      payload: {
        from_incident_id: '2a7f9a52-4f0e-4b64-9e8e-1c2d3e4f5a6b',
        into_incident_id: '0b7f9a52-4f0e-4b64-9e8e-1c2d3e4f5a6b',
        into_version: 2,
      },
    };
    expect(() => assertValid('schemas/events.schema.json', merged)).not.toThrow();
    const upserted = { ...header, type: 'incident.updated', payload: fixture('incident.valid.json') };
    expect(() => assertValid('schemas/events.schema.json', upserted)).not.toThrow();
    expect(() => assertValid('schemas/events.schema.json', { ...merged, type: 'incident.updated' })).toThrow(
      ContractViolation,
    );
  });
});

/** contract/testvectors/optimization.json：Go 与 TS 对每个用例给出相同的结果（契约 2.28.0） */
describe('主动优化的黄金夹具', () => {
  const vectors = JSON.parse(readFileSync(join(contractDir, 'testvectors/optimization.json'), 'utf8')) as {
    valid: Array<{ name: string; schema: string; instance: unknown }>;
    invalid: Array<{ name: string; schema: string; instance: unknown }>;
  };
  for (const v of vectors.valid) {
    it(`通过：${v.name}`, () => {
      expect(() => assertValid(v.schema, v.instance)).not.toThrow();
    });
  }
  for (const v of vectors.invalid) {
    it(`拒绝：${v.name}`, () => {
      expect(() => assertValid(v.schema, v.instance)).toThrow(ContractViolation);
    });
  }
  it('dbstats 的每个操作都有请求定义，能力名由操作名得到', () => {
    const dbstats = SCHEMAS['https://srenautix.io/contract/integrations/dbstats/v1/dbstats.schema.json'] as {
      $defs: Record<string, { enum?: string[]; oneOf?: Array<{ $ref: string }> }>;
    };
    const ops = dbstats.$defs.Operation!.enum!;
    const requests = dbstats.$defs.Request!.oneOf!.map((r) => {
      const def = dbstats.$defs[r.$ref.split('/').pop()!] as unknown as { properties: { op: { const: string } } };
      return def.properties.op.const;
    });
    expect(requests.sort()).toEqual([...ops].sort());
  });
});

describe('与 contract/gateway 一致', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(contractDir, p), 'utf8'));
  const assertion = read('gateway/v1/approval-assertion.schema.json');
  const proposal = read('schemas/proposal.schema.json');

  it('提议的 level、tier、canon_version 取值与审批断言相同', () => {
    expect(proposal.properties.level.enum).toEqual(assertion.$defs.level.enum);
    expect(proposal.properties.tier.enum).toEqual(assertion.$defs.tier.enum);
    expect(proposal.properties.canon_version.enum).toEqual(assertion.properties.canon_version.enum);
  });

  it('提议绑定的指纹与集群取值规则与审批断言相同', () => {
    const common = read('schemas/common.schema.json');
    expect(common.$defs.Sha256.pattern).toBe(assertion.$defs.sha256.pattern);
    expect(common.$defs.ClusterId.pattern).toBe(assertion.$defs.clusterId.pattern);
  });
});

// DESIGN §8.2：扁平结构；所有字段必填；additionalProperties:false；使用枚举；不使用 oneOf
function portableViolations(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => portableViolations(n, `${path}/${i}`, out));
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  const s = node as Record<string, unknown>;
  for (const k of ['oneOf', 'anyOf', 'allOf', '$ref', 'not', 'if', 'patternProperties']) {
    if (k in s) {
      out.push(`${path}: 不允许 ${k}`);
    }
  }
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes('object') && path !== '') {
    const props = Object.keys((s.properties as Record<string, unknown> | undefined) ?? {});
    if (s.additionalProperties !== false) {
      out.push(`${path}: 对象必须 additionalProperties:false`);
    }
    const required = new Set((s.required as string[] | undefined) ?? []);
    for (const p of props) {
      if (!required.has(p)) {
        out.push(`${path}: 属性 ${p} 必须列入 required`);
      }
    }
  }
  for (const [k, v] of Object.entries(s)) {
    portableViolations(v, `${path}/${k}`, out);
  }
}

describe('可移植 schema 子集', () => {
  const modelDir = join(contractDir, 'model');
  for (const name of readdirSync(modelDir)) {
    it(name, () => {
      const schema = JSON.parse(readFileSync(join(modelDir, name), 'utf8'));
      expect(schema['x-srenautix-portable']).toBe(true);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
      const out: string[] = [];
      portableViolations(schema, '', out);
      expect(out).toEqual([]);
    });
  }
});

describe('OpenAPI 授权分类（不变量 6）', () => {
  const doc = parse(readFileSync(join(contractDir, 'openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  const ops = Object.entries(doc.paths).flatMap(([p, item]) =>
    methods.filter((m) => m in item).map((m) => ({ p, m, op: item[m]! })),
  );

  it('每个操作都声明角色与外部调用方是否可调用', () => {
    const missing = ops
      .filter(({ op }) => !Array.isArray(op['x-srenautix-roles']) || typeof op['x-srenautix-external'] !== 'boolean')
      .map(({ p, m }) => `${m.toUpperCase()} ${p}`);
    expect(missing).toEqual([]);
  });

  it('外部调用方不能审批、拒绝、撤销或反馈', () => {
    const forbidden = ops
      .filter(({ op }) => op['x-srenautix-external'] === true)
      .filter(({ p }) => /\/(approve|reject|undo|feedback)$|\/approvals\//.test(p))
      .filter(({ m }) => m !== 'get')
      .map(({ p, m }) => `${m.toUpperCase()} ${p}`);
    expect(forbidden).toEqual([]);
  });
});
