// MCP 输出中的不可信文本（DESIGN §16.4、不变量 9）：日志、告警、事件、变更说明与模型生成的文字
// 都从结构化结果中移出，放进 untrusted_text 列表，原位置替换为 {"untrusted_ref": n}。
// 调用方的 Agent 由此能区分 SreNautix 给出的结构化事实与只能作为数据阅读的文本。

export interface UntrustedText {
  ref: number;
  /** JSON Pointer（RFC 6901），指出文本原来的位置 */
  path: string;
  text: string;
}

/** 视为不可信文本的字段名（值为字符串时移出；annotations、labels 这类对象的全部字符串值都移出） */
const TEXT_KEYS = new Set([
  'summary',
  'description',
  'situation',
  'mechanism',
  'text',
  'line',
  'title',
  'rationale',
  'expected_effect',
  'undetermined_reason',
  'message',
  'steps',
  'validation_notes',
  'value',
  'generator_url',
  'detail',
]);
const TEXT_OBJECTS = new Set(['annotations', 'labels', 'say']);
const MAX_TEXT = 2000;

function escapePointer(k: string): string {
  return k.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function separateUntrusted(value: unknown): { data: unknown; untrusted_text: UntrustedText[] } {
  const out: UntrustedText[] = [];
  const take = (text: string, path: string) => {
    const ref = out.length + 1;
    out.push({ ref, path, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text });
    return { untrusted_ref: ref };
  };
  const walk = (v: unknown, path: string, textual: boolean): unknown => {
    if (typeof v === 'string') {
      return textual ? take(v, path) : v;
    }
    if (Array.isArray(v)) {
      return v.map((x, i) => walk(x, `${path}/${i}`, textual));
    }
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        o[k] = walk(child, `${path}/${escapePointer(k)}`, textual || TEXT_KEYS.has(k) || TEXT_OBJECTS.has(k));
      }
      return o;
    }
    return v;
  };
  return { data: walk(value, '', false), untrusted_text: out };
}
