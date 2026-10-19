// pack.lock（DESIGN §6.3）：每个包与每个用户层的内容哈希。lock 本身的摘要
// （sha256(JCS(lock))）记录在每次研判和评测里。

import { createHash } from 'node:crypto';
import { assertValid, type PackLock } from '@srenautix/contract';
import canonicalize from 'canonicalize';
import type { LoadedLayer } from './layers.js';
import { packDigest, type LoadedPack } from './load.js';

export class PackLockMismatch extends Error {
  constructor(detail: string) {
    super(`pack.lock 与加载的内容不一致：${detail}`);
    this.name = 'PackLockMismatch';
  }
}

export function computeLock(packs: LoadedPack[], layers: LoadedLayer[]): PackLock {
  const lock: PackLock = {
    api_version: 'srenautix.io/pack-lock/v1',
    packs: [...packs]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((p) => ({
        name: p.name,
        version: p.content.manifest.version,
        source: p.source,
        digest: packDigest(p.files),
      })),
    layers: layers.map((l) => ({ path: l.path, digest: `sha256:${l.sha256}` })),
  };
  return assertValid<PackLock>('schemas/pack.schema.json#/$defs/PackLock', lock);
}

export function lockDigest(lock: PackLock): string {
  const text = canonicalize(lock);
  if (text === undefined) {
    throw new TypeError('pack.lock 无法规范化');
  }
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** 校验加载结果与已提交的 pack.lock 一致：包集合、版本、来源、摘要与层的顺序都必须相同 */
export function verifyLock(expected: PackLock, actual: PackLock): void {
  const a = canonicalize(expected);
  const b = canonicalize(actual);
  if (a === b) {
    return;
  }
  const diff: string[] = [];
  const names = new Set([...expected.packs, ...actual.packs].map((p) => p.name));
  for (const n of [...names].sort()) {
    const e = expected.packs.find((p) => p.name === n);
    const x = actual.packs.find((p) => p.name === n);
    if (!e) {
      diff.push(`多出包 ${n}`);
    } else if (!x) {
      diff.push(`缺少包 ${n}`);
    } else if (canonicalize(e) !== canonicalize(x)) {
      diff.push(`包 ${n}：期望 ${e.version} ${e.digest}，实际 ${x.version} ${x.digest}`);
    }
  }
  if (canonicalize(expected.layers) !== canonicalize(actual.layers)) {
    diff.push(
      `用户层：期望 ${expected.layers.map((l) => l.path).join(', ')}，实际 ${actual.layers.map((l) => l.path).join(', ')}（或内容已变）`,
    );
  }
  throw new PackLockMismatch(diff.join('；'));
}
