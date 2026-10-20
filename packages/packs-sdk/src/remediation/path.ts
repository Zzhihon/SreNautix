// 修复模板的点路径（ADR 0103）：段为键名，可带一个选择器：
// - name[key=value]：数组中 key 字段等于 value 的元素（value 可加双引号，内容按字符串比较）；
// - name[*]：数组的任一元素，只用于定位，展开为全部元素；
// - name[N]：数组的第 N 个元素。
// 路径在 JS 值（文档的 toJS 结果）上解析为具体的键序列（字符串键与数组下标），再交给文本编辑在原文上修改。

export type Concrete = Array<string | number>;

interface Segment {
  key: string;
  sel: null | { kind: 'match'; field: string; value: string } | { kind: 'any' } | { kind: 'index'; index: number };
}

export class PathError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'PathError';
  }
}

function splitSegments(path: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (const ch of path) {
    if (ch === '"' && depth > 0) {
      quoted = !quoted;
    }
    if (!quoted) {
      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
      } else if (ch === '.' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (depth !== 0 || quoted) {
    throw new PathError(`点路径的括号或引号不配对：${path}`);
  }
  out.push(cur);
  return out;
}

export function parsePath(path: string): Segment[] {
  if (!path) {
    throw new PathError('点路径为空');
  }
  return splitSegments(path).map((raw) => {
    const m = /^([^[\]]*)(?:\[(.*)\])?$/.exec(raw);
    if (!m || (m[1] === '' && m[2] === undefined)) {
      throw new PathError(`点路径的段不合法：${raw}（${path}）`);
    }
    const key = m[1]!;
    const inner = m[2];
    if (inner === undefined) {
      return { key, sel: null };
    }
    if (inner === '*') {
      return { key, sel: { kind: 'any' } };
    }
    if (/^[0-9]+$/.test(inner)) {
      return { key, sel: { kind: 'index', index: Number(inner) } };
    }
    const eq = inner.indexOf('=');
    if (eq <= 0) {
      throw new PathError(`选择器不合法：[${inner}]（${path}）`);
    }
    let value = inner.slice(eq + 1);
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) {
        throw new PathError(`选择器的引号不配对：[${inner}]（${path}）`);
      }
      value = JSON.parse(value) as string;
    }
    return { key, sel: { kind: 'match', field: inner.slice(0, eq), value } };
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析为全部存在的具体路径（选择器 [*] 与 [key=value] 可能展开为多条） */
export function resolvePath(root: unknown, path: string): Concrete[] {
  let current: Array<{ at: Concrete; value: unknown }> = [{ at: [], value: root }];
  for (const seg of parsePath(path)) {
    const next: typeof current = [];
    for (const c of current) {
      let v: unknown = c.value;
      let at = c.at;
      if (seg.key !== '') {
        if (!isObject(v) || !(seg.key in v)) {
          continue;
        }
        v = v[seg.key];
        at = [...at, seg.key];
      }
      if (!seg.sel) {
        next.push({ at, value: v });
        continue;
      }
      if (!Array.isArray(v)) {
        continue;
      }
      const arr = v as unknown[];
      const sel = seg.sel;
      if (sel.kind === 'index') {
        if (sel.index < arr.length) {
          next.push({ at: [...at, sel.index], value: arr[sel.index] });
        }
        continue;
      }
      arr.forEach((el, i) => {
        if (
          sel.kind === 'any' ||
          (isObject(el) && el[sel.field] !== undefined && String(el[sel.field]) === sel.value)
        ) {
          next.push({ at: [...at, i], value: el });
        }
      });
    }
    current = next;
  }
  return current.map((c) => c.at);
}

export function getAt(root: unknown, at: Concrete): unknown {
  let v = root;
  for (const k of at) {
    if (typeof k === 'number') {
      if (!Array.isArray(v)) {
        return undefined;
      }
      v = v[k];
    } else {
      if (!isObject(v)) {
        return undefined;
      }
      v = v[k];
    }
  }
  return v;
}

/** 按点路径读取唯一的值；不存在为 null，展开为多个值时报错 */
export function readPath(root: unknown, path: string): unknown {
  const hits = resolvePath(root, path);
  if (hits.length > 1) {
    throw new PathError(`点路径 ${path} 匹配到 ${hits.length} 个值`);
  }
  return hits.length ? (getAt(root, hits[0]!) ?? null) : null;
}

/** 去掉最后一段（定位文档用的父路径）；只有一段时为 null，表示文档本身 */
export function parentPath(path: string): string | null {
  const segs = splitSegments(path);
  if (segs.length === 1) {
    const s = parsePath(path)[0]!;
    return s.sel ? s.key || null : null;
  }
  return segs.slice(0, -1).join('.');
}

/** 设置值的目标：父路径必须唯一存在；最后一段是键（可以尚不存在）或带下标的已有元素 */
export function resolveSetTarget(root: unknown, path: string): Concrete {
  const segs = parsePath(path);
  const last = segs[segs.length - 1]!;
  const parent = parentPath(path);
  const parents = parent === null ? [[]] : resolvePath(root, parent);
  if (parents.length !== 1) {
    throw new PathError(`点路径 ${path} 的父路径匹配到 ${parents.length} 个位置，需要恰好一个`);
  }
  const p = parents[0]!;
  if (last.sel === null) {
    if (!isObject(getAt(root, p))) {
      throw new PathError(`点路径 ${path} 的父节点不是映射`);
    }
    return [...p, last.key];
  }
  const hits = resolvePath(root, path);
  if (hits.length !== 1) {
    throw new PathError(`点路径 ${path} 匹配到 ${hits.length} 个值，需要恰好一个`);
  }
  return hits[0]!;
}

/** 用 vars 替换 {名字}；值必须是字符串或数字 */
export function substitutePath(path: string, vars: Record<string, unknown>): string {
  return path.replace(/\{([a-z_][a-z0-9_]*)\}/g, (m, name: string) => {
    const v = vars[name];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
      return String(v);
    }
    throw new PathError(`点路径中的 {${name}} 没有字符串或数字值`);
  });
}
