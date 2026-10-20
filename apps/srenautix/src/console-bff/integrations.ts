import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HubComponents, IntegrationManifest } from '@srenautix/contract';
import { loadIntegrationManifest } from '@srenautix/integration-sdk';
import type pg from 'pg';
import type { ChangesService } from '../changes/service.js';
import { parseDuration } from '../config/files.js';
import type { ServerConfig } from '../config/server.js';
import type { FeishuClient } from '../channels/feishu/client.js';
import type { TelegramClient } from '../channels/telegram/client.js';
import type { Oidc } from '../identity/oidc.js';
import type { Keyring } from '../proposals/assertion.js';
import { logger } from '../log.js';
import type { Catalog } from '../proposals/catalog.js';
import type { EvidenceSource, PackRuntime } from '../stage-a/packs.js';

export type IntegrationInstance = HubComponents['schemas']['IntegrationInstance'];

export interface ProbeOutcome {
  ok: boolean;
  /** 成功时的说明，或失败原因 */
  detail: string;
}

interface InstanceSpec {
  instanceId: string;
  manifestId: string;
  /** 配置中引用的挂载文件路径（永远不读出内容） */
  secretRefs: string[];
  usedBy: { chains: string[]; actions: string[] };
  /** 最近一次成功（收到告警、同步成功等）；没有记录时为 null */
  lastSuccess: () => Promise<Date | null>;
  /** 连接测试：返回每个声明能力的结果；没有列出的能力记为"没有服务端探测" */
  probe: () => Promise<Record<string, ProbeOutcome>>;
}

export interface IntegrationDeps {
  pool: pg.Pool;
  config: ServerConfig;
  packs: PackRuntime;
  catalog: Catalog;
  evidence: EvidenceSource;
  changes: ChangesService;
  telegram: TelegramClient | null;
  feishu: FeishuClient | null;
  oidc: Oidc | null;
  /** 审批人公钥（合规配置 H 档的通行密钥）；未配置或不能加载时为 null。 */
  approverKeys?: () => Keyring | null;
}

/** 与代码同一发布物中的 integrations/：仓库根目录（src 或 dist 的上三级）；镜像中为 /app/integrations。 */
export const DEFAULT_INTEGRATIONS_DIR = resolve(import.meta.dirname, '../../../../integrations');

const INGEST_MANIFEST: Record<string, string> = {
  alertmanager: 'alertmanager',
  grafana: 'grafana-alerting',
  nightingale: 'nightingale',
  generic: 'generic-webhook',
};

/** 合规配置 H 档：签名密钥、WebAuthn 依赖方设置与至少一个登记的通行密钥。 */
function passkeyProbe(signing: ProbeOutcome, keys: Keyring | null): ProbeOutcome {
  if (!signing.ok) {
    return signing;
  }
  if (!keys?.rpId) {
    return { ok: false, detail: '没有可用的审批人公钥文件（approvals.approver_keys_file）或其中没有 webauthn 设置' };
  }
  if (!keys.webauthn.size) {
    return { ok: false, detail: '审批人公钥文件中没有登记通行密钥' };
  }
  return {
    ok: true,
    detail: `通行密钥（WebAuthn，rp_id ${keys.rpId}）签名，登记 ${keys.webauthn.size} 个凭据；另需 5 分钟内重新认证`,
  };
}

const fail = (e: unknown): ProbeOutcome => ({ ok: false, detail: e instanceof Error ? e.message : String(e) });

async function attempt(f: () => Promise<string>): Promise<ProbeOutcome> {
  try {
    return { ok: true, detail: await f() };
  } catch (e) {
    return fail(e);
  }
}

/**
 * 控制台"集成"页（DESIGN §10、§12）：按 server 配置列出已启用的集成实例，每个实例对应 integrations/ 中的一个清单。
 * 连接测试对每个声明的能力做真实的检查：主动探测（Prometheus 的 verify、git fetch、Bot API getMe、飞书 tenant token、
 * OIDC 发现）；被动接收的 webhook 以最近是否收到为准；进程内的能力以配置是否完整为准。最近一次的结果保存在内存中，
 * 列表按它给出 verified。
 */
