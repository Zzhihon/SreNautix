import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './files.js';

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
    // dirs 下的每个子目录是一个领域包；only 不填时加载除 `_` 开头（示例包）以外的全部包
    packs: z
      .object({ dirs: z.array(path).min(1), only: z.array(z.string().min(1)).optional(), lock_file: path.optional() })
      .strict(),
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
      })
      .strict()
      .default({ source: 'informer' }),
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

export function parseServerConfig(raw: unknown): ServerConfig {
  const r = serverConfigSchema.safeParse(raw);
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
  return c;
}
