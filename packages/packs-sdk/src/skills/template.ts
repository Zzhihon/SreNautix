// 技能的输出模板（ADR 0181 §7.3）：Mustache。每个值在渲染时都经 mdSafe 处理，模板里不允许不转义的写法
// （{{{x}}}、{{& x}}）与 partial（{{> x}}）。mdSafe 的结果在普通文本、代码片段与表格单元格中都是安全的：
// 去掉反引号与换行，表格分隔符写成 \|，@ 提及、#编号引用与 Markdown 链接被打断。

import Mustache from 'mustache';

const ZWSP = '​';

/** 控制字符（制表符与换行之外）：按码点去掉 */
const stripControl = (s: string) =>
  [...s]
    .filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127);
    })
    .join('');

/** 把任意值变成可以嵌进 issue Markdown 的一段文字 */
export function mdSafe(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
  return stripControl(s)
    .replace(/[`\r]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/@/g, `@${ZWSP}`)
    .replace(/#(?=[0-9])/g, `#${ZWSP}`)
    .replace(/\]\(/g, `]${ZWSP}(`)
    .replace(/<(?=[a-zA-Z/!])/g, `<${ZWSP}`);
}

export class TemplateError extends Error {
  override name = 'TemplateError';
}

type Token = [string, string, number, number, Token[]?, ...unknown[]];

/** 解析模板并检查只用了允许的写法：变量（转义）、区段、反向区段与注释 */
export function checkTemplate(text: string, where: string): void {
  let tokens: Token[];
  try {
    tokens = Mustache.parse(text) as unknown as Token[];
  } catch (e) {
    throw new TemplateError(`${where}：模板不能解析：${e instanceof Error ? e.message : String(e)}`);
  }
  const walk = (ts: Token[]) => {
    for (const t of ts) {
      const type = t[0];
      if (type === '&' || type === '{') {
        throw new TemplateError(`${where}：不允许不转义的写法 ${t[1]}`);
      }
      if (type === '>') {
        throw new TemplateError(`${where}：不允许 partial ${t[1]}`);
      }
      if (type === '=') {
        throw new TemplateError(`${where}：不允许修改分隔符`);
      }
      if ((type === '#' || type === '^') && Array.isArray(t[4])) {
        walk(t[4]);
      }
    }
  };
  walk(tokens);
}

/** 渲染：值一律经 mdSafe；Mustache 的 HTML 转义不用 */
export function renderTemplate(text: string, view: unknown): string {
  return Mustache.render(text, view, undefined, { escape: mdSafe });
}
