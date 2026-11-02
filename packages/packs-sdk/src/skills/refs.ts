// 清单中的引用（契约 SkillRef，ADR 0181 §3）：恰好一个键的对象 {param}、{input}、{binding}，或 {step, field?}。
// 引用可以出现在 with、when、输出指纹与标签的任意层级，执行时由宿主替换为取到的值；技能里没有表达式语言。

export interface RefScope {
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
  /** 绑定：{id, data}；没有绑定时为 null */
  binding: { id: string; data: Record<string, unknown> } | null;
  /** 已经执行完的步骤的输出 */
  steps: Record<string, unknown>;
}

export type Ref =
  | { kind: 'param'; path: string }
  | { kind: 'input'; path: string }
  | { kind: 'binding'; path: string }
  | { kind: 'step'; step: string; path: string };

/** 值是不是引用；是时返回解析后的引用 */
export function asRef(v: unknown): Ref | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return null;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  if (keys.length === 1 && str('param') !== null) {
    return { kind: 'param', path: str('param')! };
  }
  if (keys.length === 1 && str('input') !== null) {
    return { kind: 'input', path: str('input')! };
  }
  if (keys.length === 1 && str('binding') !== null) {
    return { kind: 'binding', path: str('binding')! };
  }
  if (str('step') !== null && keys.every((k) => k === 'step' || k === 'field') && (keys.length === 1 || str('field'))) {
    return { kind: 'step', step: str('step')!, path: str('field') ?? '' };
  }
  return null;
}

/** 点分路径取值；路径为空时为对象本身，中途缺失时为 undefined */
export function getPath(root: unknown, path: string): unknown {
  if (!path) {
    return root;
  }
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = Array.isArray(cur) && /^[0-9]+$/.test(seg) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function resolveRef(r: Ref, s: RefScope): unknown {
  switch (r.kind) {
    case 'param':
      return getPath(s.params, r.path);
    case 'input':
      return getPath(s.inputs, r.path);
    case 'binding':
      return s.binding ? getPath(s.binding, r.path) : undefined;
    case 'step':
      if (!(r.step in s.steps)) {
        throw new Error(`引用了还没有执行的步骤 ${r.step}`);
      }
      return getPath(s.steps[r.step], r.path);
  }
}

/** 深度替换引用 */
export function resolveRefs(v: unknown, s: RefScope): unknown {
  const r = asRef(v);
  if (r) {
    return resolveRef(r, s);
  }
  if (Array.isArray(v)) {
    return v.map((x) => resolveRefs(x, s));
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, s)]));
  }
  return v;
}

/** 值里出现的全部引用 */
export function collectRefs(v: unknown, out: Ref[] = []): Ref[] {
  const r = asRef(v);
  if (r) {
    out.push(r);
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach((x) => collectRefs(x, out));
  } else if (v && typeof v === 'object') {
    Object.values(v).forEach((x) => collectRefs(x, out));
  }
  return out;
}

/** when 的取值是否成立：true、非空数组、非空字符串、非零数、非空对象 */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) {
    return v.length > 0;
  }
  if (v && typeof v === 'object') {
    return Object.keys(v).length > 0;
  }
  return Boolean(v);
}
