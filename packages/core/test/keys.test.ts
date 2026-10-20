import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ComponentKeyError, displayKey, isComponentKey, MAX_KEY_LENGTH, nodeKey, parseKey } from '../src/keys.js';

/** contract/testvectors/component-keys.json（ADR 0034）：Go 的 reader 与 TS 对每个用例给出相同的结果。 */
const V = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../contract/testvectors/component-keys.json'), 'utf8'),
) as {
  max_length: number;
  keys: Array<{ name: string; kind: string; namespace: string | null; object_name: string; key: string }>;
  rejected_objects: Array<{ name: string; kind: string; namespace: string | null; object_name: string }>;
  rejected_keys: Array<{ name: string; key: string }>;
};

describe('ComponentKey 编码', () => {
  it('长度上限与契约一致', () => {
    expect(MAX_KEY_LENGTH).toBe(V.max_length);
  });

  it.each(V.keys.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(nodeKey(c.kind, c.namespace, c.object_name)).toBe(c.key);
    expect(parseKey(c.key)).toEqual({ kind: c.kind, namespace: c.namespace, name: c.object_name });
    expect(isComponentKey(c.key)).toBe(true);
  });

  it.each(V.rejected_objects.map((c) => [c.name, c] as const))('对象 %s 编码报错', (_n, c) => {
    expect(() => nodeKey(c.kind, c.namespace, c.object_name)).toThrow(ComponentKeyError);
  });

  it.each(V.rejected_keys.map((c) => [c.name, c] as const))('键 %s 解析报错', (_n, c) => {
    expect(() => parseKey(c.key)).toThrow(ComponentKeyError);
    expect(isComponentKey(c.key)).toBe(false);
  });

  it('孤立的代理项报错', () => {
    expect(() => nodeKey('ClusterRole', null, 'a\uD800b')).toThrow(/孤立的代理项/);
    expect(() => nodeKey('ClusterRole', null, '\uDC00')).toThrow(ComponentKeyError);
  });

  it('键匹配契约的正则', () => {
    const re = /^[A-Za-z][A-Za-z0-9.-]*:([a-z0-9]([-a-z0-9]*[a-z0-9])?\/)?([A-Za-z0-9._-]|%[0-9A-F]{2})+$/;
    for (const c of V.keys) {
      expect(c.key).toMatch(re);
    }
  });

  it('展示用的名称解码名称段，键本身保持编码', () => {
    expect(displayKey('ClusterRole:cert-manager-controller-approve%3Acert-manager-io')).toBe(
      'ClusterRole:cert-manager-controller-approve:cert-manager-io',
    );
    expect(displayKey('Role:ops/%E8%BF%90%E7%BB%B4')).toBe('Role:ops/运维');
    expect(displayKey('Deployment:app/api')).toBe('Deployment:app/api');
    expect(displayKey('ClusterRole:a:b')).toBe('ClusterRole:a:b');
  });
});
