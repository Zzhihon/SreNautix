// 集群状态检测器（ADR 0105）：没有告警规则时也发现卡住的 Pod、停滞的发布、CrashLoop、阻塞驱逐的 PDB 与失败的 Job，
// 合成为 source=detector 的告警进入事件。对象状态由 reader（多集群）或 server 的 informer（单集群）上报
// "*" 为全部命名空间
// 检测间隔
// 同一对象上已有这些告警规则在触发时不再合成（按状态列出告警名；用户层追加）
import { z } from 'zod';
import { duration } from '../kernel/config-schema.js';

/** server 配置的 detectors 段 */
export const detectorsConfig = z
  .object({
    enabled: z.boolean().default(false),
    // "*" 为全部命名空间
    namespaces: z.array(z.string().min(1)).default(['*']),
    exclude_namespaces: z.array(z.string().min(1)).default([]),
    pod_init_after: duration.default('10m'),
    pod_pending_after: duration.default('10m'),
    rollout_stalled_after: duration.default('15m'),
    crash_loop_after: duration.default('5m'),
    pdb_blocked_after: duration.default('10m'),
    job_failed: z.boolean().default(true),
    severity: z.enum(['critical', 'warning', 'info']).default('warning'),
    // 检测间隔
    interval: duration.default('30s'),
    // 同一对象上已有这些告警规则在触发时不再合成（按状态列出告警名；用户层追加）
    equivalent_alerts: z.record(z.string(), z.array(z.string().min(1))).default({}),
  })
  .strict()
  .default({
    enabled: false,
    namespaces: ['*'],
    exclude_namespaces: [],
    pod_init_after: '10m',
    pod_pending_after: '10m',
    rollout_stalled_after: '15m',
    crash_loop_after: '5m',
    pdb_blocked_after: '10m',
    job_failed: true,
    severity: 'warning',
    interval: '30s',
    equivalent_alerts: {},
  });
export type DetectorsConfig = z.infer<typeof detectorsConfig>;
