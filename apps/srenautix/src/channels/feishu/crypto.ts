import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

/**
 * 飞书事件与卡片回调的安全校验（开放平台“配置 Encrypt Key”“验证签名”）：
 * - 签名：X-Lark-Signature = hex(sha256(X-Lark-Request-Timestamp + X-Lark-Request-Nonce + encrypt_key + 原始请求体))；
 * - 解密：key = sha256(encrypt_key)，AES-256-CBC，base64 解码后前 16 字节为 IV，其余为密文，PKCS#7 填充。
 */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: Buffer): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(timestamp + nonce + encryptKey, 'utf8'), body]))
    .digest('hex');
}

export function verifyFeishuSignature(
  headers: { timestamp: string | undefined; nonce: string | undefined; signature: string | undefined },
  encryptKey: string,
  body: Buffer,
): boolean {
  if (!headers.timestamp || !headers.nonce || !headers.signature || !/^[0-9a-f]{64}$/.test(headers.signature)) {
    return false;
  }
  const want = Buffer.from(feishuSignature(headers.timestamp, headers.nonce, encryptKey, body), 'hex');
  return timingSafeEqual(want, Buffer.from(headers.signature, 'hex'));
}

export function decryptFeishu(encryptKey: string, encrypted: string): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const raw = Buffer.from(encrypted, 'base64');
  if (raw.length < 32 || raw.length % 16 !== 0) {
    throw new Error('飞书加密载荷长度不合法');
  }
  const d = createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16));
  return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
}

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
