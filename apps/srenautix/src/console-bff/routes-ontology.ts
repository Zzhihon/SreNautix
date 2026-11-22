// 运维本体词汇表（GET /v1/ontology/glossary）：从已加载的领域包提取组件类型说明、证据卡说明，
// 并合并内置的常见 Kubernetes 与存储/数据/网关运维指标概念，供控制台拓扑与证据卡悬停提示使用。
// 纯只读且按 pack_lock + lang 生成 ETag（Cache-Control: private, max-age=60），不改动 Subgraph 与 EvidenceResult 契约。

import { createHash } from 'node:crypto';
import type { ComponentType, HubComponents, LocalizedText } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../identity/auth.js';
import type { PackRuntime } from '../stage-a/packs.js';

export type OntologyGlossary = HubComponents['schemas']['OntologyGlossary'];
export type OntologyLang = 'zh-CN' | 'en';
export type OntologyLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'external';

export interface OntologyRouteDeps {
  auth: Auth;
  packs: PackRuntime;
}

function pickLocale(text: LocalizedText | undefined, lang: OntologyLang): string {
  if (!text) {
    return '';
  }
  const other: OntologyLang = lang === 'zh-CN' ? 'en' : 'zh-CN';
  return text[lang] ?? text[other] ?? '';
}

const L0_KINDS = new Set(['route', 'HTTPRoute', 'GRPCRoute', 'TLSRoute', 'Gateway', 'Ingress', 'IngressRoute']);
const L2_KINDS = new Set([
  'Cluster',
  'Dragonfly',
  'Redis',
  'PostgresCluster',
  'PersistentVolumeClaim',
  'PersistentVolume',
  'StorageClass',
  'Volume',
  'VolumeSnapshot',
  'queryid',
]);
const L3_KINDS = new Set([
  'Node',
  'Namespace',
  'Certificate',
  'ClusterIssuer',
  'Issuer',
  'PodDisruptionBudget',
  'NetworkPolicy',
  'CiliumNetworkPolicy',
  'CiliumClusterwideNetworkPolicy',
  'instance',
]);
const L2_NAME_RE =
  /(postgres|(^|[-_.])pg([-_.]|$)|dragonfly|redis|nats|minio|mysql|mariadb|kafka|rocketmq|mongodb|etcd|vmsingle|loki|tempo|object-?store|backup-?store|s3\.|pvc|volume)/i;
const L0_NAME_RE = /(edge-|envoy|caddy|ingress|cloudflared|tunnel|route)/i;
const L3_NAME_RE = /(node|apiserver|cilium|coredns|kube-|network|platform|storage-class)/i;

/** 当领域包未显式声明 layer 时，按组件类型匹配规则推断默认五层泳道。 */
export function inferComponentLayer(ct: ComponentType): OntologyLayer {
  if (ct.layer) {
    return ct.layer;
  }
  if (ct.external) {
    return 'external';
  }
  const kind = ct.match.kind;
  const baseKind = kind.includes('.') ? kind.slice(0, kind.indexOf('.')) : kind;
  const hint = `${ct.id} ${ct.match.name_pattern ?? ''}`;
  if (baseKind === 'provider' || baseKind === 'model') {
    return 'external';
  }
  if (L0_KINDS.has(baseKind)) {
    return 'L0';
  }
  if (baseKind === 'host') {
    return L2_NAME_RE.test(hint) ? 'L2' : 'L0';
  }
  if (L2_KINDS.has(baseKind) || L2_NAME_RE.test(hint)) {
    return 'L2';
  }
  if (L3_KINDS.has(baseKind) || (baseKind === 'component' && L3_NAME_RE.test(hint))) {
    return 'L3';
  }
  if (L0_NAME_RE.test(hint) && !/(gateway-pod|gateway-workload|gateway-job|component-app)/i.test(ct.id)) {
    return 'L0';
  }
  return 'L1';
}

interface BilingualConcept {
  title: { 'zh-CN': string; en: string };
  description: { 'zh-CN': string; en: string };
}

/**
 * 内置运维概念与指标词汇表：帮助值班人员在悬停不熟悉的实体、指标或控制回路字段时立刻理解其含义与影响。
 * 键采用小写规范名（查询端按归一化键与子串匹配）。
 */
