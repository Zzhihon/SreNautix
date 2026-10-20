// 保留原文格式的文件修改（ADR 0103）：用 yaml 的 CST 位置在原文上替换或插入，未修改的行逐字节不变，
// 补丁只包含真正改动的行。JSON 也按 YAML 1.2 解析（JSON 是它的子集），写回时用 JSON 语法。
// 每次修改后重新解析，确认目标位置的值等于期望值，否则报错，不产生补丁。

import { isMap, isScalar, isSeq, parseAllDocuments, stringify, type Document, type Node } from 'yaml';
import type { Concrete } from './path.js';

export type FileFormat = 'json' | 'yaml';

export interface ParsedFile {
  path: string;
  format: FileFormat;
  text: string;
  docs: Array<{ js: unknown; doc: Document.Parsed }>;
}

export class EditError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}：${detail}`);
    this.name = 'EditError';
  }
}

export function parseFile(path: string, format: FileFormat, text: string): ParsedFile {
  const docs = parseAllDocuments(text, { uniqueKeys: true, keepSourceTokens: false });
  if (!Array.isArray(docs)) {
    throw new EditError(path, '内容为空');
  }
  const out: ParsedFile['docs'] = [];
  for (const d of docs) {
    if (d.errors.length) {
      throw new EditError(path, `无法解析：${d.errors[0]!.message}`);
    }
    if (d.contents === null) {
      continue;
    }
    out.push({ js: d.toJS({ maxAliasCount: 100 }), doc: d });
  }
  if (format === 'json' && out.length !== 1) {
    throw new EditError(path, 'JSON 文件必须恰好是一个文档');
  }
  return { path, format, text, docs: out };
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
}

function plainSafe(s: string): boolean {
  if (s === '' || s !== s.trim() || /[\n:#{}[\],&*!|>'"%@`]/.test(s) || /^[-?]/.test(s)) {
    return false;
  }
  const docs = parseAllDocuments(`k: ${s}\n`);
  if (!Array.isArray(docs) || docs.length !== 1 || docs[0]!.errors.length) {
    return false;
  }
  return (docs[0]!.toJS() as Record<string, unknown>)['k'] === s;
}

