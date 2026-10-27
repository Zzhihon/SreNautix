// 修改定位的比较（ADR 0155）：一个补丁是否改动了某个定位上的内容。server 用它判断旧算法记录的修改（没有记下定位）
// 与新的修改是否针对同一个对象：把旧补丁应用到它的基准内容，比较定位上的值在应用前后是否不同。

import { parseAllDocuments } from 'yaml';
import { getAt, resolvePath } from './path.js';
import type { RemediationLocation } from './plan.js';

/** 文本中每个文档的 JS 值；JSON 按 YAML 1.2 解析（JSON 是它的子集）。空文本没有文档；不能解析时抛出 */
function documents(path: string, text: string): unknown[] {
  if (!text.trim()) {
    return [];
  }
  const docs = parseAllDocuments(text, { uniqueKeys: true });
  if (!Array.isArray(docs)) {
    return [];
  }
  return docs.flatMap((d) => {
    if (d.errors.length) {
      throw new Error(`${path}：无法解析：${d.errors[0]!.message}`);
    }
    return d.contents === null ? [] : [d.toJS({ maxAliasCount: 100 })];
  });
}

/** 定位上的全部值：按 kind、name 选文档（与计划选文档的规则相同），locate 为 null 时取整个文档 */
function valuesAt(docs: unknown[], at: RemediationLocation): unknown[] {
  const out: unknown[] = [];
  for (const js of docs) {
    const d = js as { kind?: unknown; metadata?: { name?: unknown } } | null;
    if (at.kind !== null && d?.kind !== at.kind) {
      continue;
    }
    if (at.name !== null && d?.metadata?.name !== at.name) {
      continue;
    }
    if (at.locate === null) {
      out.push(js);
      continue;
    }
    for (const c of resolvePath(js, at.locate)) {
      out.push(getAt(js, c));
    }
  }
  return out;
}

/** 文件从 before 改为 after 时，定位上的内容是否变化（定位不存在于两侧时为 false） */
export function locationChanged(at: RemediationLocation, before: string, after: string): boolean {
  return (
    JSON.stringify(valuesAt(documents(at.path, before), at)) !== JSON.stringify(valuesAt(documents(at.path, after), at))
  );
}
