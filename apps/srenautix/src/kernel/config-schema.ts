// 配置 schema 的基础写法：各模块的配置段（notify、changes、detectors 等）与 server 的总配置共用
import { z } from 'zod';

export const duration = z.string().regex(/^\d+(ms|s|m|h|d)$/, '时长形如 30s、5m、12h');
export const url = z.string().url();
export const path = z.string().min(1);
export const clusterId = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/);
