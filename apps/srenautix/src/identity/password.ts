import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

/** 本地管理员口令的哈希：`scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`。 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error('本地管理员口令至少 12 个字符');
  }
  const salt = randomBytes(16);
  const h = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function parsePasswordHash(encoded: string): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } {
  const parts = encoded.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('口令哈希必须形如 scrypt$<N>$<r>$<p>$<salt>$<hash>');
  }
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  return {
    n: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const h = parsePasswordHash(encoded);
  const got = await scrypt(password, h.salt, h.hash.length, { N: h.n, r: h.r, p: h.p, maxmem: 128 * h.n * h.r * 2 });
  return got.length === h.hash.length && timingSafeEqual(got, h.hash);
}