const BUILTIN_CONCEPTS: Readonly<Record<string, BilingualConcept>> = {
  volume_reserve_bytes: {
    title: { 'zh-CN': '卷保留空间（volume_reserve_bytes）', en: 'Volume reserve bytes' },
    description: {
      'zh-CN':
        '网关在同物理卷上为相邻目录（capture 日志、localstore、replay-spool 及 kubelet imageGC 75% 安全余量）预留的字节数；可用归档预算 effective_budget = volume_free - volume_reserve_bytes。',
      en: 'Bytes reserved by gateway for sibling directories and kubelet imageGC headroom on the same volume; effective archive budget = free space minus volume_reserve_bytes.',
    },
  },
  effective_budget: {
    title: { 'zh-CN': '有效本地预算（effective_budget）', en: 'Effective local disk budget' },
    description: {
      'zh-CN':
        '应用按宿主机磁盘剩余容量减去 volume_reserve_bytes 后动态计算出的本地归档预算上限；低于设定阈值时触发预算缩减告警并影响发布门禁。',
      en: 'Dynamically computed local archive disk ceiling after subtracting volume_reserve_bytes from host free space; dropping below threshold triggers budget-reduced alerts.',
    },
  },
  'archive-exporter': {
    title: { 'zh-CN': '归档导出器（archive-exporter）', en: 'Archive exporter' },
    description: {
      'zh-CN':
        '异步消费 NATS ARCHIVE_EVENTS 并从对象存储（回退至 gateway:8091）读取请求归档，再投递至 Langfuse 等衍生下游的独立工作负载；属于可降级（fail-open）异步链路。',
      en: 'Async workload consuming NATS ARCHIVE_EVENTS and reading archive payloads from object storage (or gateway:8091 fallback) to export to derived sinks (fail-open path).',
    },
  },
  usage_journal: {
    title: { 'zh-CN': '用量日志（usage_journal）', en: 'Usage journal' },
    description: {
      'zh-CN':
        '网关在本地持久化记账流水与扣费记录的 WAL 日志；空间耗尽或写入失败时为保护账务一致性会触发 fail-closed（503）。',
      en: 'Gateway local durable billing journal; exhaustion or write failure triggers fail-closed 503 protection to preserve billing truth.',
    },
  },
  settlement_spool: {
    title: { 'zh-CN': '结算缓冲队列（settlement_spool）', en: 'Settlement spool' },
    description: {
      'zh-CN': '网关向数据库异步落账的本地持久化缓冲队列；数据库不可达期间缓存待结算记录，积压超限时阻止新请求进入。',
      en: 'Local durable spool buffering billing settlements during database outages; overflow prevents admitting new billable requests.',
    },
  },
  wal: {
    title: { 'zh-CN': '预写日志（WAL）', en: 'Write-Ahead Log (WAL)' },
    description: {
      'zh-CN':
        'PostgreSQL 用于崩溃恢复、流复制与归档的事务日志；归档失败或复制槽积压会导致 pg_wal 目录持续膨胀并占满卷空间。',
      en: 'PostgreSQL transaction log for crash recovery, streaming replication, and continuous archiving; failed archive or stalled replication slots cause pg_wal disk growth.',
    },
  },
  replication_lag: {
    title: { 'zh-CN': '主从复制延迟（replication_lag）', en: 'Replication lag' },
    description: {
      'zh-CN': '备库回放主库 WAL 的落后字节数或时间差；延迟过高会扩大故障切换 RPO 并拖慢复制槽 WAL 回收。',
      en: 'Byte or time lag of replica WAL replay behind the primary; elevated lag increases failover RPO and retains WAL segments on primary.',
    },
  },
  imagefs: {
    title: { 'zh-CN': '节点镜像文件系统（imagefs / imageGC）', en: 'Node image filesystem (imageGC)' },
    description: {
      'zh-CN':
        '节点根盘或容器镜像存储分区；使用率超过 kubelet imageGCHighThresholdPercent（常为 75%–85%）会触发镜像垃圾回收并与 local-path PVC 竞争宿主机剩余空间。',
      en: 'Node filesystem storing container images and ephemeral storage; crossing kubelet imageGC high threshold triggers GC and competes with local-path PVCs.',
    },
  },
  oomkilled: {
    title: { 'zh-CN': '内存超限终止（OOMKilled）', en: 'Out-Of-Memory Killed (OOMKilled)' },
    description: {
      'zh-CN':
        '容器常驻内存（working_set）触及 cgroup memory.limit 被内核强制终止（退出码 137），通常伴随 Pod 重启或主库切换。',
      en: 'Kernel terminated container (exit code 137) after cgroup memory working_set hit its limit, causing Pod restart or database failover.',
    },
  },
  pdb: {
    title: { 'zh-CN': '中断预算（PodDisruptionBudget）', en: 'PodDisruptionBudget (PDB)' },
    description: {
      'zh-CN':
        '限制维护、滚动升级或节点排空期间同时不可用的副本数；当 disruptionsAllowed=0 且存在待驱逐 Pod 时会阻塞节点维护。',
      en: 'Caps voluntary concurrent Pod disruptions during rollouts or drains; disruptionsAllowed=0 blocks evictions when maintenance is pending.',
    },
  },
  hpa: {
    title: { 'zh-CN': '水平自动扩缩（HorizontalPodAutoscaler）', en: 'HorizontalPodAutoscaler (HPA)' },
    description: {
      'zh-CN': '按 CPU、内存或自定义指标自动调整工作负载副本数；触及 maxReplicas 饱和时无法继续分担流量高峰。',
      en: 'Automatically scales workload replicas based on resource or custom metrics; hitting maxReplicas signals scaling saturation.',
    },
  },
  rwx: {
    title: { 'zh-CN': '多节点读写卷（ReadWriteMany / RWX）', en: 'ReadWriteMany (RWX) Volume' },
    description: {
      'zh-CN': '支持多个节点同时挂载读写的共享持久卷（如 Longhorn RWX / NFS），用于跨副本共享任务结果或导入文件。',
      en: 'Shared persistent volume mountable read-write across multiple nodes (e.g., Longhorn RWX), used for cross-replica shared artifacts.',
    },
  },
  rwo: {
    title: { 'zh-CN': '单节点读写卷（ReadWriteOnce / RWO）', en: 'ReadWriteOnce (RWO) Volume' },
    description: {
      'zh-CN': '仅允许单节点挂载的持久卷（如 local-path、块存储）；绑定节点拓扑后 Pod 无法直接飘移到其他节点。',
      en: 'Volume mountable read-write by a single node (e.g., local-path or block storage); pins stateful Pods to that node topology.',
    },
  },
  'local-path': {
    title: { 'zh-CN': '宿主机本地卷（local-path）', en: 'Host local-path storage' },
    description: {
      'zh-CN': '直接映射宿主机目录的 RWO 卷，不预留物理磁盘配额，与同宿主机上的容器镜像和临时写入共享磁盘空间。',
      en: 'Host-directory backed RWO storage without physical quota reservation; shares disk capacity with node imagefs and ephemeral writes.',
    },
  },
  longhorn: {
    title: { 'zh-CN': 'Longhorn 分布式块/共享存储', en: 'Longhorn distributed storage' },
    description: {
      'zh-CN':
        '云原生分布式存储系统，提供多副本块卷与基于 share-manager 的 RWX 共享卷；副本重建或存储节点磁盘压力会放大 IO 延迟。',
      en: 'Cloud-native distributed storage providing replicated block and share-manager RWX volumes; replica rebuilds or disk pressure elevate IO latency.',
    },
  },
  cnpg: {
    title: { 'zh-CN': 'CloudNativePG（CNPG）数据库集群', en: 'CloudNativePG (CNPG) cluster' },
    description: {
      'zh-CN':
        'Kubernetes 原生 PostgreSQL Operator 托管的主备集群，负责主从切换、WAL 连续归档、连接服务（-rw/-ro）与物理备份。',
      en: 'Operator-managed PostgreSQL HA cluster handling primary failover, WAL archiving, -rw/-ro Services, and base backups.',
    },
  },
  dragonfly: {
    title: { 'zh-CN': 'Dragonfly 内存缓存', en: 'Dragonfly in-memory cache' },
    description: {
      'zh-CN':
        '兼容 Redis 协议的高吞吐多线程内存缓存，承载限流、会话与热数据缓存；内存驱逐或连接饱和会增加网关回源压力。',
      en: 'High-throughput Redis-compatible in-memory cache serving rate limits and hot state; evictions or saturation increase origin DB load.',
    },
  },
  nats: {
    title: { 'zh-CN': 'NATS JetStream 消息总线', en: 'NATS JetStream messaging' },
    description: {
      'zh-CN': '轻量级持久化事件流消息系统，承载归档事件（ARCHIVE_EVENTS）与异步任务分发；消费者滞后会造成流存储积压。',
      en: 'Lightweight persistent event streaming bus carrying ARCHIVE_EVENTS and async pipelines; consumer lag causes stream backlog.',
    },
  },
  gateway: {
    title: { 'zh-CN': '业务请求网关（gateway）', en: 'Request gateway' },
    description: {
      'zh-CN':
        '核心在线流量转发与计费入口（带每副本本地 archive PVC 的 StatefulSet），负责鉴权、限流、上游路由、实时扣费与请求归档；主链路为 fail-closed。',
      en: 'Core online traffic forwarding and billing StatefulSet (with per-replica local archive PVC) handling auth, routing, billing, and archive capture.',
    },
  },
  control: {
    title: { 'zh-CN': '控制面服务（control）', en: 'Control plane service' },
    description: {
      'zh-CN': '管理后台 API、运行时配置快照发布与控制台静态资源服务；配置变更经由控制面下发到各网关副本。',
      en: 'Admin API, runtime config snapshot publisher, and console asset server propagating config updates to gateway replicas.',
    },
  },
  worker: {
    title: { 'zh-CN': '后台任务工作负载（worker）', en: 'Background worker' },
    description: {
      'zh-CN': '执行账务对账（ledger_reconcile）、预扣清理、批量导入与数据库定期清理的后台常驻任务。',
      en: 'Background workload running ledger reconciliation, reservation sweeping, batch imports, and database retention cleanup.',
    },
  },
  cloudflared: {
    title: { 'zh-CN': '边缘隧道（cloudflared）', en: 'Edge tunnel (cloudflared)' },
    description: {
      'zh-CN': 'L0 边缘接入代理，将公网 Cloudflare 边缘流量经加密隧道转发至集群内入口路由与网关。',
      en: 'L0 edge tunnel daemon forwarding external Cloudflare edge traffic into cluster ingress and gateway.',
    },
  },
  'envoy-gateway': {
    title: { 'zh-CN': 'L0 边缘网关（Envoy Gateway）', en: 'Envoy Gateway (L0 Edge)' },
    description: {
      'zh-CN': 'L0 入口代理，负责公网 TLS 终结、HTTPRoute 路由分发与东西/南北向流量限流。',
      en: 'L0 ingress proxy handling external TLS termination, HTTPRoute routing, and traffic management.',
    },
  },
  vmsingle: {
    title: { 'zh-CN': 'VictoriaMetrics 指标库（vmsingle）', en: 'VictoriaMetrics time-series DB' },
    description: {
      'zh-CN': '集群指标时序存储引擎，为告警评估（vmalert）与 SreNautix 证据卡提供 PromQL/MetricsQL 查询能力。',
      en: 'Cluster metrics TSDB backing vmalert rule evaluation and SreNautix evidence card PromQL/MetricsQL queries.',
    },
  },
  loki: {
    title: { 'zh-CN': 'Loki 日志存储', en: 'Loki log store' },
    description: {
      'zh-CN': '聚合集群容器与系统日志的索引存储，供 SreNautix 证据卡提取错误样例与日志模式。',
      en: 'Cluster log aggregation store used by SreNautix evidence cards for error sampling and LogQL matching.',
    },
  },
  pvc: {
    title: { 'zh-CN': '持久卷声明（PersistentVolumeClaim）', en: 'PersistentVolumeClaim (PVC)' },
    description: {
      'zh-CN': '工作负载申请的持久化存储卷；容量接近 100% 或 inode 耗尽会触发写入错误与只读降级。',
      en: 'Persistent storage claim mounted by workloads; nearing 100% space or inode exhaustion causes write errors.',
    },
  },
  node: {
    title: { 'zh-CN': 'Kubernetes 宿主机节点（Node）', en: 'Kubernetes host node' },
    description: {
      'zh-CN': 'L3 基础设施底座，承载多个 Pod 与本地卷；节点磁盘压力、内存压力或网络抖动会同时波及同机工作负载。',
      en: 'L3 infrastructure host running Pods and local volumes; node disk/memory pressure or network faults impact co-located workloads.',
    },
  },
  working_set: {
    title: { 'zh-CN': '容器常驻内存（memory_working_set）', en: 'Container memory working set' },
    description: {
      'zh-CN':
        'Kubernetes OOM Killer 判定依据的实际不可回收内存占用（匿名页 + 活跃文件缓存），比 RSS 更准确反映 OOM 风险。',
      en: 'Active non-reclaimable memory used by Kubernetes OOM killer decisions (anon + active cache); closer to OOM risk than raw RSS.',
    },
  },
  cpu_throttling: {
    title: { 'zh-CN': 'CPU 限流（CFS Throttling）', en: 'CPU CFS throttling' },
    description: {
      'zh-CN': '容器在单个 CFS 周期内用完 cpu.limit 配额而被强制挂起等待下个周期，常导致尾延迟（P99）飙升与探针超时。',
      en: 'Container paused by Linux CFS scheduler after exhausting cpu.limit quota within a period, causing tail latency spikes and probe timeouts.',
    },
  },
  connection_pool: {
    title: { 'zh-CN': '数据库连接池（connection_pool）', en: 'Database connection pool' },
    description: {
      'zh-CN': '应用到 PostgreSQL 的并发连接上限；活跃连接或等待队列打满会引发请求排队、超时与 5xx 扩散。',
      en: 'Bounded concurrent connections to PostgreSQL; pool saturation causes request queuing, timeouts, and 5xx cascades.',
    },
  },
};