function scalarText(value: unknown, format: FileFormat, style: string | undefined, file: string): string {
  if (value === null || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
    throw new EditError(file, `只能写入字符串、数字或布尔值，实际为 ${JSON.stringify(value)}`);
  }
  if (format === 'json' || typeof value !== 'string') {
    return JSON.stringify(value);
  }
  if (style === 'QUOTE_SINGLE') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (style === 'PLAIN' && plainSafe(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function flowText(value: unknown, format: FileFormat): string {
  if (format === 'json') {
    return JSON.stringify(value);
  }
  return stringify(value, { collectionStyle: 'flow', lineWidth: 0, flowCollectionPadding: true }).trim();
}

function reparse(
  file: ParsedFile,
  text: string,
  docIndex: number,
  at: Concrete,
  expect: (v: unknown) => boolean,
): ParsedFile {
  const next = parseFile(file.path, file.format, text);
  if (next.docs.length !== file.docs.length) {
    throw new EditError(file.path, '修改后文档数量变了');
  }
  const got = next.docs[docIndex]!.doc.getIn(at);
  const plain = isScalar(got) ? got.value : ((got as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? got);
  if (!expect(plain)) {
    throw new EditError(file.path, `修改后 ${at.join('.')} 的值不符合期望`);
  }
  return next;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 设置标量值：已有标量原位替换；键不存在时在父映射末尾插入一行（块映射）或一项（流映射、JSON 对象） */
export function setValue(file: ParsedFile, docIndex: number, at: Concrete, value: unknown): ParsedFile {
  const { doc } = file.docs[docIndex]!;
  const text = file.text;
  const node = doc.getIn(at, true) as Node | undefined;
  let next: string;
  if (node !== undefined) {
    if (!isScalar(node) || !node.range) {
      throw new EditError(file.path, `${at.join('.')} 不是标量，模板只修改标量`);
    }
    const [start, end] = node.range;
    next = text.slice(0, start) + scalarText(value, file.format, node.type, file.path) + text.slice(end);
  } else {
    const key = at[at.length - 1];
    if (typeof key !== 'string') {
      throw new EditError(file.path, `${at.join('.')} 不存在`);
    }
    const parent = (at.length === 1 ? doc.contents : doc.getIn(at.slice(0, -1), true)) as Node | undefined;
    if (!isMap(parent) || !parent.range || !parent.items.length) {
      throw new EditError(file.path, `${at.slice(0, -1).join('.') || '文档'} 不是非空映射，不能插入键 ${key}`);
    }
    const keyText = file.format === 'json' ? JSON.stringify(key) : plainSafe(key) ? key : JSON.stringify(key);
    const val = scalarText(value, file.format, 'PLAIN', file.path);
    const last = parent.items[parent.items.length - 1]!;
    const lastValue = (last.value ?? last.key) as Node;
    const firstKey = parent.items[0]!.key as Node;
    if (parent.flow || file.format === 'json') {
      const valueEnd = lastValue.range![1];
      if (file.format === 'json' && !parent.flow) {
        throw new EditError(file.path, 'JSON 对象只能是流映射');
      }
      const ks = firstKey.range![0];
      const multiline = text.slice(parent.range[0], ks).includes('\n');
      const sep = multiline ? `,\n${' '.repeat(ks - lineStart(text, ks))}` : ', ';
      next = text.slice(0, valueEnd) + `${sep}${keyText}: ${val}` + text.slice(valueEnd);
    } else {
      const ks = firstKey.range![0];
      const indent = ' '.repeat(ks - lineStart(text, ks));
      const pos = lineEnd(text, lastValue.range![1] - 1);
      next = text.slice(0, pos) + `\n${indent}${keyText}: ${val}` + text.slice(pos);
    }
  }
  return reparse(file, next, docIndex, at, (v) => same(v, value));
}

/** 向数组末尾追加一项（块序列追加一行流式写法的元素，流序列在右括号前追加） */
export function appendValue(file: ParsedFile, docIndex: number, at: Concrete, value: unknown): ParsedFile {
  const { doc } = file.docs[docIndex]!;
  const text = file.text;
  const node = (at.length ? doc.getIn(at, true) : doc.contents) as Node | undefined;
  if (!isSeq(node) || !node.range) {
    throw new EditError(file.path, `${at.join('.')} 不是数组`);
  }
  const before = node.items.length;
  const item = flowText(value, file.format);
  let next: string;
  if (node.flow || file.format === 'json') {
    const close = text.lastIndexOf(']', node.range[1]);
    if (close < node.range[0]) {
      throw new EditError(file.path, `${at.join('.')} 找不到右括号`);
    }
    if (!before) {
      next = text.slice(0, close) + item + text.slice(close);
    } else {
      const lastItem = node.items[before - 1] as Node;
      const ls = (node.items[0] as Node).range![0];
      const multiline = text.slice(node.range[0], ls).includes('\n');
      const sep = multiline ? `,\n${' '.repeat(ls - lineStart(text, ls))}` : ', ';
      const end = lastItem.range![1];
      next = text.slice(0, end) + sep + item + text.slice(end);
    }
  } else {
    if (!before) {
      throw new EditError(file.path, `${at.join('.')} 是空的块序列`);
    }
    const first = node.items[0] as Node;
    const fs = first.range![0];
    const dash = text.lastIndexOf('-', fs - 1);
    const indent = ' '.repeat(dash - lineStart(text, dash));
    const lastItem = node.items[before - 1] as Node;
    const pos = lineEnd(text, lastItem.range![1] - 1);
    next = text.slice(0, pos) + `\n${indent}- ${item}` + text.slice(pos);
  }
  return reparse(
    file,
    next,
    docIndex,
    at,
    (v) => Array.isArray(v) && v.length === before + 1 && same(v[before], value),
  );
}
