import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** 读取挂载的密钥文件，去掉首尾空白；文件不可读或为空时抛出 ConfigError。 */
export function readSecretFile(what: string, path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`${what} 指向的文件不可读：${path}（${(e as Error).message}）`);
  }
  const v = text.trim();
  if (!v) {
    throw new ConfigError(`${what} 指向的文件为空：${path}`);
  }
  return v;
}

/** 读取 PEM 证书文件。 */
export function readPemCert(what: string, path: string): string {
  const v = readSecretFile(what, path);
  if (!v.includes('-----BEGIN CERTIFICATE-----')) {
    throw new ConfigError(`${what} 指向的文件不是 PEM 证书：${path}`);
  }
  return v;
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const UNIT: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30s`、`5m`、`12h` 这类时长，返回毫秒。 */
export function parseDuration(what: string, raw: string): number {
  const m = DURATION.exec(raw.trim());
  if (!m) {
    throw new ConfigError(`${what} 必须是形如 30s、5m、12h 的时长：${raw}`);
  }
  return Number(m[1]) * (UNIT[m[2] as string] as number);
}

export interface ListenAddr {
  host: string | undefined;
  port: number;
}

/** `:8080`、`0.0.0.0:8080` 这类监听地址。 */
export function parseListen(what: string, raw: string): ListenAddr {
  const m = /^(.*):(\d{1,5})$/.exec(raw);
  const port = m ? Number(m[2]) : NaN;
  if (!m || port < 1 || port > 65535) {
    throw new ConfigError(`${what} 必须是 [host]:port：${raw}`);
  }
  const host = m[1] ? (m[1] as string).replace(/^\[(.*)\]$/, '$1') : undefined;
  return { host, port };
}

/** http(s) URL，去掉末尾的斜杠。 */
export function parseHttpUrl(what: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${what} 不是合法 URL：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConfigError(`${what} 只接受 http/https：${raw}`);
  }
  return raw.replace(/\/+$/, '');
}
