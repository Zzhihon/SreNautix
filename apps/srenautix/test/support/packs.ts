import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PACKS = resolve(import.meta.dirname, '../../../../packs');

/**
 * 在 dir 下放一份仓库 _example 包的副本，signals.yaml 追加 test/fixtures/packs/memory-ratio-template.yaml 中的查询模板
 * （全局 id _example/memory-ratio）。返回 dir，作为 packs.dirs 使用，并以 only: ['_example'] 加载。
 */
export function exampleWithTemplate(dir: string): string {
  mkdirSync(dir, { recursive: true });
  cpSync(join(PACKS, '_example'), join(dir, '_example'), { recursive: true });
  const signals = join(dir, '_example', 'signals.yaml');
  const template = readFileSync(resolve(import.meta.dirname, '../fixtures/packs/memory-ratio-template.yaml'), 'utf8');
  writeFileSync(signals, `${readFileSync(signals, 'utf8')}${template}`);
  return dir;
}