function defaultComponentDescription(
  packName: string,
  ct: ComponentType,
  layer: OntologyLayer,
  lang: OntologyLang,
): string {
  const ns = ct.match.namespaces?.length ? ct.match.namespaces.join(', ') : null;
  if (lang === 'en') {
    const parts = [`Pack ${packName} component (${ct.match.kind}, layer ${layer})`];
    if (ns) {
      parts.push(`namespaces: ${ns}`);
    }
    if (ct.external) {
      parts.push('external upstream dependency outside the cluster');
    } else if (ct.hub) {
      parts.push('shared cluster hub');
    }
    if (ct.chains?.length) {
      parts.push(`evidence chains: ${ct.chains.slice(0, 4).join(', ')}`);
    }
    return parts.join(' · ');
  }
  const parts = [`来自领域包 ${packName} 的组件类型（${ct.match.kind} · 层级 ${layer}）`];
  if (ns) {
    parts.push(`命名空间 ${ns}`);
  }
  if (ct.external) {
    parts.push('集群外上游依赖');
  } else if (ct.hub) {
    parts.push('集群共享枢纽');
  }
  if (ct.chains?.length) {
    parts.push(`证据链：${ct.chains.slice(0, 4).join('、')}`);
  }
  return parts.join(' · ');
}

function defaultCardDescription(
  packName: string,
  chain: string | null,
  category: string | null,
  unit: string | null,
  lang: OntologyLang,
): string {
  if (lang === 'en') {
    const parts = [`Evidence card from pack ${packName}${chain ? ` (${chain})` : ''}`];
    if (category) {
      parts.push(`category: ${category}`);
    }
    if (unit && unit !== 'none') {
      parts.push(`unit: ${unit}`);
    }
    return parts.join(' · ');
  }
  const parts = [`领域包 ${packName}${chain ? `（${chain} 链路）` : ''} 的诊断证据卡`];
  if (category) {
    parts.push(`信号类别：${category}`);
  }
  if (unit && unit !== 'none') {
    parts.push(`单位：${unit}`);
  }
  return parts.join(' · ');
}