export class IntegrationRegistry {
  private readonly manifests = new Map<string, { manifest: IntegrationManifest; sha: string }>();
  private readonly verified = new Map<string, Map<string, { ok: boolean; at: Date; error: string | null }>>();

  /** 清单不能加载的集成：集成页只是展示，不因此让 server 启动失败；这些实例不列出，原因写进日志 */
  readonly manifestErrors = new Map<string, string>();
  private readonly specs: InstanceSpec[];

  private constructor(
    private readonly dir: string,
    specs: InstanceSpec[],
  ) {
    for (const s of specs) {
      if (this.manifests.has(s.manifestId) || this.manifestErrors.has(s.manifestId)) {
        continue;
      }
      try {
        const m = loadIntegrationManifest(join(dir, s.manifestId));
        const sha = createHash('sha256')
          .update(readFileSync(join(dir, s.manifestId, 'integration.yaml')))
          .digest('hex');
        this.manifests.set(s.manifestId, { manifest: m.manifest, sha: `sha256:${sha}` });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.manifestErrors.set(s.manifestId, error);
        logger.error('集成清单不能加载，集成页不列出使用它的实例', { manifest: s.manifestId, dir, error });
      }
    }
    this.specs = specs.filter((s) => this.manifests.has(s.manifestId));
  }

