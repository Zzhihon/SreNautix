export type Level = 'debug' | 'info' | 'warn' | 'error';

export type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = 'info';
let baseFields: Fields = {};

export function configureLog(level: Level, base: Fields): void {
  threshold = level;
  baseFields = base;
}

function serializable(v: unknown): unknown {
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack };
  }
  return v;
}

/** 一行一个 JSON 对象写到 stdout。 */
export function log(level: Level, msg: string, fields: Fields = {}): void {
  if (ORDER[level] < ORDER[threshold]) {
    return;
  }
  const entry: Fields = { time: new Date().toISOString(), level, msg, ...baseFields };
  for (const [k, v] of Object.entries(fields)) {
    entry[k] = serializable(v);
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (msg: string, f?: Fields) => log('debug', msg, f),
  info: (msg: string, f?: Fields) => log('info', msg, f),
  warn: (msg: string, f?: Fields) => log('warn', msg, f),
  error: (msg: string, f?: Fields) => log('error', msg, f),
};
