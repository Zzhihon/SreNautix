import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONDITION_DIRECTIONS } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';

// 状态条件的方向表只有一份（contract/conditions.json）：chart 的自身告警读 files/conditions.json，
// 它必须是契约文件的逐字节副本；生成的 CONDITION_DIRECTIONS 与契约文件内容相同
const ROOT = resolve(import.meta.dirname, '../../../..');

describe('状态条件方向表', () => {
  it('chart 的副本与契约逐字节相同', () => {
    expect(readFileSync(resolve(ROOT, 'deploy/helm/srenautix/files/conditions.json'), 'utf8')).toBe(
      readFileSync(resolve(ROOT, 'contract/conditions.json'), 'utf8'),
    );
  });

  it('生成的常量与契约文件一致', () => {
    const raw = JSON.parse(readFileSync(resolve(ROOT, 'contract/conditions.json'), 'utf8')) as Record<string, unknown>;
    delete raw.$schema;
    expect(CONDITION_DIRECTIONS).toEqual(raw);
  });
});
