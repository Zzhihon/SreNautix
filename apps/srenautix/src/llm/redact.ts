import { createHash } from 'node:crypto';

// 出站文本的脱敏规则（DESIGN §8.4）。规则按顺序执行：先整块的凭证（PEM、JWT、DSN），
// 再带上下文的键值对与各云的 AK 前缀，最后是个人信息（身份证号、银行卡号、手机号）。

export type RedactionKind =
  | 'pem'
  | 'jwt'
  | 'dsn'
  | 'bearer'
  | 'kv_secret'
  | 'cloud_ak'
  | 'api_token'
  | 'cn_id'
  | 'bank_card'
  | 'phone'
  | 'env_literal';

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** 返回替换文本；返回 null 表示这处匹配不是凭证（例如校验位不通过），原样保留 */
  replace(match: RegExpExecArray): string | null;
}

const mark = (kind: RedactionKind) => `[REDACTED:${kind}]`;

/** GB 11643 身份证号校验位 */
export function cnIdChecksumOk(id: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += Number(id[i]) * (weights[i] as number);
  }
  return codes[sum % 11] === (id[17] as string).toUpperCase();
}

/** Luhn 校验（银行卡号） */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const KV_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'secret[_-]?key',
  'secret[_-]?access[_-]?key',
  'access[_-]?key[_-]?secret',
  'access[_-]?key[_-]?id',
  'access[_-]?key',
  'accesskeyid',
  'accesskeysecret',
  'secretid',
  'secretkey',
  'api[_-]?key',
  'apikey',
  'token',
  'auth[_-]?token',
  'access[_-]?token',
  'refresh[_-]?token',
  'private[_-]?key',
  'client[_-]?secret',
  'credentials?',
  'sk',
  'ak',
].join('|');

const RULES: readonly Rule[] = [
  {
    kind: 'pem',
    // 也覆盖 JSON 中以字面 \n 连接的私钥（例如云服务账号的 private_key 字段）
    pattern: /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g,
    replace: () => mark('pem'),
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => mark('jwt'),
  },
  {
    kind: 'dsn',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@"'<>]+):([^\s@/"'<>]+)@/gi,
    replace: (m) => (m[3]?.startsWith('[REDACTED:') ? null : `${m[1]}${m[2]}:${mark('dsn')}@`),
  },
  {
    kind: 'bearer',
    pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/g,
    replace: (m) => `${m[1]} ${mark('bearer')}`,
  },
  {
    kind: 'cloud_ak',
    // AWS、阿里云、腾讯云、火山引擎、Google Cloud 的访问密钥前缀
    pattern:
      /(?<![A-Za-z0-9])(?:(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,24}|AKID[A-Za-z0-9]{13,40}|AKLT[A-Za-z0-9_-]{20,60}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9])/g,
    replace: () => mark('cloud_ak'),
  },
  {
    kind: 'api_token',
    pattern:
      /(?<![A-Za-z0-9])(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g,
    replace: () => mark('api_token'),
  },
  {
    kind: 'kv_secret',
    // 键名在前、值在后：password=xxx、"secret_key": "xxx"、aws_secret_access_key=xxx、AccountKey=xxx；键名可以带前缀段
    pattern: new RegExp(
      `\\b((?:[A-Za-z0-9]+[_-])*(?:${KV_KEYS}|AccountKey|SharedAccessKey|sig))\\b(["']?\\s*[:=]\\s*["']?)([^\\s"'&,;}<>\\]]{6,})`,
      'gi',
    ),
    replace: (m) => (m[3]?.startsWith('[REDACTED:') ? null : `${m[1]}${m[2]}${mark('kv_secret')}`),
  },
  {
    kind: 'cn_id',
    pattern:
      /(?<![0-9])[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9A-Za-z])/g,
    replace: (m) => (cnIdChecksumOk(m[0]) ? mark('cn_id') : null),
  },
  {
    kind: 'bank_card',
    // 只认发卡行号段（银联 62、Visa 4、Mastercard 51–55 与 22–27、JCB 35、Amex 34/37），
    // 避免把纳秒时间戳这类恰好通过 Luhn 校验的长数字当成卡号
    pattern: /(?<![0-9])(?:62|4|5[1-5]|2[2-7]|35|3[47])(?:[ -]?[0-9]){12,17}(?![0-9])/g,
    replace: (m) => {
      const digits = m[0].replace(/[ -]/g, '');
      return digits.length >= 15 && digits.length <= 19 && luhnOk(digits) ? mark('bank_card') : null;
    },
  },
  {
    kind: 'phone',
    pattern: /(?<![0-9])(?:\+?86[- ]?)?1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}(?![0-9])/g,
    replace: () => mark('phone'),
  },
];

/** 规则版本：规则定义的哈希，写入研判清单的 redaction_version */
export const REDACTION_VERSION = `redact-${createHash('sha256')
  .update(RULES.map((r) => `${r.kind}:${r.pattern.source}:${r.pattern.flags}`).join('\n'))
  .digest('hex')
  .slice(0, 12)}`;

export type RedactionHits = Partial<Record<RedactionKind, number>>;

export interface Redacted {
  text: string;
  hits: RedactionHits;
}

export function countHits(hits: RedactionHits): number {
  return Object.values(hits).reduce((a, b) => a + (b ?? 0), 0);
}

export function mergeHits(into: RedactionHits, add: RedactionHits): RedactionHits {
  for (const [k, v] of Object.entries(add) as Array<[RedactionKind, number]>) {
    into[k] = (into[k] ?? 0) + v;
  }
  return into;
}

/** 对一段文本执行全部规则 */
export function redactText(input: string): Redacted {
  const hits: RedactionHits = {};
  let text = input;
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let out = '';
    let last = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const replacement = rule.replace(m);
      if (replacement === null) {
        continue;
      }
      out += text.slice(last, m.index) + replacement;
      last = m.index + m[0].length;
      hits[rule.kind] = (hits[rule.kind] ?? 0) + 1;
    }
    text = out + text.slice(last);
  }
  return { text, hits };
}

/** 在文本中查找仍然存在的凭证；出站前的最后一道检查，结果必须为空 */
export function findSecrets(text: string): RedactionKind[] {
  const found: RedactionKind[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (rule.replace(m) !== null) {
        found.push(rule.kind);
        break;
      }
    }
  }
  return found;
}

/**
 * 剔除 Kubernetes 对象中容器环境变量的字面值（DESIGN §8.4）：env[].value 替换为占位符，
 * valueFrom 只保留引用的名字。用于只读工具返回的对象。
 */
export function stripEnvLiterals(value: unknown, hits: RedactionHits = {}): { value: unknown; hits: RedactionHits } {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v === null || typeof v !== 'object') {
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'env' && Array.isArray(child)) {
        out[k] = child.map((e) => {
          if (e !== null && typeof e === 'object' && 'value' in e) {
            hits.env_literal = (hits.env_literal ?? 0) + 1;
            return { ...(e as Record<string, unknown>), value: mark('env_literal') };
          }
          return walk(e);
        });
      } else {
        out[k] = walk(child);
      }
    }
    return out;
  };
  return { value: walk(value), hits };
}
