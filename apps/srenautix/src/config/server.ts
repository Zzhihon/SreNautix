import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './files.js';
import { DEFAULT_REVISION_LABELS } from '../changes/kubernetes.js';

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
        reconcile: z
          .object({
            enabled: z.boolean().default(true),
            interval: duration.default('60s'),
            alertmanager_url: url.optional(),
            prometheus_url: url.optional(),
            bearer_token_file: path.optional(),
          })
          .strict()
          .default({ enabled: true, interval: '60s' }),
      })
      .strict()
      .default({
        sources: [],
        self_label: 'srenautix_self',
        silence_threshold: '10m',
        watchdog_alertname: 'Watchdog',
        reconcile: { enabled: true, interval: '60s' },
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
      })
      .strict(),
    topology: z
      .object({
        source: z.enum(['informer', 'reader', 'off']).default('informer'),
        kubeconfig: path.optional(),
        // reader 超过这个时长没有心跳（默认 15 秒一次）视为离线：它上报的条件清除，状态条只显示"reader 离线"
        reader_offline_after: duration.default('60s'),
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
      .default({ source: 'informer', reader_offline_after: '60s' }),
    // 变更源（changes/v1，DESIGN §5 的"30 分钟内的变更"）：server 维护只读克隆，定期 fetch 后按路径映射到拓扑节点
    changes: z
      .object({
        sources: z.array(changesSource).default([]),
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
          })
          .strict()
          .default({ enabled: true, revision_labels: [...DEFAULT_REVISION_LABELS], group_within: '2m' }),
      })
      .strict()
      .default({
        sources: [],
        interval: '60s',
        lookback: '24h',
        kubernetes: { enabled: true, revision_labels: [...DEFAULT_REVISION_LABELS], group_within: '2m' },
      }),
    github_app: githubApp.optional(),
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
      .object({ language: z.enum(['zh', 'en']).default('zh'), top_k: z.number().int().min(1).max(10).default(3) })
      .strict()
      .default({ language: 'zh', top_k: 3 }),
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
        severities: z.array(z.enum(['critical', 'warning', 'info'])).default(['critical', 'warning']),
        resolved_retention: duration.default('6h'),
        telegram: telegram.optional(),
        feishu: feishu.optional(),
      })
      .strict()
      .default({ prefix: '', severities: ['critical', 'warning'], resolved_retention: '6h' }),
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
          .object({ username: z.string().min(1), password_hash_file: path, totp_secret_file: path })
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
 * - 2.5 版的 topology.override_pr.github（App 身份与仓库写在一起）迁移到 github_app 与 topology.override_pr。
 */
function upgradeRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const r = structuredClone(raw) as Record<string, unknown>;
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
  return r;
}

export function parseServerConfig(raw: unknown): ServerConfig {
  const r = serverConfigSchema.safeParse(upgradeRaw(raw));
  if (!r.success) {
    throw new ConfigError(
      `server 配置不合法：${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
    );
  }
  const c = r.data;
  if (c.notify.telegram?.enabled && c.notify.telegram.updates === 'webhook' && !c.notify.telegram.webhook_secret_file) {
    throw new ConfigError('notify.telegram.updates=webhook 需要 webhook_secret_file');
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
  }
  const srcIds = c.changes.sources.map((x) => x.id);
  if (new Set(srcIds).size !== srcIds.length) {
    throw new ConfigError('changes.sources 的 id 不能重复');
  }
  return c;
}
