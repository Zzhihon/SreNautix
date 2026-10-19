// CEL 表达式的静态成本上界。输入大小有硬上限（每个引用最多 MAX_SERIES 条序列、
// 每条序列最多 MAX_POINTS 个点，超出部分在进入 CEL 前截断），因此按 AST 可以算出
// 最坏情况下的求值步数。超过 COST_BUDGET 的表达式在加载时拒绝。

export const MAX_SERIES = 200;
export const MAX_POINTS = 1500;
export const MAX_LOG_LINES = 200;
export const COST_BUDGET = 20_000_000;

interface Node {
  op: string;
  args: unknown;
}

const LINEAR_FUNCS = new Set([
  'max',
  'min',
  'last',
  'sum',
  'count',
  'none',
  'points',
  'transitions',
  'top_share',
  'ratio',
  'first_above',
  'first_below',
]);
const COMPREHENSIONS = new Set(['exists', 'all', 'exists_one', 'map', 'filter']);

const S = MAX_SERIES;
const P = MAX_POINTS;

function isNode(x: unknown): x is Node {
  return typeof x === 'object' && x !== null && 'op' in x;
}

function children(n: Node): Node[] {
  const out: Node[] = [];
  const visit = (x: unknown) => {
    if (isNode(x)) {
      out.push(x);
    } else if (Array.isArray(x)) {
      x.forEach(visit);
    }
  };
  visit(n.args);
  return out;
}

/** 表达式作为列表时的元素数上界 */
function bound(n: Node, refs: ReadonlySet<string>): number {
  if (n.op === 'id' && typeof n.args === 'string' && refs.has(n.args)) {
    return S;
  }
  if (n.op === '.') {
    const field = (n.args as [Node, string])[1];
    if (field === 'values' || field === 'times') {
      return P;
    }
  }
  if (n.op === 'call') {
    const [name] = n.args as [string, Node[]];
    if (name === 'points' || name === 'transitions') {
      return S * P;
    }
    if (name === 'join') {
      return S * S;
    }
  }
  if (n.op === 'rcall') {
    const [name, recv] = n.args as [string, Node, Node[]];
    if (name === 'filter' || name === 'map') {
      return bound(recv, refs);
    }
  }
  if (n.op === 'list') {
    return (n.args as Node[]).length;
  }
  return S * P;
}

export function estimateCost(n: Node, refs: ReadonlySet<string>): number {
  if (n.op === 'rcall') {
    const [name, recv, args] = n.args as [string, Node, Node[]];
    if (COMPREHENSIONS.has(name)) {
      const body = args.slice(1).reduce((a, x) => a + estimateCost(x, refs), 0);
      return 1 + estimateCost(recv, refs) + bound(recv, refs) * body;
    }
  }
  if (n.op === 'call') {
    const [name, args] = n.args as [string, Node[]];
    if (name === 'any_point') {
      return 1 + estimateCost(args[0]!, refs) + S * P * estimateCost(args[2]!, refs);
    }
    const own = LINEAR_FUNCS.has(name) ? S * P : name === 'join' ? S * S : 1;
    return own + args.reduce((a, x) => a + estimateCost(x, refs), 0);
  }
  return 1 + children(n).reduce((a, x) => a + estimateCost(x, refs), 0);
}

/** 表达式引用的全部标识符（含宏引入的迭代变量） */
export function identifiers(n: Node): Set<string> {
  const out = new Set<string>();
  const walk = (x: Node) => {
    if (x.op === 'id' && typeof x.args === 'string') {
      out.add(x.args);
    }
    children(x).forEach(walk);
  };
  walk(n);
  return out;
}
