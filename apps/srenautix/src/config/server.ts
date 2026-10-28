import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError, parseDuration } from './files.js';
import { DEFAULT_REVISION_LABELS } from '../changes/kubernetes.js';
import { DEFAULT_EXTERNAL_LABELS, isComponentKey } from '@srenautix/core';
import { DEFAULT_OPTIMIZATION, optimizationConfig, pgReadConnection } from '../optimize/config.js';
import { NOVELTY_CONFIG_DEFAULT, noveltyConfig } from './novelty.js';
import { alertMatcher, upgradeMatchers, type AlertMatcher } from '../alerts/business-impact.js';
import { logger } from '../log.js';
import type { ExternalRootSettings } from '../notify/external.js';

const duration = z.string().regex(/^\d+(ms|s|m|h|d)$/, '时长形如 30s、5m、12h');
const url = z.string().url();
const path = z.string().min(1);
const clusterId = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/);

const ingestSource = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('alertmanager'),
      token_file: path,
      cluster_id: clusterId.optional(),
    })
    .strict(),
  z
    .object({ id: z.string().min(1), kind: z.literal('grafana'), token_file: path, cluster_id: clusterId.optional() })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('nightingale'),
      token_file: path,
      cluster_id: clusterId.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('generic'),
      token_file: path,
      cluster_id: clusterId.optional(),
      // JSONPath 映射：alerts 选出告警数组，其余字段相对每个告警求值
      mapping: z
        .object({
          alerts: z.string().min(1),
          alertname: z.string().min(1),
          status: z.string().min(1),
          firing_value: z.string().default('firing'),
          starts_at: z.string().min(1),
          ends_at: z.string().optional(),
          labels: z.string().optional(),
          annotations: z.string().optional(),
          severity: z.string().optional(),
          generator_url: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * 托管在 GitHub 上的仓库作为变更源（integrations/github）：经 GitHub App 的安装令牌用 REST API 读取分支上的提交与改动的文件，
 * 按路径前缀映射到拓扑节点。hub 镜像不带 git，通用 git 远端暂不支持（ADR 0096）。
 */
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
const githubApp = z
  .object({
    api_base: url.default('https://api.github.com'),
    app_id: z.string().regex(/^\d+$/),
    installation_id: z.string().regex(/^\d+$/),
    private_key_file: path,
  })
  .strict();

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

// OCI 来源的领域包：固定到 digest，先用 cosign 校验签名（公钥，或 keyless 的证书身份与签发方）再用 oras 拉取
const ociPackSource = z
  .object({
    repository: z.string().min(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'OCI 来源必须固定到 sha256 digest'),
    key_file: path.optional(),
    certificate_identity: z.string().min(1).optional(),
    certificate_oidc_issuer: z.string().min(1).optional(),
    // 跳过透明日志校验；只用于无法访问 Rekor 的离线环境，且必须配合 key_file
    ignore_tlog: z.boolean().default(false),
    // 仓库只提供 HTTP（仅限本机或隔离网络中的仓库）
    plain_http: z.boolean().default(false),
  })
  .strict()
  .refine((s) => Boolean(s.key_file) !== Boolean(s.certificate_identity || s.certificate_oidc_issuer), {
    message: '需要且只能给出 key_file 或 certificate_identity + certificate_oidc_issuer 之一',
  })
  .refine(
    (s) =>
      !(s.certificate_identity || s.certificate_oidc_issuer) || (s.certificate_identity && s.certificate_oidc_issuer),
    {
      message: 'keyless 校验需要同时给出 certificate_identity 与 certificate_oidc_issuer',
    },
  )
  .refine((s) => !s.ignore_tlog || s.key_file, { message: 'ignore_tlog 只能与 key_file 一起使用' });

const telegram = z
  .object({
    enabled: z.boolean().default(false),
    bot_token_file: path,
    api_base: url.default('https://api.telegram.org'),
    chats: z.array(z.object({ id: z.number().int(), language: z.enum(['zh', 'en']).default('zh') }).strict()).min(1),
    // none：只发送和编辑，不接收更新（与其他服务共用同一个 bot 时使用）；webhook：Telegram 推送到 /v1/channels/telegram/webhook；polling：长轮询 getUpdates（选主）
    updates: z.enum(['none', 'webhook', 'polling']).default('none'),
    webhook_secret_file: path.optional(),
    messages_per_minute: z.number().int().min(1).max(30).default(20),
    edit_gap: duration.default('3s'),
  })
  .strict();

// 标签条件：标签名 → 允许的取值（每个键都要满足，取值之一即可）
const labelMatch = z.record(z.string().min(1), z.array(z.string().min(1)).min(1));

const EXTERNAL_ROOTS_DEFAULT = {
  enabled: true,
  period: '1h',
  components: [] as string[],
  alert_labels: {} as Record<string, string[]>,
  business_impact: {
    impact_cards: true,
    within: '30m',
    topology_hops: 6,
  },
};

// 外部上游的周期汇总（ADR 0147）：根因是领域包声明 external 的组件类型（例如模型服务方）、components 列出的组件，
// 或全部成员告警都满足 alert_labels 的事件，不逐条推送、不开 issue，每个周期（按 UTC 对齐，1h 即整点）汇总一条；
// 同时有与这个上游事件相关的业务影响（ADR 0150：notify.business_impact_alerts 定义的业务影响告警（ADR 0166），或
// impact_cards 为 true 时其他事件异常的影响卡，在上游事件开始后 within 之内开始，或组件沿依赖边 topology_hops 跳以内到达
// 上游根因；本事件异常的影响卡）时照常即时推送
const externalRoots = z
  .object({
    enabled: z.boolean().default(true),
    period: duration.default('1h'),
    components: z.array(z.string().min(1)).default([]),
    alert_labels: labelMatch.default({}),
    business_impact: z
      .object({
        impact_cards: z.boolean().default(true),
        within: duration.default('30m'),
        // 0 时不按拓扑判定
        topology_hops: z.number().int().min(0).max(12).default(6),
      })
      .strict()
      .default({ impact_cards: true, within: '30m', topology_hops: 6 }),
  })
  .strict();

export type ExternalRootsConfig = z.infer<typeof externalRoots>;

/**
 * 推送规则中可以复用的两项：推送的严重度与外部上游的周期汇总。server 的 notify 与重建评测的 reconstruct.notify
 * （ADR 0175）同一写法
 */
export const notifySeverities = z.array(z.enum(['critical', 'warning', 'info'])).default(['critical', 'warning']);
export const notifyDigest = z
  .object({ external_roots: externalRoots.default(EXTERNAL_ROOTS_DEFAULT) })
  .strict()
  .default({ external_roots: EXTERNAL_ROOTS_DEFAULT });

/** 重建评测的 reconstruct.notify（ADR 0175）：推送的严重度与外部上游的周期汇总，默认值与 server 相同 */
export const notifyRules = z.object({ severities: notifySeverities, digest: notifyDigest }).strict();
export type NotifyRulesConfig = z.infer<typeof notifyRules>;
export const NOTIFY_RULES_DEFAULT: NotifyRulesConfig = {
  severities: ['critical', 'warning'],
  digest: { external_roots: EXTERNAL_ROOTS_DEFAULT },
};

/** notify.digest.external_roots 与业务影响告警 → 外部上游的分类设置（notify/external.ts 的 ExternalRoots） */
export function externalRootSettings(
  xr: ExternalRootsConfig,
  businessImpactAlerts: readonly AlertMatcher[],
  path = 'notify.digest.external_roots',
): ExternalRootSettings {
  return {
    enabled: xr.enabled,
    periodMs: parseDuration(`${path}.period`, xr.period),
    components: xr.components,
    alertLabels: xr.alert_labels,
    impact: {
      alerts: businessImpactAlerts,
      impactCards: xr.business_impact.impact_cards,
      withinMs: parseDuration(`${path}.business_impact.within`, xr.business_impact.within),
      topologyHops: xr.business_impact.topology_hops,
    },
  };
}

const feishu = z
  .object({
    enabled: z.boolean().default(false),
    api_base: url.default('https://open.feishu.cn'),
    app_id: z.string().min(1),
    app_secret_file: path,
    encrypt_key_file: path.optional(),
    verification_token_file: path,
    chats: z
      .array(z.object({ chat_id: z.string().min(1), language: z.enum(['zh', 'en']).default('zh') }).strict())
      .min(1),
    messages_per_minute: z.number().int().min(1).max(100).default(100),
    messages_per_second: z.number().int().min(1).max(5).default(5),
    edit_gap: duration.default('1s'),
    // 聊天账号与控制台使用同一个飞书身份源时，按 union_id 自动绑定
    auto_link_union_id: z.boolean().default(false),
  })
  .strict();

export const serverConfigSchema = z
  .object({
    cluster_id: clusterId,
    profile: z.enum(['observe', 'standard', 'compliance']).default('standard'),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    public_url: url,
    // 通知与 issue 中证据的链接（ADR 0125）：模板占位符 {query}、{query_json}、{from}、{to}、{from_ms}、{to_ms}、{range}、{revision}
    links: z
      .object({
        metrics_explore_url: url.optional(),
        logs_explore_url: url.optional(),
        alertmanager_url: url.optional(),
        argocd_url: url.optional(),
        git_commit_url: url.optional(),
      })
      .strict()
      .default({}),
    listen: z
      .object({
        api: z.string().default(':8080'),
        metrics: z.string().default(':9090'),
        probes: z.string().default(':8081'),
      })
      .strict()
      .default({ api: ':8080', metrics: ':9090', probes: ':8081' }),
    // 集成清单目录：控制台"集成"页按它列出已配置的集成实例与能力。不填时取与代码同一发布物中的 integrations/
    // （仓库根目录；镜像中为 /app/integrations）
    integrations: z.object({ dir: path.optional() }).strict().default({}),
    // 控制台前端的构建产物（web/console/dist）；--serve=all|console 时由 server 提供
    console: z
      .object({ dir: path.default('/app/web/console/dist') })
      .strict()
      .default({ dir: '/app/web/console/dist' }),
    database: z
      .object({
        password_file: path.default('/etc/srenautix/secrets/db/password'),
        pool_size: z.number().int().min(2).max(64).default(10),
      })
      .strict()
      .default({ password_file: '/etc/srenautix/secrets/db/password', pool_size: 10 }),
    // 事件引擎、调度器与 Telegram 长轮询单活：single 为单副本部署；lease 用 Kubernetes Lease 选主
    leader: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('single') }).strict(),
        z
          .object({
            mode: z.literal('lease'),
            namespace: z.string().min(1),
            name: z.string().default('srenautix-server-leader'),
            duration: duration.default('15s'),
          })
          .strict(),
      ])
      .default({ mode: 'single' }),
    // worker 的内部 API（事件流与研判明细）；server 以 token_file 中的 token 调用
    worker: z.object({ url, token_file: path }).strict().optional(),
    // 各集群 gateway 的生效策略（Git 挂载，与 gateway 同一份内容）
    policies_dir: path.optional(),
    ingest: z
      .object({
        sources: z.array(ingestSource).default([]),
        // 带这个标签的告警是 SreNautix 自身的元告警，接入时丢弃（DESIGN §11）
        self_label: z.string().default('srenautix_self'),
        silence_threshold: duration.default('10m'),
        watchdog_alertname: z.string().default('Watchdog'),
        // Prometheus 的 external labels：Alertmanager 收到的告警带着它们，规则引擎的 ALERTS 不带。计算告警身份与指纹时
        // 去掉，webhook 与对账两条入口才能认出同一条告警（ADR 0117）
        external_labels: z.array(z.string().min(1)).default([...DEFAULT_EXTERNAL_LABELS]),
        reconcile: z
          .object({
            enabled: z.boolean().default(true),
            interval: duration.default('60s'),
            // 两轮完整对账之间读 Alertmanager 补写新增告警的间隔（ADR 0160）：只读 Alertmanager，不读状态库与规则引擎；
            // 0s 关闭；需要 alertmanager_url
            additions_interval: duration.default('5s'),
            alertmanager_url: url.optional(),
            prometheus_url: url.optional(),
            bearer_token_file: path.optional(),
          })
          .strict()
          .default({ enabled: true, interval: '60s', additions_interval: '5s' }),
      })
      .strict()
      .default({
        sources: [],
        self_label: 'srenautix_self',
        silence_threshold: '10m',
        watchdog_alertname: 'Watchdog',
        external_labels: [...DEFAULT_EXTERNAL_LABELS],
        reconcile: { enabled: true, interval: '60s', additions_interval: '5s' },
      }),
    // dirs 下的每个子目录是一个领域包；only 不填时加载除 `_` 开头（示例包）以外的全部包；oci 中的包总是加载
    packs: z
      .object({
        dirs: z.array(path).default([]),
        only: z.array(z.string().min(1)).optional(),
        lock_file: path.optional(),
        oci: z
          .object({
            sources: z.array(ociPackSource).min(1),
            cosign: path.default('cosign'),
            oras: path.default('oras'),
            // 拉取目录（可写的临时卷）；每个来源一个子目录，启动时清空后重新拉取
            cache_dir: path.default('/var/cache/srenautix/packs'),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((p) => p.dirs.length > 0 || p.oci, { message: '至少需要 packs.dirs 或 packs.oci 之一' }),
    datasources: z
      .object({
        prometheus: z
          .object({
            url,
            dialect: z.enum(['promql', 'metricsql']).default('promql'),
            bearer_token_file: path.optional(),
            concurrency: z.number().int().min(1).max(64).default(8),
            timeout: duration.default('10s'),
          })
          .strict(),
        // 日志数据源（Loki，ADR 0177）：证据卡的 logs 引用与错误样例读它；不填时日志能力不可用，
        // 声明 requires 日志能力的包禁用，optional 的卡显示能力缺失
        loki: z
          .object({
            url,
            bearer_token_file: path.optional(),
            // 多租户 Loki 的租户（X-Scope-OrgID）
            tenant: z.string().min(1).optional(),
            // 日志流上的 Kubernetes 标签名，按采集器的命名填写
            labels: z
              .object({
                namespace: z.string().min(1).default('namespace'),
                pod: z.string().min(1).default('pod'),
                container: z.string().min(1).default('container'),
                cluster: z.string().min(1).nullable().default(null),
              })
              .strict()
              .default({ namespace: 'namespace', pod: 'pod', container: 'container', cluster: null }),
            timeout: duration.default('15s'),
          })
          .strict()
          .optional(),
      })
      .strict(),
    topology: z
      .object({
        source: z.enum(['informer', 'reader', 'off']).default('informer'),
        kubeconfig: path.optional(),
        // reader 超过这个时长没有心跳（默认 15 秒一次）视为离线：它上报的条件清除，状态条只显示"reader 离线"
        reader_offline_after: duration.default('60s'),
        // 拓扑历史的保留期（ADR 0144）：每小时删除在这之前已经关闭的行；保留期内任一时刻的拓扑不受影响
        history_retention: duration.default('14d'),
        // 拓扑覆盖文件所在的 Git 挂载目录（每 60 秒重新加载）；不填时没有覆盖规则
        overrides_dir: path.optional(),
        // 控制台为未映射告警开覆盖规则 PR 的仓库（用 github_app 的身份）；不填时该接口返回 503 并说明原因
        override_pr: z
          .object({
            repo: repoName,
            base_branch: z.string().min(1).default('main'),
            // 仓库中覆盖文件的目录（与 overrides_dir 挂载的是同一个目录）
            dir: z.string().min(1).default('srenautix/topology-overrides'),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ source: 'informer', reader_offline_after: '60s', history_retention: '14d' }),
    // 变更源（changes/v1，DESIGN §5 的"30 分钟内的变更"）：server 维护只读克隆，定期 fetch 后按路径映射到拓扑节点
    changes: z
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
      }),
    // 集群状态检测器（ADR 0105）：没有告警规则时也发现卡住的 Pod、停滞的发布、CrashLoop、阻塞驱逐的 PDB 与失败的 Job，
    // 合成为 source=detector 的告警进入事件。对象状态由 reader（多集群）或 server 的 informer（单集群）上报
    detectors: z
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
      }),
    // 阶段 B 的 Kubernetes 只读检查（ADR 0106）：Pod 状态、事件、Pod 列表与容器日志尾部，只对本集群的事件提供。
    // 需要 server 的集群只读权限（chart 的 roles.server.clusterRead，含 pods/log）；默认关闭
    kube_reads: z
      .object({
        enabled: z.boolean().default(false),
        // 不填时用集群内的 ServiceAccount
        kubeconfig: path.optional(),
        tail_lines: z.number().int().min(10).max(500).default(100),
        max_bytes: z.number().int().min(1024).max(65536).default(16384),
      })
      .strict()
      .default({ enabled: false, tail_lines: 100, max_bytes: 16384 }),
    // 自愈 PR：结论可以落到仓库改动时，按领域包的补丁模板生成补丁，经 gateway 的 gitops_pr 开 PR；默认关闭。
    // 分支前缀、每小时上限、reviewers 与 main 的守护在 gateway 策略里
    remediation: z
      .object({
        enabled: z.boolean().default(false),
        // 补丁模板里的仓库角色 → 仓库、base 分支与文件布局（契约 pack.schema.json 的 RepositoryLayout）
        repositories: z
          .record(
            z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
            z
              .object({
                repo: repoName,
                base_branch: z.string().min(1).default('main'),
                files: z
                  .record(
                    z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
                    z
                      .object({
                        path: z.string().min(1),
                        format: z.enum(['json', 'yaml']),
                        fields: z.record(z.string(), z.string().min(1)).optional(),
                      })
                      .strict(),
                  )
                  .default({}),
              })
              .strict(),
          )
          .default({}),
        // 拓扑与领域包覆盖的缺口改为 issue（ADR 0171）：topology_coverage 在解析之前去掉并记录弃用警告（upgradeRaw）
        categories: z
          .array(z.enum(['release_rollback', 'config_resource', 'alert_rule']))
          .default(['release_rollback', 'config_resource', 'alert_rule']),
        conclusions: z
          .array(z.enum(['likely', 'evidence_consistent', 'inconclusive']))
          .default(['likely', 'evidence_consistent']),
        // 标题前缀；不填时取 notify.prefix（影子期间为 "[影子]"）
        title_prefix: z.string().optional(),
        // 同一模板对同一组文件的修改被人关闭未合并（或提议被人拒绝）之后，这段时间内不再提出（ADR 0155）；
        // 被拒绝的那一个修改始终不再自动提出。0s 时只记住被拒绝的修改
        rejected_cooldown: duration.default('7d'),
      })
      .strict()
      .default({
        enabled: false,
        repositories: {},
        categories: ['release_rollback', 'config_resource', 'alert_rule'],
        conclusions: ['likely', 'evidence_consistent'],
        rejected_cooldown: '7d',
      }),
    github_app: githubApp.optional(),
    // 主动优化（ADR 0146）；默认关闭
    optimization: optimizationConfig.default(DEFAULT_OPTIMIZATION),
    // 需要人跟进的事件在 GitHub 开 issue（ADR 0095）；默认关闭
    issues: z
      .object({
        enabled: z.boolean().default(false),
        repo: repoName,
        labels: z.array(z.string().min(1)).default(['srenautix']),
        // 标题前缀；不填时取 notify.prefix（影子期间为 "[影子]"）
        title_prefix: z.string().optional(),
        // 每个仓库每小时最多新开的 issue 数；超出时只记录、不开
        max_per_hour: z.number().int().min(1).max(100).default(6),
        // 开启时只为最近这段时间内更新过的事件开 issue，不回补历史事件
        lookback: duration.default('6h'),
        // 后台循环的间隔：登记、开出、追加评论与重试
        interval: duration.default('30s'),
      })
      .strict()
      .optional(),
    stage_a: z
      .object({
        language: z.enum(['zh', 'en']).default('zh'),
        top_k: z.number().int().min(1).max(10).default(3),
        // 领域包变化（pack.lock 变化）后，每分钟最多为这么多个仍在触发的事件重算阶段 A（ADR 0107）；0 关闭
        recompute_per_minute: z.number().int().min(0).max(100).default(10),
        // 长期事件（评估时刻晚于锚定窗口的终点）的卡片窗口终点取评估时刻，最长这么久（ADR 0149）
        card_window_max: duration.default('24h'),
        // 指标数据源的保留期：卡片窗口起点不早于评估时刻减去它（ADR 0149）；不填时不限
        metrics_retention: duration.optional(),
        // 证据基线（ADR 0153）：异常卡在事件之前的时段取基线样本，常态的卡不作为根因或支持证据
        novelty: noveltyConfig.default(NOVELTY_CONFIG_DEFAULT),
      })
      .strict()
      .default({
        language: 'zh',
        top_k: 3,
        recompute_per_minute: 10,
        card_window_max: '24h',
        novelty: NOVELTY_CONFIG_DEFAULT,
      }),
    scheduler: z
      .object({
        slots: z.number().int().min(1).max(64).default(4),
        critical_reserved: z.number().int().min(0).max(8).default(1),
        max_runs_per_incident: z.number().int().min(1).max(20).default(3),
        run_window: duration.default('6h'),
        stage_timeout: duration.default('8m'),
        storm_active_alerts: z.number().int().min(1).default(200),
        storm_new_incidents: z.number().int().min(1).default(20),
        storm_window: duration.default('5m'),
        storm_top_roots: z.number().int().min(1).default(3),
      })
      .strict()
      .default({
        slots: 4,
        critical_reserved: 1,
        max_runs_per_incident: 3,
        run_window: '6h',
        stage_timeout: '8m',
        storm_active_alerts: 200,
        storm_new_incidents: 20,
        storm_window: '5m',
        storm_top_roots: 3,
      }),
    notify: z
      .object({
        // 每条消息开头的前缀，例如 "[影子]"
        prefix: z.string().default(''),
        severities: notifySeverities,
        resolved_retention: duration.default('6h'),
        telegram: telegram.optional(),
        feishu: feishu.optional(),
        digest: notifyDigest,
        // 业务影响告警（ADR 0166）：满足任一项的告警。首条消息时延的 business_impact 标签（ADR 0159）、外部上游汇总的
        // 业务影响（ADR 0150）、处置推导中业务受影响时不给 ignore（ADR 0163）与计划内退役判为 ignore 的前提（ADR 0167）
        // 都用它。为空时没有业务影响告警
        business_impact_alerts: z.array(alertMatcher).default([]),
      })
      .strict()
      .default({
        prefix: '',
        severities: ['critical', 'warning'],
        resolved_retention: '6h',
        digest: { external_roots: EXTERNAL_ROOTS_DEFAULT },
        business_impact_alerts: [],
      }),
    approvals: z
      .object({
        signing_key_file: path,
        key_id: z.string().min(1),
        assertion_ttl: duration.default('15m'),
        proposal_ttl: duration.default('2h'),
        proposal_ttl_cap: duration.default('24h'),
        h_reauth_max_age: duration.default('5m'),
        // 审批人公钥文件（contract/gateway/v1/approver-keys.schema.json，与 gateway 挂载的是同一份）：
        // 合规配置 H 档的通行密钥凭据与 WebAuthn 依赖方设置，每 60 秒重新加载
        approver_keys_file: path.optional(),
      })
      .strict()
      .optional(),
    callers: z
      .object({
        // 服务调用方：worker、各分支（reader/gateway）、外部提议方（MCP/API）
        tokens_file: path,
      })
      .strict(),
    identity: z
      .object({
        local_admin: z
          .object({
            username: z.string().min(1),
            password_hash_file: path,
            totp_secret_file: path,
            // 登录是否要求 TOTP（ADR 0118）；false 时只用口令登录，TOTP 密钥保留，H 档审批的重新认证仍要求 TOTP
            totp_required: z.boolean().default(true),
          })
          .strict()
          .optional(),
        oidc: z
          .object({
            issuer: url,
            client_id: z.string().min(1),
            client_secret_file: path,
            scopes: z.array(z.string()).default(['openid', 'profile', 'email', 'groups']),
            groups_claim: z.string().default('groups'),
            name_claim: z.string().default('preferred_username'),
          })
          .strict()
          .optional(),
        bindings_dir: path,
        session_idle: duration.default('30m'),
        session_absolute: duration.default('12h'),
        lockout_failures: z.number().int().min(1).default(5),
        lockout_window: duration.default('15m'),
        lockout_duration: duration.default('15m'),
      })
      .strict(),
    audit: z
      .object({
        s3: z
          .object({
            endpoint: url,
            region: z.string().default('us-east-1'),
            bucket: z.string().min(1),
            prefix: z.string().default('governance/'),
            access_key_file: path,
            secret_key_file: path,
            force_path_style: z.boolean().default(true),
          })
          .strict()
          .optional(),
        checkpoint_key_file: path,
        checkpoint_interval: duration.default('10m'),
        export_lag_threshold: duration.default('5m'),
      })
      .strict(),
  })
  .strict();

