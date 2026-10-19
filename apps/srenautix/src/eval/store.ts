import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { assertValid, type EvalCase, type EvalSnapshot } from '@srenautix/contract';

// 用例目录（命令行评测与导入器使用）：
//   <dir>/cases/<case_id 编码>.json            EvalCase，按 version 取最大
//   <dir>/snapshots/<snapshot_id>.json.zst     EvalSnapshot（zstd 压缩的 JSON；.json 也可读）
// server 的 eval_cases / eval_results 表与这里同形，控制台提升用例时由 server 写入。

export class CaseStore {
  constructor(readonly dir: string) {}

  private caseDir(): string {
    return join(this.dir, 'cases');
  }

  private snapDir(): string {
    return join(this.dir, 'snapshots');
  }

  writeCase(c: EvalCase): void {
    assertValid<EvalCase>('schemas/eval-case.schema.json', c);
    mkdirSync(this.caseDir(), { recursive: true });
    writeFileSync(
      join(this.caseDir(), `${encodeURIComponent(c.case_id)}@${c.version}.json`),
      `${JSON.stringify(c, null, 1)}\n`,
    );
  }

  writeSnapshot(s: EvalSnapshot): void {
    assertValid<EvalSnapshot>('schemas/eval-snapshot.schema.json', s);
    mkdirSync(this.snapDir(), { recursive: true });
    writeFileSync(join(this.snapDir(), `${s.snapshot_id}.json.zst`), zstdCompressSync(Buffer.from(JSON.stringify(s))));
  }

  /** 全部用例的最新版本，按 case_id 排序 */
  cases(suite?: string): EvalCase[] {
    if (!existsSync(this.caseDir())) {
      return [];
    }
    const latest = new Map<string, EvalCase>();
    for (const f of readdirSync(this.caseDir()).filter((x) => x.endsWith('.json'))) {
      const c = assertValid<EvalCase>(
        'schemas/eval-case.schema.json',
        JSON.parse(readFileSync(join(this.caseDir(), f), 'utf8')),
      );
      const prev = latest.get(c.case_id);
      if (!prev || prev.version < c.version) {
        latest.set(c.case_id, c);
      }
    }
    return [...latest.values()]
      .filter((c) => suite === undefined || c.suite === suite)
      .sort((a, b) => a.case_id.localeCompare(b.case_id));
  }

  snapshot(id: string): EvalSnapshot {
    const zst = join(this.snapDir(), `${id}.json.zst`);
    const plain = join(this.snapDir(), `${id}.json`);
    const text = existsSync(zst) ? zstdDecompressSync(readFileSync(zst)).toString('utf8') : readFileSync(plain, 'utf8');
    return assertValid<EvalSnapshot>('schemas/eval-snapshot.schema.json', JSON.parse(text));
  }
}