  static fromConfig(d: IntegrationDeps): IntegrationRegistry {
    const c = d.config;
    const specs: InstanceSpec[] = [];
    const silenceMs = parseDuration('ingest.silence_threshold', c.ingest.silence_threshold);
    const allActions = d.catalog.list().map((a) => a.id);
    const approveSigning = c.approvals !== undefined;

    for (const s of c.ingest.sources) {
      const lastReceived = async () => {
        const r = await d.pool.query<{ last_received_at: Date | null }>(
          'SELECT last_received_at FROM server.ingest_sources WHERE source_id = $1',
          [s.id],
        );
        return r.rows[0]?.last_received_at ?? null;
      };
      specs.push({
        instanceId: `ingest:${s.id}`,
        manifestId: INGEST_MANIFEST[s.kind] as string,
        secretRefs: [s.token_file],
        usedBy: { chains: [], actions: [] },
        lastSuccess: lastReceived,
        probe: async () => {
          const at = await lastReceived();
          const webhook: ProbeOutcome =
            at && Date.now() - at.getTime() <= silenceMs
              ? { ok: true, detail: `最近一次收到告警：${at.toISOString()}` }
              : { ok: false, detail: at ? `自 ${at.toISOString()} 起没有收到告警` : '从未收到告警' };
          const out: Record<string, ProbeOutcome> = { 'alerts.webhook': webhook };
          if (s.kind === 'alertmanager' && c.ingest.reconcile.alertmanager_url) {
            out['alerts.reconcile'] = await attempt(async () => {
              const r = await fetch(`${c.ingest.reconcile.alertmanager_url}/api/v2/status`, {
                signal: AbortSignal.timeout(5_000),
              });
              if (!r.ok) {
                throw new Error(`GET /api/v2/status 返回 HTTP ${r.status}`);
              }
              return 'Alertmanager API 可达';
            });
          }
          return out;
        },
      });
    }

    const prom = c.datasources.prometheus;
    specs.push({
      instanceId: 'datasource:prometheus',
      manifestId: 'prometheus-api',
      secretRefs: prom.bearer_token_file ? [prom.bearer_token_file] : [],
      usedBy: { chains: [...d.packs.set.chains.keys()].sort(), actions: [] },
      lastSuccess: async () => null,
      probe: async () => {
        const r = await d.evidence.verify();
        return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ok: v.ok, detail: v.detail }]));
      },
    });

    for (const s of c.changes.sources) {
      specs.push({
        instanceId: `changes:${s.id}`,
        manifestId: 'git',
        secretRefs: [s.http_token_file, s.deploy_key_file, s.known_hosts_file].filter((x): x is string => !!x),
        usedBy: { chains: [], actions: [] },
        lastSuccess: async () => (await d.changes.statuses()).find((x) => x.id === s.id)?.lastSyncedAt ?? null,
        probe: async () => ({ 'changes.list': await attempt(() => d.changes.verify(s.id)) }),
      });
    }

    const tg = c.notify.telegram;
    if (tg?.enabled && d.telegram) {
      const client = d.telegram;
      specs.push({
        instanceId: 'notify:telegram',
        manifestId: 'telegram',
        secretRefs: [tg.bot_token_file, ...(tg.webhook_secret_file ? [tg.webhook_secret_file] : [])],
        usedBy: { chains: [], actions: allActions },
        lastSuccess: () => lastDelivered(d.pool, 'telegram'),
        probe: async () => {
          const me = await attempt(async () => `@${(await client.getMe(AbortSignal.timeout(10_000))).username ?? '?'}`);
          return {
            'notify.send': me,
            'notify.edit': me,
            'notify.callback_verify':
              tg.updates === 'webhook'
                ? { ok: true, detail: 'webhook 按 secret_token 校验来源' }
                : tg.updates === 'polling'
                  ? { ok: true, detail: '长轮询直接从 Bot API 取得更新' }
                  : { ok: false, detail: 'updates 为 none：不接收按钮回调' },
            'notify.link': tg.updates === 'none' ? { ok: false, detail: 'updates 为 none：不接收 /link' } : me,
            'approve.l_tier': approveSigning
              ? { ok: true, detail: '审批断言签名密钥已配置' }
              : { ok: false, detail: '没有配置 approvals，不能签发审批断言' },
          };
        },
      });
    }

    const fs = c.notify.feishu;
    if (fs?.enabled && d.feishu) {
      const client = d.feishu;
      specs.push({
        instanceId: 'notify:feishu',
        manifestId: 'feishu',
        secretRefs: [
          fs.app_secret_file,
          fs.verification_token_file,
          ...(fs.encrypt_key_file ? [fs.encrypt_key_file] : []),
        ],
        usedBy: { chains: [], actions: allActions },
        lastSuccess: () => lastDelivered(d.pool, 'feishu'),
        probe: async () => {
          const token = await attempt(async () => {
            await client.tenantToken();
            return 'tenant_access_token 获取成功';
          });
          return {
            'notify.send': token,
            'notify.edit': token,
            'notify.callback_verify': fs.encrypt_key_file
              ? { ok: true, detail: '回调按 X-Lark-Signature 与 5 分钟时效校验' }
              : { ok: false, detail: '没有配置 encrypt_key_file：回调只校验 verification token' },
            'notify.link': { ok: true, detail: '群内或私聊 /link' },
            'approve.l_tier': approveSigning
              ? { ok: true, detail: '审批断言签名密钥已配置' }
              : { ok: false, detail: '没有配置 approvals，不能签发审批断言' },
          };
        },
      });
    }

    specs.push({
      instanceId: 'approve:console',
      manifestId: 'console',
      secretRefs: c.approvals ? [c.approvals.signing_key_file] : [],
      usedBy: { chains: [], actions: allActions },
      lastSuccess: async () => {
        const r = await d.pool.query<{ at: Date | null }>(
          'SELECT max(issued_at) AS at FROM server.approval_assertions',
        );
        return r.rows[0]?.at ?? null;
      },
      probe: async () => {
        const signing: ProbeOutcome = approveSigning
          ? { ok: true, detail: '审批断言签名密钥已配置' }
          : { ok: false, detail: '没有配置 approvals，不能签发审批断言' };
        return {
          'notify.send': { ok: true, detail: '控制台经事件流实时更新' },
          'notify.edit': { ok: true, detail: '控制台经事件流实时更新' },
          'approve.l_tier': signing,
          'approve.h_tier':
            c.profile === 'compliance'
              ? passkeyProbe(signing, d.approverKeys?.() ?? null)
              : signing.ok
                ? { ok: true, detail: '口令加 TOTP 重新认证（5 分钟内）' }
                : signing,
        };
      },
    });

    if (c.identity.local_admin) {
      const la = c.identity.local_admin;
      specs.push({
        instanceId: 'identity:local-admin',
        manifestId: 'local-admin',
        secretRefs: [la.password_hash_file, la.totp_secret_file],
        usedBy: { chains: [], actions: [] },
        lastSuccess: () => lastLogin(d.pool, 'local-admin'),
        probe: async () => ({ 'identity.authenticate': { ok: true, detail: '口令哈希与 TOTP 密钥已加载' } }),
      });
    }
    if (c.identity.oidc && d.oidc) {
      const oidc = d.oidc;
      specs.push({
        instanceId: 'identity:oidc',
        manifestId: 'oidc',
        secretRefs: [c.identity.oidc.client_secret_file],
        usedBy: { chains: [], actions: [] },
        lastSuccess: () => lastLogin(d.pool, 'oidc'),
        probe: async () => {
          const disc = await attempt(async () => `发现成功，授权端点 ${await oidc.verify()}`);
          return { 'identity.authenticate': disc, 'identity.groups': disc, 'identity.reauth': disc };
        },
      });
    }
    return new IntegrationRegistry(c.integrations.dir ?? DEFAULT_INTEGRATIONS_DIR, specs);
  }

  async list(): Promise<IntegrationInstance[]> {
    const out: IntegrationInstance[] = [];
    for (const s of this.specs) {
      const m = this.manifests.get(s.manifestId)!;
      const v = this.verified.get(s.instanceId);
      const last = await s.lastSuccess();
      out.push({
        instance_id: s.instanceId,
        manifest: m.manifest,
        git_source: { repo: 'builtin', path: `integrations/${s.manifestId}/integration.yaml`, sha: m.sha },
        secret_refs: s.secretRefs,
        last_success_at: last ? last.toISOString() : null,
        error_ratio_1h: null,
        used_by: s.usedBy,
        capabilities: m.manifest.capabilities.map((cap) => {
          const r = v?.get(cap.name);
          return {
            name: cap.name,
            maturity: cap.stability,
            verified: r?.ok ?? false,
            verified_at: r ? r.at.toISOString() : null,
            error: r ? r.error : null,
          };
        }),
        // 凭证的实际权限无法从 server 侧读出；没有证据表明超出 required_scopes
        over_privileged: false,
      });
    }
    return out;
  }

  has(instanceId: string): boolean {
    return this.specs.some((s) => s.instanceId === instanceId);
  }

  /** 连接测试：对实例声明的每个能力给出结果，并记住结果供列表使用。 */
  async test(instanceId: string): Promise<{
    ok: boolean;
    results: Array<{ capability: string; ok: boolean; duration_ms: number; error: string | null }>;
  }> {
    const s = this.specs.find((x) => x.instanceId === instanceId);
    if (!s) {
      throw new Error(`没有集成实例 ${instanceId}`);
    }
    const started = Date.now();
    const probed = await s.probe();
    const duration = Date.now() - started;
    const at = new Date();
    const store = new Map<string, { ok: boolean; at: Date; error: string | null }>();
    const results = this.manifests.get(s.manifestId)!.manifest.capabilities.map((cap) => {
      const r = probed[cap.name] ?? { ok: false, detail: '这项能力没有服务端探测' };
      store.set(cap.name, { ok: r.ok, at, error: r.ok ? null : r.detail });
      return { capability: cap.name, ok: r.ok, duration_ms: duration, error: r.ok ? null : r.detail };
    });
    this.verified.set(instanceId, store);
    return { ok: results.every((r) => r.ok), results };
  }
}

async function lastDelivered(pool: pg.Pool, channel: string): Promise<Date | null> {
  const r = await pool.query<{ at: Date | null }>(
    'SELECT max(delivered_at) AS at FROM server.notify_messages WHERE channel = $1',
    [channel],
  );
  return r.rows[0]?.at ?? null;
}

async function lastLogin(pool: pg.Pool, provider: string): Promise<Date | null> {
  const r = await pool.query<{ at: Date | null }>(
    'SELECT max(last_login_at) AS at FROM server.users WHERE provider = $1',
    [provider],
  );
  return r.rows[0]?.at ?? null;
}
