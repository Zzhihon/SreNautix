import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptFeishu, feishuSignature, verifyFeishuSignature } from '../../src/channels/feishu/crypto.js';
import { ButtonSigner } from '../../src/channels/feishu/render.js';
import { feishuButtonKey } from '../../src/notify/index.js';

/** 向量由 openssl 与 shasum 独立生成，见夹具文件的 source。 */
const v = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/feishu/signature-vectors.json'), 'utf8'),
) as {
  official_decrypt: { encrypt_key: string; encrypt: string; plaintext: string };
  encrypt_key: string;
  app_secret: string;
  button: { short_id: string; signature: string };
  card_action: { headers: Record<string, string>; body: string; plaintext: string };
  url_verification: { headers: Record<string, string>; body: string; plaintext: string };
};

describe('飞书加密与签名向量', () => {
  it('开放平台文档的解密示例', () => {
    expect(decryptFeishu(v.official_decrypt.encrypt_key, v.official_decrypt.encrypt)).toBe(
      v.official_decrypt.plaintext,
    );
  });

  for (const name of ['card_action', 'url_verification'] as const) {
    const c = v[name];
    it(`${name}：签名与 shasum 一致，解密得到原文`, () => {
      const h = c.headers;
      const body = Buffer.from(c.body, 'utf8');
      expect(feishuSignature(h['X-Lark-Request-Timestamp']!, h['X-Lark-Request-Nonce']!, v.encrypt_key, body)).toBe(
        h['X-Lark-Signature'],
      );
      expect(
        verifyFeishuSignature(
          {
            timestamp: h['X-Lark-Request-Timestamp'],
            nonce: h['X-Lark-Request-Nonce'],
            signature: h['X-Lark-Signature'],
          },
          v.encrypt_key,
          body,
        ),
      ).toBe(true);
      expect(decryptFeishu(v.encrypt_key, (JSON.parse(c.body) as { encrypt: string }).encrypt)).toBe(c.plaintext);
    });

    it(`${name}：篡改请求体、时间戳或密钥后签名不通过`, () => {
      const h = c.headers;
      const ok = {
        timestamp: h['X-Lark-Request-Timestamp'],
        nonce: h['X-Lark-Request-Nonce'],
        signature: h['X-Lark-Signature'],
      };
      expect(verifyFeishuSignature(ok, v.encrypt_key, Buffer.from(`${c.body} `))).toBe(false);
      expect(verifyFeishuSignature({ ...ok, timestamp: '1792400001' }, v.encrypt_key, Buffer.from(c.body))).toBe(false);
      expect(verifyFeishuSignature(ok, 'other key', Buffer.from(c.body))).toBe(false);
      expect(verifyFeishuSignature({ ...ok, signature: undefined }, v.encrypt_key, Buffer.from(c.body))).toBe(false);
      expect(verifyFeishuSignature({ ...ok, signature: 'zz' }, v.encrypt_key, Buffer.from(c.body))).toBe(false);
    });
  }

  it('按钮回调值的 HMAC 与 openssl 计算的一致，篡改后不通过', () => {
    const s = new ButtonSigner(feishuButtonKey(v.app_secret));
    expect(s.sign(v.button.short_id)).toBe(v.button.signature);
    expect(s.verify({ k: v.button.short_id, s: v.button.signature })).toBe(v.button.short_id);
    expect(s.verify({ k: v.button.short_id, s: 'AAAAAAAAAAAAAAAA' })).toBeNull();
    expect(s.verify({ k: 'Gsh0rtIdAbCdEf12', s: v.button.signature })).toBeNull();
    expect(s.verify('Fsh0rtIdAbCdEf12')).toBeNull();
    expect(
      new ButtonSigner(feishuButtonKey('rotated')).verify({ k: v.button.short_id, s: v.button.signature }),
    ).toBeNull();
  });

  it('密文长度不合法时失败', () => {
    expect(() => decryptFeishu('test key', 'AAAA')).toThrow(/长度不合法/);
  });
});
