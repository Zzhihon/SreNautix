// 仓库路径的 glob（ADR 0146 §3.5 的包含、排除与锚点规则）：`**` 匹配任意层目录（含零层），`*` 与 `?` 不跨越 `/`，
// `{a,b}` 为备选，其余字符按字面匹配。路径一律是相对仓库根、以 `/` 分隔、没有前导 `/`。

const cache = new Map<string, RegExp>();

function escape(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function translate(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 匹配零或多层目录；结尾的 `**` 匹配其余全部
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) {
        out += '\\{';
        continue;
      }
      const alts = glob.slice(i + 1, end).split(',');
      out += `(?:${alts.map(translate).join('|')})`;
      i = end;
    } else {
      out += escape(ch);
    }
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    re = new RegExp(`^${translate(glob.replace(/^\/+/, ''))}$`);
    cache.set(glob, re);
  }
  return re;
}

export function matchGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

export function matchAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(path, g));
}
