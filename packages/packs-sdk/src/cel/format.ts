// 数值的展示格式。与语言无关，阶段 A 的模板、控制台和卡片表格共用。

export type Unit = 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second';

export function fmtNum(v: number, digits = 2): string {
  if (!Number.isFinite(v)) {
    return String(v);
  }
  if (Number.isInteger(v) && Math.abs(v) < 1e15) {
    return String(v);
  }
  return Number(v.toFixed(digits)).toString();
}

export function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtBytes(v: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let x = Math.abs(v);
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${Math.sign(v) < 0 ? '-' : ''}${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtSecs(v: number): string {
  const a = Math.abs(v);
  if (a >= 86400) {
    return `${(v / 86400).toFixed(1)} d`;
  }
  if (a >= 3600) {
    return `${(v / 3600).toFixed(1)} h`;
  }
  if (a >= 60) {
    return `${(v / 60).toFixed(1)} min`;
  }
  return a >= 1 ? `${v.toFixed(1)} s` : `${Math.round(v * 1000)} ms`;
}

export function formatValue(v: unknown, unit: Unit | undefined): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v !== 'number') {
    throw new TypeError(`无法格式化的值类型：${typeof v}`);
  }
  switch (unit ?? 'none') {
    case 'percent':
      return fmtPct(v);
    case 'ratio':
      return fmtNum(v, 3);
    case 'bytes':
      return fmtBytes(v);
    case 'seconds':
      return fmtSecs(v);
    case 'per_second':
      return `${fmtNum(v)}/s`;
    case 'count':
      return fmtNum(Math.round(v));
    case 'none':
      return fmtNum(v);
  }
}
