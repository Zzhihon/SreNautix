import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

// 业务代码的语法树（ADR 0146 §3.5）：用 web-tree-sitter 与 Go、TypeScript 语法取出字符串字面量、函数与方法的边界、
// 以及调用点。定位只用语法树，不经过模型。

export type CodeLanguage = 'go' | 'typescript' | 'tsx';

export interface StringLiteral {
  /** 字面量的值（去掉引号；Go 的解释型字符串与 TS 字符串处理常见转义；模板字符串的插值换成 $1） */
  value: string;
  startLine: number;
  endLine: number;
}

export interface FunctionSpan {
  name: string;
  /** Go 方法的接收者类型（去掉指针）；TS 类方法所在的类；函数为 null */
  receiver: string | null;
  startLine: number;
  endLine: number;
}

export interface CallSite {
  /** 被调用的函数或方法名（选择器只取最后一段） */
  name: string;
  line: number;
}

export interface SourceFacts {
  strings: StringLiteral[];
  functions: FunctionSpan[];
  calls: CallSite[];
}

const require = createRequire(import.meta.url);
const WASM: Record<CodeLanguage, string> = {
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
};

let ready: Promise<void> | null = null;
const languages = new Map<CodeLanguage, Language>();

async function language(lang: CodeLanguage): Promise<Language> {
  ready ??= Parser.init();
  await ready;
  let l = languages.get(lang);
  if (!l) {
    l = await Language.load(new Uint8Array(readFileSync(require.resolve(WASM[lang]))));
    languages.set(lang, l);
  }
  return l;
}

export function languageOf(path: string): CodeLanguage | null {
  if (path.endsWith('.go')) {
    return 'go';
  }
  if (path.endsWith('.tsx')) {
    return 'tsx';
  }
  if (/\.(ts|mts|cts)$/.test(path) && !path.endsWith('.d.ts')) {
    return 'typescript';
  }
  return null;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', '`': '`' };

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c);
}

function line(n: Node, end = false): number {
  return (end ? n.endPosition.row : n.startPosition.row) + 1;
}

function lastName(n: Node | null): string | null {
  if (!n) {
    return null;
  }
  switch (n.type) {
    case 'identifier':
    case 'field_identifier':
    case 'property_identifier':
    case 'type_identifier':
    case 'private_property_identifier':
      return n.text;
    case 'selector_expression':
      return lastName(n.childForFieldName('field'));
    case 'member_expression':
      return lastName(n.childForFieldName('property'));
    case 'pointer_type':
    case 'generic_type':
    case 'parenthesized_type':
      return lastName(n.namedChildren.find((c) => c !== null && c.type !== 'type_arguments') ?? null);
    default:
      return null;
  }
}

function goFacts(root: Node): SourceFacts {
  const strings: StringLiteral[] = [];
  for (const n of root.descendantsOfType(['interpreted_string_literal', 'raw_string_literal'])) {
    if (!n) {
      continue;
    }
    const t = n.text;
    strings.push({
      value: n.type === 'raw_string_literal' ? t.slice(1, -1) : unescape(t.slice(1, -1)),
      startLine: line(n),
      endLine: line(n, true),
    });
  }
  const functions: FunctionSpan[] = [];
  for (const n of root.descendantsOfType(['function_declaration', 'method_declaration'])) {
    if (!n) {
      continue;
    }
    const name = n.childForFieldName('name')?.text;
    if (!name) {
      continue;
    }
    let receiver: string | null = null;
    if (n.type === 'method_declaration') {
      const param = n.childForFieldName('receiver')?.namedChildren.find((c) => c?.type === 'parameter_declaration');
      receiver = lastName(param?.childForFieldName('type') ?? null);
    }
    functions.push({ name, receiver, startLine: line(n), endLine: line(n, true) });
  }
  const calls: CallSite[] = [];
  for (const n of root.descendantsOfType('call_expression')) {
    const name = n ? lastName(n.childForFieldName('function')) : null;
    if (n && name) {
      calls.push({ name, line: line(n) });
    }
  }
  return { strings, functions, calls };
}

function tsFacts(root: Node): SourceFacts {
  const strings: StringLiteral[] = [];
  for (const n of root.descendantsOfType(['string', 'template_string'])) {
    if (!n) {
      continue;
    }
    // 模板字符串里嵌套的模板与字符串单独计入；插值换成 $1，规范化语句时与参数等价
    let value: string;
    if (n.type === 'template_string') {
      let s = '';
      for (const c of n.children) {
        if (!c || c.type === '`') {
          continue;
        }
        s += c.type === 'template_substitution' ? '$1' : c.text;
      }
      value = unescape(s);
    } else {
      value = unescape(n.text.slice(1, -1));
    }
    strings.push({ value, startLine: line(n), endLine: line(n, true) });
  }
  const functions: FunctionSpan[] = [];
  const classOf = (n: Node): string | null => {
    for (let p = n.parent; p; p = p.parent) {
      if (p.type === 'class_declaration' || p.type === 'class' || p.type === 'abstract_class_declaration') {
        return p.childForFieldName('name')?.text ?? null;
      }
    }
    return null;
  };
  for (const n of root.descendantsOfType([
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
  ])) {
    if (!n) {
      continue;
    }
    const name = lastName(n.childForFieldName('name')) ?? n.childForFieldName('name')?.text;
    if (!name) {
      continue;
    }
    functions.push({
      name,
      receiver: n.type === 'method_definition' ? classOf(n) : null,
      startLine: line(n),
      endLine: line(n, true),
    });
  }
  // const f = (…) => …、const f = function (…) {…}
  for (const n of root.descendantsOfType('variable_declarator')) {
    const value = n?.childForFieldName('value');
    const name = n?.childForFieldName('name');
    if (
      n &&
      name?.type === 'identifier' &&
      value &&
      (value.type === 'arrow_function' || value.type === 'function_expression')
    ) {
      functions.push({ name: name.text, receiver: null, startLine: line(n), endLine: line(n, true) });
    }
  }
  const calls: CallSite[] = [];
  for (const n of root.descendantsOfType('call_expression')) {
    const name = n ? lastName(n.childForFieldName('function')) : null;
    if (n && name) {
      calls.push({ name, line: line(n) });
    }
  }
  return { strings, functions, calls };
}

/** 解析一个源文件；语法错误的部分照常跳过（tree-sitter 容错） */
export async function sourceFacts(lang: CodeLanguage, source: string): Promise<SourceFacts> {
  const l = await language(lang);
  const parser = new Parser();
  try {
    parser.setLanguage(l);
    const tree = parser.parse(source);
    if (!tree) {
      return { strings: [], functions: [], calls: [] };
    }
    try {
      return lang === 'go' ? goFacts(tree.rootNode) : tsFacts(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** 包含这一行的最内层函数或方法 */
export function enclosingFunction(functions: readonly FunctionSpan[], lineNo: number): FunctionSpan | null {
  let best: FunctionSpan | null = null;
  for (const f of functions) {
    if (f.startLine <= lineNo && f.endLine >= lineNo && (!best || f.startLine >= best.startLine)) {
      best = f;
    }
  }
  return best;
}
