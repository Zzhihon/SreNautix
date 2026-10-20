import { parseKey, type ParsedKey } from '@srenautix/core';

/**
 * 解析状态库中已有的组件键：契约 2.8.0 之前写入的键没有对名称段编码（ADR 0034），例如 `ClusterRole:a:b`，
 * 规范解析失败时按旧格式拆分（第一个 ':' 之前为 kind，其后第一个 '/' 之前为 namespace），不让旧数据使读取失败。
 * 新写入的键都是规范编码；informer 下一次对账时旧键的节点以新键重写。
 */
export function parseStoredKey(key: string): ParsedKey {
  try {
    return parseKey(key);
  } catch {
    const i = key.indexOf(':');
    const rest = key.slice(i + 1);
    const j = rest.indexOf('/');
    return j < 0
      ? { kind: key.slice(0, i), namespace: null, name: rest }
      : { kind: key.slice(0, i), namespace: rest.slice(0, j), name: rest.slice(j + 1) };
  }
}
