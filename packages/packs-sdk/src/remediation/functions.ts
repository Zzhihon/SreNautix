// 修复模板专用的 CEL 函数（只注册在模板的环境里，证据卡不可用）：
// - digest(s)：取出 sha256:<64 位十六进制>，没有时为空字符串（镜像引用与 kube-state-metrics 的 image_id 写法不同，按 digest 比较）；
// - field(doc, path)：按点路径读文档中的值，不存在为 null；
// - mem_bytes(q)：Kubernetes 内存数量（128974848、129e6、129M、123Mi 等）换算为字节；
// - cpu_cores(q)：CPU 数量（0.5、500m）换算为核；
// - mebibytes(n)：字节数向上取整为 <n>Mi；millicores(n)：核数向上取整为 <n>m；
// - component_ref(k)：组件键（Deployment:shop/api）解析为 {kind, namespace, name}；
// - seconds(d)：Prometheus 时长（30m、1h30m）换算为秒；
// - kebab(s)：驼峰名转为 kebab-case，用于生成告警目录条目 id。

import type { Environment } from '@marcbachmann/cel-js';
import { readPath } from './path.js';

const SUFFIX: Record<string, number> = {
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

export function quantityBytes(q: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?(?:[eE][0-9]+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) {
    throw new TypeError(`不是 Kubernetes 内存数量：${q}`);
  }
  return Number(m[1]) * SUFFIX[m[2] ?? '']!;
}

export function quantityCores(q: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(m)?$/.exec(q.trim());
  if (!m) {
    throw new TypeError(`不是 Kubernetes CPU 数量：${q}`);
  }
  return m[2] ? Number(m[1]) / 1000 : Number(m[1]);
}

function plain(v: unknown): unknown {
  if (v instanceof Map) {
    return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), plain(x)]));
  }
  if (Array.isArray(v)) {
    return v.map(plain);
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  return v;
}

export function registerRemediationFunctions(env: Environment): Environment {
  return env
    .registerFunction('digest(string): string', (s: string) => /sha256:[0-9a-f]{64}/.exec(s)?.[0] ?? '')
    .registerFunction('field(dyn, string): dyn', (doc: unknown, path: string) => readPath(plain(doc), path))
    .registerFunction('mem_bytes(string): double', (q: string) => quantityBytes(q))
    .registerFunction('cpu_cores(string): double', (q: string) => quantityCores(q))
    .registerFunction('mebibytes(double): string', (n: number) => `${Math.ceil(n / 2 ** 20)}Mi`)
    .registerFunction('millicores(double): string', (n: number) => `${Math.ceil(n * 1000)}m`)
    .registerFunction('component_ref(string): map', (k: string) => componentRef(k))
    .registerFunction('seconds(string): double', (d: string) => durationSecondsOf(d))
    .registerFunction('kebab(string): string', (s: string) => kebabOf(s));
}

/** 组件键（契约 ComponentKey，ADR 0034）→ {kind, namespace, name}；名称段的 %XX 按 UTF-8 解码 */
export function componentRef(key: string): Map<string, string | null> {
  const m =
    /^([A-Za-z][A-Za-z0-9.-]*):(?:([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\/)?((?:[A-Za-z0-9._-]|%[0-9A-F]{2})+)$/.exec(key);
  if (!m) {
    throw new TypeError(`不是组件键：${key}`);
  }
  return new Map<string, string | null>([
    ['kind', m[1]!],
    ['namespace', m[2] ?? null],
    ['name', decodeURIComponent(m[3]!)],
  ]);
}

const DURATION_UNIT: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };

/** Prometheus 时长（30m、1h30m、2d）换算为秒 */
export function durationSecondsOf(d: string): number {
  const parts = [...d.trim().matchAll(/([0-9]+)(ms|s|m|h|d|w|y)/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== d.trim()) {
    throw new TypeError(`不是 Prometheus 时长：${d}`);
  }
  return parts.reduce((a, p) => a + Number(p[1]) * DURATION_UNIT[p[2]!]!, 0);
}

/** 告警名等驼峰名转为 kebab-case 的条目 id：KubeHpaMaxedOut → kube-hpa-maxed-out，CCHPImageBelowCompatFloor → cchp-image-below-compat-floor */
export function kebabOf(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** CEL 结果转成可写入文件的普通 JS 值（Map → 对象，bigint → number） */
export const toPlain = plain;
