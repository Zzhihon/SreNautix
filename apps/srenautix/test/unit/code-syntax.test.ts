import { describe, expect, it } from 'vitest';
import { matchAny, matchGlob } from '../../src/optimize/code/glob.js';
import { enclosingFunction, languageOf, sourceFacts } from '../../src/optimize/code/syntax.js';

// 代码定位的语法部分（ADR 0146 §3.5）：tree-sitter 取字符串字面量、函数与方法边界（带接收者）、调用点

const GO = `package store

import "context"

const listSQL = \`SELECT id, cost FROM usage_logs
WHERE org_id = $1 AND created_at > $2\`

type UsageStore struct{ db DB }

// ListRecent 读最近的用量
func (s *UsageStore) ListRecent(ctx context.Context, org string) error {
	_, err := s.db.Query(ctx, listSQL, org)
	return err
}

func helper() string {
	return "SELECT 1 FROM \\"t\\""
}
`;

const TS = `import { db } from './db';

export class Billing {
  async total(org: string) {
    return db.query(\`SELECT sum(cost) FROM usage_logs WHERE org_id = \${org}\`);
  }
}

export const poll = async () => {
  await fetchStatus('/v1/status');
};

function plain() {
  return 'cchp.gateway.stage.plan';
}
`;

describe('业务代码的语法树', () => {
  it('Go：字符串字面量（原始与解释型）、方法的接收者、调用点', async () => {
    const f = await sourceFacts('go', GO);
    expect(f.strings.map((s) => s.value)).toEqual([
      'context',
      'SELECT id, cost FROM usage_logs\nWHERE org_id = $1 AND created_at > $2',
      'SELECT 1 FROM "t"',
    ]);
    expect(f.strings[1]).toMatchObject({ startLine: 5, endLine: 6 });
    expect(f.functions).toEqual([
      { name: 'ListRecent', receiver: 'UsageStore', startLine: 11, endLine: 14 },
      { name: 'helper', receiver: null, startLine: 16, endLine: 18 },
    ]);
    expect(f.calls).toContainEqual({ name: 'Query', line: 12 });
    expect(enclosingFunction(f.functions, 12)?.name).toBe('ListRecent');
    expect(enclosingFunction(f.functions, 7)).toBeNull();
  });

  it('TypeScript：模板字符串的插值换成 $1、类方法、箭头函数', async () => {
    const f = await sourceFacts('typescript', TS);
    expect(f.strings.map((s) => s.value)).toContain('SELECT sum(cost) FROM usage_logs WHERE org_id = $1');
    expect(f.strings.map((s) => s.value)).toContain('cchp.gateway.stage.plan');
    expect(f.functions).toEqual(
      expect.arrayContaining([
        { name: 'total', receiver: 'Billing', startLine: 4, endLine: 6 },
        { name: 'poll', receiver: null, startLine: 9, endLine: 11 },
        { name: 'plain', receiver: null, startLine: 13, endLine: 15 },
      ]),
    );
    expect(f.calls).toEqual(
      expect.arrayContaining([
        { name: 'query', line: 5 },
        { name: 'fetchStatus', line: 10 },
      ]),
    );
  });

  it('按扩展名选择语言；声明文件不解析', () => {
    expect(languageOf('internal/a.go')).toBe('go');
    expect(languageOf('web/src/a.ts')).toBe('typescript');
    expect(languageOf('web/src/a.tsx')).toBe('tsx');
    expect(languageOf('web/src/a.d.ts')).toBeNull();
    expect(languageOf('db/q.sql')).toBeNull();
  });
});

describe('路径 glob', () => {
  it('** 匹配零或多层目录，* 不跨越 /，{a,b} 为备选', () => {
    expect(matchGlob('internal/gateway/plan.go', 'internal/**')).toBe(true);
    expect(matchGlob('internal/plan.go', 'internal/**/*.go')).toBe(true);
    expect(matchGlob('internal/a/b/plan.go', 'internal/**/*.go')).toBe(true);
    expect(matchGlob('internal/a/plan.go', 'internal/*.go')).toBe(false);
    expect(matchGlob('a/b_test.go', '**/*_test.go')).toBe(true);
    expect(matchGlob('b_test.go', '**/*_test.go')).toBe(true);
    expect(matchGlob('web/x.tsx', '**/*.{ts,tsx}')).toBe(true);
    expect(matchGlob('web/x.js', '**/*.{ts,tsx}')).toBe(false);
    expect(matchGlob('cfg/.env.local', '**/.env*')).toBe(true);
    expect(matchGlob('a.b/c', 'a?b/c')).toBe(true);
    expect(matchGlob('axb/c', 'a.b/c')).toBe(false);
    expect(matchAny('x/testdata/y.go', ['**/testdata/**', '**/*.pem'])).toBe(true);
  });
});
