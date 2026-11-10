// server 配置的 changes 段：变更源、SQL 审计表变更源（ADR 0151）、从拓扑推导的 Kubernetes 发布（ADR 0104）与尚未同步的提交
// （ADR 0161）。config/server.ts 只组装
import { isComponentKey } from '@srenautix/core';
import { z } from 'zod';
import { clusterId, duration } from '../kernel/config-schema.js';
import { pgReadConnection } from '../optimize/config.js';
import { DEFAULT_REVISION_LABELS } from './kubernetes.js';

const changesSource = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    kind: z.literal('github'),
    // 变更所属的集群；不填时为本 server 的 cluster_id
    cluster_id: clusterId.optional(),
    // owner/name
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().min(1).default('main'),
    paths: z
      .array(
        z
          .object({
            prefix: z.string().min(1),
            targets: z.array(z.string().min(1)).min(1),
            kind: z.enum(['rollout', 'config', 'gitops_sync', 'ci_deploy', 'other']),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

// SQL 审计表变更源（ADR 0151）的列名与关系名：只接受小写的普通标识符，SQL 里一律加双引号引用
const sqlIdentifier = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, '列名只能是小写的普通标识符（字母、数字、下划线，不以数字开头）');
const sqlRelation = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/, '关系写成 <schema>.<名称>，两段都是小写的普通标识符');

/**
 * 一组审计记录的声明（ADR 0151）：读取 table 中时间列落在回看窗口内的行，每行是一次运行时配置变更。
 * function 为 true 时 table 是返回审计记录的函数，以回看窗口的起止两个 timestamptz 为参数调用。
 * components 按顺序取第一条匹配的规则决定变更的目标，没有匹配的行不是任何组件的变更
 */
const sqlAuditQuery = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    table: sqlRelation,
    function: z.boolean().default(false),
    // 行的唯一键：change_id 为 <来源 id>:<查询 id>:<键>
    key: sqlIdentifier,
    time: sqlIdentifier,
    object: sqlIdentifier,
    action: sqlIdentifier,
    actor: sqlIdentifier.optional(),
    // 变更之后对象的取值与变更之前的取值：写进版本，并用于判定没有变化与短时间内的往返
    value: sqlIdentifier.optional(),
    previous_value: sqlIdentifier.optional(),
    // 另外写进摘要的列（不可信文本，截断）
    details: z.array(sqlIdentifier).max(8).default([]),
    components: z
      .array(
        z
          .object({
            // 动作或对象取值之一；不写时匹配全部
            match: z
              .object({
                action: z.array(z.string().min(1)).min(1).optional(),
                object: z.array(z.string().min(1)).min(1).optional(),
              })
              .strict()
              .default({}),
            targets: z
              .array(z.string().refine(isComponentKey, '组件键形如 <kind>:<namespace>/<名称> 或 <kind>:<名称>'))
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** 一个业务库上的 SQL 审计表变更源：只读连接（与 optimization.dbstats 同样的写法）加一组查询声明 */
const sqlAuditSource = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    cluster_id: clusterId.optional(),
    connection: pgReadConnection,
    queries: z.array(sqlAuditQuery).min(1),
    // 同一对象在这段时间内改动之后又回到原来的取值，这几次都不算变更（与发布的标签抖动相同，ADR 0142）
    group_within: duration.default('2m'),
  })
  .strict();

/** GitHub App（安装令牌，不用个人令牌）：拓扑覆盖 PR、事件 issue 与 GitHub 变更源共用。 */

/** server 配置的 changes 段 */
export const changesConfig = z
  .object({
    sources: z.array(changesSource).default([]),
    // SQL 审计表变更源（ADR 0151）：业务库里运行时配置的审计记录作为 runtime_config 变更；默认没有，不连接任何业务库
    sql_audit: z.array(sqlAuditSource).default([]),
    interval: duration.default('60s'),
    // 首次同步与每次同步回看的时长（与上一次同步重叠，按 change_id 去重）
    lookback: duration.default('24h'),
    // 从拓扑事件推导 Kubernetes 的发布（ADR 0104）：工作负载的版本标签变化与新的 ReplicaSet
    kubernetes: z
      .object({
        enabled: z.boolean().default(true),
        // 表示版本的标签；默认 app.kubernetes.io/version、helm.sh/chart，可追加，例如 cchp.io/release-id
        revision_labels: z.array(z.string().min(1)).default([...DEFAULT_REVISION_LABELS]),
        // 这段时间内同一版本或同一个管理应用的变化合成一次发布
        group_within: duration.default('2m'),
        // informer 空窗时（重启、断连、刚安装）从证据数据源的 kube-state-metrics 推导拓扑里没有的发布（ADR 0104 §11）
        ksm_fallback: z.boolean().default(true),
        // 发布之前的 Job 按这些标签的取值关联到发布（ADR 0104 §13）：Job 上的取值等于发布新 ReplicaSet 或工作负载上的
        // 同名标签时挂上。默认不启用；CCHP 配 cchp.io/release-id
        pre_step_labels: z.array(z.string().min(1)).default([]),
        // 工作负载被删除或副本缩到 0 并保持是一次退役变更（ADR 0161），从证据数据源的 kube-state-metrics 与 up 序列推导，
        // 带上随之失去目标的抓取 job 与之前合并的 Git 提交
        retirements: z.boolean().default(true),
      })
      .strict()
      .default({
        enabled: true,
        revision_labels: [...DEFAULT_REVISION_LABELS],
        group_within: '2m',
        ksm_fallback: true,
        pre_step_labels: [],
        retirements: true,
      }),
    // 已合并、尚未同步的提交（ADR 0161）：按证据数据源的 argocd_app_info 找出 OutOfSync 的 Argo CD 应用，
    // 从它最后一次 Synced 起合并的、触及它的变更源提交列进应用上的告警所在的事件
    pending_sync: z
      .object({
        enabled: z.boolean().default(true),
        // 往前找最后一次 Synced 的范围；更早就一直未同步时，取这个范围内的提交
        lookback: duration.default('72h'),
      })
      .strict()
      .default({ enabled: true, lookback: '72h' }),
  })
  .strict()
  .default({
    sources: [],
    sql_audit: [],
    interval: '60s',
    lookback: '24h',
    kubernetes: {
      enabled: true,
      revision_labels: [...DEFAULT_REVISION_LABELS],
      group_within: '2m',
      ksm_fallback: true,
      pre_step_labels: [],
      retirements: true,
    },
    pending_sync: { enabled: true, lookback: '72h' },
  });
export type ChangesConfig = z.infer<typeof changesConfig>;
export type ChangeSourceConfig = ChangesConfig['sources'][number];
export type SqlAuditSourceConfig = ChangesConfig['sql_audit'][number];