/** 从已加载的 PackRuntime 构建只读本体词汇表（纯函数，便于单测）。 */
export function buildOntologyGlossary(packs: PackRuntime, lang: OntologyLang = 'zh-CN'): OntologyGlossary {
  const component_types: OntologyGlossary['component_types'] = {};
  for (const p of packs.set.packs) {
    for (const ct of p.content.components.component_types) {
      const layer = inferComponentLayer(ct);
      const explicitDesc = pickLocale(ct.description, lang);
      const shortName = (ct.id.includes('.') ? ct.id.slice(ct.id.indexOf('.') + 1) : ct.id).toLowerCase();
      const conceptMatch = Object.hasOwn(BUILTIN_CONCEPTS, shortName) ? BUILTIN_CONCEPTS[shortName] : undefined;
      const title = conceptMatch ? conceptMatch.title[lang] : ct.id;
      const description =
        explicitDesc ||
        (conceptMatch ? conceptMatch.description[lang] : defaultComponentDescription(p.name, ct, layer, lang));
      const match: NonNullable<OntologyGlossary['component_types'][string]['match']> = {
        kind: ct.match.kind,
        ...(ct.match.api_group ? { api_group: ct.match.api_group } : {}),
        ...(ct.match.namespaces?.length ? { namespaces: [...ct.match.namespaces] } : {}),
        ...(ct.match.name_pattern ? { name_pattern: ct.match.name_pattern } : {}),
        ...(ct.match.labels && Object.keys(ct.match.labels).length > 0 ? { has_labels: true } : {}),
      };
      component_types[ct.id] = {
        title,
        description,
        layer,
        external: Boolean(ct.external),
        hub: Boolean(ct.hub),
        match,
      };
    }
  }

  const cards: OntologyGlossary['cards'] = {};
  for (const [key, entry] of packs.set.cards) {
    const title = pickLocale(entry.def.title, lang) || key;
    const unit = entry.def.display?.unit ?? null;
    const category = entry.def.category ?? null;
    const description =
      pickLocale(entry.def.description, lang) ||
      pickLocale(entry.def.note, lang) ||
      pickLocale(entry.def.check?.description, lang) ||
      defaultCardDescription(entry.pack, entry.chain, category, unit, lang);
    cards[key] = {
      title,
      description,
      unit,
      category,
    };
  }

  const concepts: OntologyGlossary['concepts'] = {};
  for (const [key, item] of Object.entries(BUILTIN_CONCEPTS)) {
    concepts[key] = {
      title: item.title[lang],
      description: item.description[lang],
    };
  }

  return {
    pack_lock: packs.set.lockDigest || null,
    component_types,
    cards,
    concepts,
  };
}