export type ServerConfig = z.infer<typeof serverConfigSchema>;

/**
 * server 经 GitHub App 访问的 ops 角色仓库（ADR 0146 §6.4）：事件 issue、修复补丁、变更源与拓扑覆盖 PR 的仓库。
 * 配置了业务仓库时，请求白名单按仓库取角色，这里之外的仓库一律拒绝
 */
export function opsRepositories(c: ServerConfig): string[] {
  return [
    ...(c.issues ? [c.issues.repo] : []),
    ...Object.values(c.remediation.repositories).map((r) => r.repo),
    ...c.changes.sources.map((s) => s.repo),
    ...(c.topology.override_pr ? [c.topology.override_pr.repo] : []),
  ];
}
export type TelegramConfig = z.infer<typeof telegram>;
export type FeishuConfig = z.infer<typeof feishu>;
export type IngestSourceConfig = z.infer<typeof ingestSource>;

export function loadServerConfig(path: string): ServerConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`配置文件 ${path} 不可读或不是合法 YAML：${(e as Error).message}`);
  }
  return parseServerConfig(raw);
}

/**
 * 解析之前的兼容与明确拒绝：
 * - kind: git 的变更源不支持（hub 镜像不带 git，ADR 0096），给出改用 kind: github 的说明；
 * - 2.5 版的 topology.override_pr.github（App 身份与仓库写在一起）迁移到 github_app 与 topology.override_pr；
 * - 业务影响告警（ADR 0166）：notify.digest.external_roots.business_impact.alert_labels 与 notify.business_impact_alerts
 *   中标签条件本身的项转换为匹配器，返回弃用说明；
 * - remediation.categories 中的 topology_coverage（ADR 0171）去掉，返回弃用说明。
 */
