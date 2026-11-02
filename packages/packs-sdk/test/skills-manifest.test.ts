import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { compilePackSet } from '../src/pack/compile.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { bindingsFor } from '../src/skills/bindings.js';
import { STEP_KINDS } from '../src/skills/kinds.js';
import { loadSkillDir, SkillLintError } from '../src/skills/manifest.js';
import { asRef, resolveRefs } from '../src/skills/refs.js';
import { checkTemplate, mdSafe, renderTemplate, TemplateError } from '../src/skills/template.js';
import { CATALOG, PACKS, REPO } from './support.js';

// 技能清单的读取与校验（ADR 0181 §2、§6.2，不变量 18）：内置的 oom-rootcause 通过；未知步骤类型、没有声明的能力、
// 不转义的模板写法、引用 needs 之外的步骤、目录中的可执行文件都被拒绝；绑定按技能的 schema 校验，引用的信号必须存在。

const SKILL = join(REPO, 'skills/oom-rootcause');
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

function copy(edit: (m: Record<string, unknown>) => void, extra: Record<string, string> = {}): string {
  const base = join(backendsDir(), 'runs');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'skill-'));
  scratch.push(root);
  const dir = join(root, 'oom-rootcause');
  cpSync(SKILL, dir, { recursive: true });
  const m = parse(readFileSync(join(dir, 'skill.yaml'), 'utf8')) as Record<string, unknown>;
  edit(m);
  writeFileSync(join(dir, 'skill.yaml'), stringify(m));
  for (const [f, body] of Object.entries(extra)) {
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

const load = (dir: string) => loadSkillDir(dir, 'builtin', { hostVersion: '0.2.0' });
const steps = (m: Record<string, unknown>) => m.steps as Array<Record<string, unknown>>;

describe('技能清单', () => {
  it('内置的 oom-rootcause 通过校验，摘要稳定', () => {
    const a = load(SKILL);
    const b = load(SKILL);
    expect(a.manifest.name).toBe('oom-rootcause');
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.digest).toBe(b.digest);
    expect(Object.keys(a.templates).sort()).toEqual([
      'templates/comment.en.md',
      'templates/comment.zh-CN.md',
      'templates/issue.en.md',
      'templates/issue.zh-CN.md',
    ]);
  });

  it('未知的步骤类型被拒绝', () => {
    const dir = copy((m) => {
      steps(m)[0]!.uses = 'shell.exec@v1';
    });
    expect(() => load(dir)).toThrow(/不是宿主支持的类型/);
  });

  it('步骤需要的能力没有在清单中声明时被拒绝', () => {
    const dir = copy((m) => {
      delete (m.capabilities as Record<string, unknown>)['kube.read'];
    });
    expect(() => load(dir)).toThrow(/需要能力 kube.read/);
  });

  it('未知能力不符合契约', () => {
    const dir = copy((m) => {
      (m.capabilities as Record<string, unknown>)['kube.write'] = {};
    });
    expect(() => load(dir)).toThrow(SkillLintError);
  });

  it('引用 needs 之外的步骤被拒绝', () => {
    const dir = copy((m) => {
      const s = steps(m).find((x) => x.id === 'rank')!;
      s.needs = (s.needs as string[]).filter((n) => n !== 'history');
    });
    expect(() => load(dir)).toThrow(/引用的步骤 history 不在 needs 中/);
  });

  it('依赖之后声明的步骤被拒绝（没有环）', () => {
    const dir = copy((m) => {
      steps(m)[0]!.needs = ['publish'];
    });
    expect(() => load(dir)).toThrow(/不存在或声明在它之后/);
  });

  it('模板里不转义的写法被拒绝', () => {
    const dir = copy(() => {}, { 'templates/issue.en.md': 'body {{{steps.rank.headline}}}\n' });
    expect(() => load(dir)).toThrow(/不允许不转义的写法/);
  });

  it('目录里约定之外的文件（脚本）被拒绝', () => {
    const dir = copy(() => {}, { 'run.sh': '#!/bin/sh\necho hi\n' });
    expect(() => load(dir)).toThrow(/只能包含约定的数据文件/);
  });

  it('契约范围不包含宿主的版本时被拒绝', () => {
    const dir = copy((m) => {
      m.contract = '>=3.0.0 <4.0.0';
    });
    expect(() => load(dir)).toThrow(/契约范围/);
  });
});

