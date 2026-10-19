// 领域包的来源与信任（DESIGN §6.3）：
// - builtin：随 SreNautix 发布的 packs/ 目录；
// - git：以 Git 作为信任来源，来源写成 git+<url>@<commit>；
// - oci：必须有 cosign 签名，拉取前先由 OciPackVerifier 校验签名，来源写成 oci://<ref>@<digest>。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackDir, type LoadedPack } from './load.js';

export function loadBuiltinPacks(root: string, only?: string[]): LoadedPack[] {
  const names = readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory())
    .sort();
  for (const n of only ?? []) {
    if (!names.includes(n)) {
      throw new Error(`内置包中没有 ${n}`);
    }
  }
  return names.filter((n) => !only || only.includes(n)).map((n) => loadPackDir(join(root, n), 'builtin'));
}

/** Git 检出中的用户包：调用方保证目录是 commit 对应的干净检出 */
export function loadGitPack(dir: string, url: string, commit: string): LoadedPack {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Git 来源必须固定到完整的 commit SHA：${commit}`);
  }
  return loadPackDir(dir, `git+${url}@${commit}`);
}