export function upgradeRaw(raw: unknown): { raw: unknown; deprecated: string[] } {
  if (!raw || typeof raw !== 'object') {
    return { raw, deprecated: [] };
  }
  const r = structuredClone(raw) as Record<string, unknown>;
  const deprecated: string[] = [];
  const notify = r.notify as Record<string, unknown> | undefined;
  if (notify && typeof notify === 'object') {
    const xr = (notify.digest as { external_roots?: { business_impact?: Record<string, unknown> } } | undefined)
      ?.external_roots;
    const bi = xr?.business_impact;
    const legacyLabels = bi && typeof bi === 'object' ? bi.alert_labels : undefined;
    const up = upgradeMatchers(notify.business_impact_alerts, legacyLabels, {
      current: 'notify.business_impact_alerts',
      legacy: 'notify.digest.external_roots.business_impact.alert_labels',
    });
    if (up.value !== undefined) {
      notify.business_impact_alerts = up.value;
    }
    if (bi && typeof bi === 'object') {
      delete bi.alert_labels;
    }
    deprecated.push(...up.deprecated);
  }
  const remediation = r.remediation as { categories?: unknown } | undefined;
  if (Array.isArray(remediation?.categories) && remediation.categories.includes('topology_coverage')) {
    remediation.categories = remediation.categories.filter((x: unknown) => x !== 'topology_coverage');
    deprecated.push(
      'remediation.categories 中的 topology_coverage 已忽略：拓扑与领域包覆盖的缺口不再开自愈 PR，改为每个缺口一个 issue（issues 开启时，ADR 0171）',
    );
  }
  const changes = r.changes as { sources?: Array<{ id?: unknown; kind?: unknown }> } | undefined;
  for (const src of changes?.sources ?? []) {
    if (src?.kind === 'git') {
      throw new ConfigError(
        `变更源 ${String(src.id)}：kind: git 不支持（hub 镜像不带 git，ADR 0096）。托管在 GitHub 上的仓库改用 kind: github（repo、branch、paths，经 github_app 读取）`,
      );
    }
  }
  const topo = r.topology as { override_pr?: { github?: Record<string, unknown> } } | undefined;
  const legacy = topo?.override_pr?.github;
  if (legacy && typeof legacy === 'object') {
    const { api_base, app_id, installation_id, private_key_file, repo, base_branch, dir } = legacy;
    if (r.github_app === undefined) {
      r.github_app = Object.fromEntries(
        Object.entries({ api_base, app_id, installation_id, private_key_file }).filter(([, v]) => v !== undefined),
      );
    }
    topo!.override_pr = Object.fromEntries(
      Object.entries({ repo, base_branch, dir }).filter(([, v]) => v !== undefined),
    ) as typeof legacy;
  }
  return { raw: r, deprecated };
}

