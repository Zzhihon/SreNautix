// 本文件由 packages/contract/scripts/gen.ts 从 contract/ 生成，不要手工修改。
import type { ConditionDirections } from './types.js';

export const CONDITION_DIRECTIONS: ConditionDirections = {
  roles: {
    server: { source: 'condition', healthy: 'false', types: { Frozen: { alert: false } } },
    worker: { source: 'condition', healthy: 'false', types: {} },
    mcp: { source: 'condition', healthy: 'false', types: {} },
    gateway: {
      source: 'gateway_heartbeat',
      healthy: 'True',
      types: {
        AdmissionSelfCheck: { strip_type: 'AdmissionSelfTestFailed' },
        Freeze: { healthy: 'False', alert: false, strip_type: 'Frozen' },
        AuditSink: { strip_type: 'AuditExportLagging' },
        ClockSkew: { strip_type: 'ClockSkew' },
        Leader: { strip_type: null },
        ApiserverThrottled: { healthy: 'False', strip_type: null },
        GitHubBranchProtection: { strip_type: null },
        PolicyLoaded: { strip_type: null },
      },
    },
    reader: {
      source: 'reader_heartbeat',
      healthy: 'True',
      types: {
        InformersFresh: {},
        TunnelConnected: {},
        ClockSkew: {},
        QueryManifest: {},
        Datasource: {},
        AlertReconcile: {},
      },
    },
  },
};