/** 按 RFC 9110 §13.1.2 弱比较匹配 If-None-Match（支持 `*`、逗号分隔列表与 `W/` 弱前缀）。 */
export function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch;
  const stripWeak = (s: string) => s.trim().replace(/^W\//i, '');
  const target = stripWeak(etag);
  return raw.split(',').some((part) => {
    const token = part.trim();
    return token === '*' || stripWeak(token) === target;
  });
}

export function registerOntologyRoutes(app: FastifyInstance, d: OntologyRouteDeps): void {
  const cache = new Map<OntologyLang, { lockDigest: string; etag: string; payload: string }>();

  app.get('/v1/ontology/glossary', async (req, reply) => {
    // x-srenautix-external: false：只允许带 read 权限的人类调用方（控制台与 Grafana 插件），拒绝 external 等服务调用方
    await d.auth.user(req, 'read');
    const q = req.query as { lang?: string };
    const lang: OntologyLang = q.lang === 'en' ? 'en' : 'zh-CN';
    const lockDigest = d.packs.set.lockDigest || 'none';
    let cached = cache.get(lang);
    if (!cached || cached.lockDigest !== lockDigest) {
      const body = buildOntologyGlossary(d.packs, lang);
      const payload = JSON.stringify(body);
      const etag = `"${createHash('sha256').update(payload).digest('hex').slice(0, 16)}"`;
      cached = { lockDigest, etag, payload };
      cache.set(lang, cached);
    }
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header('ETag', cached.etag);
    if (etagMatches(req.headers['if-none-match'], cached.etag)) {
      return reply.code(304).send();
    }
    return reply.type('application/json; charset=utf-8').send(cached.payload);
  });
}