export function parseServerConfig(raw: unknown): ServerConfig {
  const up = upgradeRaw(raw);
  for (const d of up.deprecated) {
    logger.warn('server 配置使用了弃用的写法', { detail: d });
  }
  const r = serverConfigSchema.safeParse(up.raw);
  if (!r.success) {
    throw new ConfigError(
      `server 配置不合法：${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
    );
  }
  const c = r.data;
  if (c.notify.telegram?.enabled && c.notify.telegram.updates === 'webhook' && !c.notify.telegram.webhook_secret_file) {
    throw new ConfigError('notify.telegram.updates=webhook 需要 webhook_secret_file');
  }
  const period = parseDuration('notify.digest.external_roots.period', c.notify.digest.external_roots.period);
  if (period < 5 * 60_000 || period > 24 * 3_600_000) {
    throw new ConfigError('notify.digest.external_roots.period 必须在 5m 与 24h 之间');
  }
  const ids = c.ingest.sources.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    throw new ConfigError('ingest.sources 的 id 不能重复');
  }
  if (c.profile !== 'observe' && !c.approvals) {
    throw new ConfigError(`profile=${c.profile} 需要 approvals 配置（服务签名密钥）`);
  }
  if (c.scheduler.critical_reserved >= c.scheduler.slots) {
    throw new ConfigError('scheduler.critical_reserved 必须小于 slots');
  }
  if (!c.github_app) {
    if (c.issues?.enabled) {
      throw new ConfigError('issues.enabled 需要 github_app（GitHub App 的安装令牌，不用个人令牌）');
    }
    if (c.changes.sources.length) {
      throw new ConfigError('kind: github 的变更源需要 github_app');
    }
    if (c.optimization.repositories.business) {
      throw new ConfigError('optimization.repositories.business 需要 github_app（与 ops 仓库共用同一个安装）');
    }
  }
  const business = c.optimization.repositories.business?.repo.toLowerCase();
  if (business && opsRepositories(c).some((r) => r.toLowerCase() === business)) {
    throw new ConfigError(
      `optimization.repositories.business 的仓库 ${c.optimization.repositories.business?.repo} 同时是 ops 仓库（issues、remediation、changes 或 topology.override_pr）`,
    );
  }
  // 变更的 source 字段取变更源的 id：GitHub 变更源与 SQL 审计表变更源共用一个命名空间
  const srcIds = [...c.changes.sources.map((x) => x.id), ...c.changes.sql_audit.map((x) => x.id)];
  if (new Set(srcIds).size !== srcIds.length) {
    throw new ConfigError('changes.sources 与 changes.sql_audit 的 id 不能重复');
  }
  for (const s of c.changes.sql_audit) {
    const ids = s.queries.map((q) => q.id);
    if (new Set(ids).size !== ids.length) {
      throw new ConfigError(`changes.sql_audit ${s.id}：queries 的 id 不能重复`);
    }
  }
  return c;
}
