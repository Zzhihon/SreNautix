import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cnIdChecksumOk, findSecrets, luhnOk, redactText, stripEnvLiterals } from '../../src/llm/redact.js';

interface Corpus {
  carriers: string[];
  secrets: Array<{ kind: string; label: string; value: string[]; secret?: string[] }>;
  benign: string[];
}

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/redaction/corpus.json'), 'utf8'),
) as Corpus;

describe('CI 脱敏语料', () => {
  for (const s of corpus.secrets) {
    it(`${s.label}：在所有载体中都被脱敏`, () => {
      const value = s.value.join('');
      const needle = (s.secret ?? s.value).join('');
      for (const c of corpus.carriers) {
        const text = c.replaceAll('{value}', value);
        const r = redactText(text);
        expect(r.text, `${c} → ${r.text}`).not.toContain(needle);
        expect(r.hits[s.kind as keyof typeof r.hits] ?? 0, `${s.kind} 未命中：${r.text}`).toBeGreaterThan(0);
        expect(findSecrets(r.text)).toEqual([]);
      }
    });
  }

  it('PEM 私钥（现场生成，含 JSON 中以字面 \\n 连接的形式）', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const body = privateKey.split('\n')[1] as string;
    for (const text of [privateKey, JSON.stringify({ private_key: privateKey })]) {
      const r = redactText(`config: ${text}`);
      expect(r.text).not.toContain(body);
      expect(r.hits.pem).toBe(1);
    }
  });

  for (const b of corpus.benign) {
    it(`保持原样：${b.slice(0, 40)}`, () => {
      expect(redactText(b).text).toBe(b);
    });
  }
});

describe('校验位', () => {
  it('身份证号与 Luhn', () => {
    expect(cnIdChecksumOk('11010519491231002X')).toBe(true);
    expect(cnIdChecksumOk('110105194912310021')).toBe(false);
    expect(luhnOk('4111111111111111')).toBe(true);
    expect(luhnOk('4111111111111112')).toBe(false);
  });

  it('校验位不通过的 18 位数字不当作身份证号', () => {
    expect(redactText('id=110105194912310021').hits.cn_id).toBeUndefined();
  });
});

describe('环境变量字面值', () => {
  it('env[].value 替换为占位符，valueFrom 保留引用', () => {
    const pod = {
      spec: {
        containers: [
          {
            name: 'api',
            env: [
              { name: 'DB_PASSWORD', value: 'plain-text' },
              { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'api-secret', key: 'token' } } },
            ],
          },
        ],
      },
    };
    const r = stripEnvLiterals(pod);
    expect(JSON.stringify(r.value)).not.toContain('plain-text');
    expect(JSON.stringify(r.value)).toContain('api-secret');
    expect(r.hits.env_literal).toBe(1);
  });
});