describe('能力注册表（不变量 18）', () => {
  it('契约的能力只有只读访问与 issue.write，每个步骤类型需要的能力都在其中', () => {
    const schema = JSON.parse(readFileSync(join(REPO, 'contract/schemas/skill.schema.json'), 'utf8')) as {
      $defs: { SkillCapability: { enum: string[] } };
    };
    const caps = schema.$defs.SkillCapability.enum;
    expect(caps.sort()).toEqual(['code.read', 'issue.write', 'kube.read', 'logs.query', 'metrics.query_range']);
    for (const k of STEP_KINDS.values()) {
      for (const c of k.capabilities) {
        expect(caps).toContain(c);
      }
      expect(k.uses).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@v[0-9]+$/);
    }
    // 写入只有 issue.publish
    expect([...STEP_KINDS.values()].filter((k) => k.capabilities.includes('issue.write')).map((k) => k.uses)).toEqual([
      'issue.publish@v1',
    ]);
  });
});

describe('引用与模板', () => {
  it('引用按参数、绑定与步骤输出替换', () => {
    const v = resolveRefs(
      { a: { param: 'x' }, b: [{ binding: 'data.y' }, { step: 's', field: 'z.0' }], c: 3 },
      { params: { x: 1 }, inputs: {}, binding: { id: 'b1', data: { y: 'yy' } }, steps: { s: { z: ['first'] } } },
    );
    expect(v).toEqual({ a: 1, b: ['yy', 'first'], c: 3 });
    expect(asRef({ step: 'x', other: 1 })).toBeNull();
  });

  it('值经 mdSafe：反引号、表格分隔符、提及、编号引用与链接被处理', () => {
    expect(mdSafe('a`b|c @someone #12 [x](http://e) <img>\nnext')).toBe(
      'ab\\|c @​someone #​12 [x]​(http://e) <​img> next',
    );
    expect(renderTemplate('| `{{q}}` |', { q: 'sum(rate(x[5m])) |= "y"' })).toBe('| `sum(rate(x[5m])) \\|= "y"` |');
    expect(() => checkTemplate('{{& raw}}', 't')).toThrow(TemplateError);
    expect(() => checkTemplate('{{> partial}}', 't')).toThrow(TemplateError);
  });
});

describe('绑定', () => {
  it('绑定不符合技能的 schema、引用不存在的信号时被拒绝', async () => {
    const skill = load(SKILL);
    const packs = loadBuiltinPacks(PACKS);
    const set = await compilePackSet(packs, { catalog: CATALOG });
    expect(bindingsFor(set, skill)).toEqual([]);
    const fake = (data: Record<string, unknown>) => {
      const p = set.packs.find((x) => x.name === 'workload')!;
      p.content.skill_bindings = {
        bindings: [
          {
            skill: 'oom-rootcause',
            id: 'api',
            workloads: [{ kind: 'StatefulSet', namespace: 'shop', name: 'api' }],
            data,
          },
        ],
      };
    };
    fake({ runtime: 'go' });
    expect(() => bindingsFor(set, skill)).toThrow(/不符合 oom-rootcause\/binding.schema.json/);
    fake({
      runtime: 'go',
      container: 'api',
      labels: [],
      suspects: [
        { id: 's', title: { en: 's' }, mechanism: { en: 'm' }, series: [{ signal: 'nope/missing', unit: 'bytes' }] },
      ],
      logs: [],
      identifiers: {},
      top_requests: {
        event: 'e',
        by: ['b'],
        columns: [{ field: 'b', title: { en: 'b' } }],
        value_field: 'b',
        group_field: 'o',
        large_bytes: 1,
      },
    });
    expect(() => bindingsFor(set, skill)).toThrow(/信号 nope\/missing 不在加载的领域包中/);
  });
});
