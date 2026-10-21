import { parseCardCheckId } from '../stage-a/card-checks.js';

// 推翻要有针对性（ADR 0133）：一张检查卡只有在它测的信号属于假设机制所预测的症状时，才能推翻这个假设。
// 信号与机制都归到同一组症状类型：检查的类型取检查 id（卡片检查 `cardcheck:<包>/<链>/<卡>@<组件>` 或查询模板
// `<包>/<id>`）里的名字，机制的类型取假设机制文字里的关键词（中英文）。两边都归不出类型时不做判断，检查照常计入。

export type SymptomType =
  | 'crash'
  | 'memory'
  | 'cpu'
  | 'startup'
  | 'readiness'
  | 'node'
  | 'network'
  | 'storage'
  | 'clock'
  | 'archive'
  | 'failover'
  | 'connections'
  | 'sync'
  | 'release'
  | 'service'
  | 'scrape';

interface TypeRule {
  type: SymptomType;
  /** 假设机制文字中预示这类症状的词 */
  mechanism: RegExp;
  /** 检查 id 的名字段中表示测这类信号的词 */
  signal: RegExp;
}

const RULES: readonly TypeRule[] = [
  {
    type: 'crash',
    mechanism: /重启|崩溃|不稳定|异常退出|退出码|被杀|\b(?:crash|restart|oom|unstable|exit code|killed)/i,
    signal: /restart|crash|exit|terminat|oom-kill/,
  },
  // "窗口内存在"一类的"内存在"不是内存
  { type: 'memory', mechanism: /内存(?!在)|工作集|\b(?:oom|memory|working set)/i, signal: /memory|oom/ },
  { type: 'cpu', mechanism: /节流|限流|\b(?:cpu|throttl)/i, signal: /cpu|throttl/ },
  {
    type: 'startup',
    mechanism: /初始化|启动|调度|镜像拉取|\b(?:init|podinitializ|startup|pending|schedul|image pull)/i,
    signal: /init|pending|waiting|startup|schedul|image/,
  },
  {
    type: 'readiness',
    mechanism: /就绪|探针|不可用|可用性|端点|\b(?:ready|readiness|probe|unavailable|availability|endpoint)/i,
    signal: /readiness|ready|instances-up|rw-endpoint|availability/,
  },
  {
    type: 'node',
    mechanism: /节点|驱逐|压力|\b(?:kubelet|node|evict|pressure)/i,
    signal: /node-health|pressure|evict/,
  },
  {
    type: 'network',
    mechanism: /网络|网卡|丢包|不可达|连通|\b(?:network|dns|packet|unreachable|connectivity)/i,
    signal: /network|dns|connectivity/,
  },
  {
    type: 'storage',
    mechanism: /磁盘|文件系统|写满|容量|余量|空间|卷|存储|\b(?:inode|disk|filesystem|capacity|volume|pvc|storage)/i,
    signal: /filesystem|disk|space|capacity|inode|pvc|volume|claim|wal-dir/,
  },
  { type: 'clock', mechanism: /时钟|时间偏差|时间校验|\b(?:clock|ntp|skew)/i, signal: /clock|ntp|node-time/ },
  {
    type: 'archive',
    mechanism: /归档|备份|对象存储|\b(?:wal\b|archiv|backup|barman|object ?store|s3\b)/i,
    signal: /wal|archiv|backup|barman|objectstore/,
  },
  {
    type: 'failover',
    mechanism: /切换|主库|复制|选主|\b(?:failover|switchover|primary|replica|leader)/i,
    signal: /failover|switchover|primary|replication|replica/,
  },
  {
    type: 'connections',
    mechanism: /连接|长事务|锁|饱和|死锁|慢查询|\b(?:connection|pool|transaction|lock|saturat|deadlock|slow quer)/i,
    signal: /connection|saturation|lock|transaction|deadlock|pool|statements|waits|rollbacks/,
  },
  {
    type: 'sync',
    mechanism: /同步|渲染|清单|\b(?:sync|argo|application|render|manifest)/i,
    signal: /sync|application|argocd|argo-cd/,
  },
  {
    type: 'release',
    mechanism:
      /发布|滚动|版本|镜像|部署|变更|迁移|门禁|熔断|\b(?:release|rollout|spec\b|version|image|deploy|change|migration|gate\b|breaker)/i,
    signal: /release|rollout|version|revision|replicasets|deploy|migration|gate|breaker|serving/,
  },
  {
    type: 'service',
    mechanism: /错误率|延迟|请求|上游|超时|错误|\b(?:5xx|error|latency|request|upstream|timeout)/i,
    signal: /error|latency|5xx|http|request|service-health/,
  },
  {
    type: 'scrape',
    mechanism: /抓取|采集|指标目标|指标端点|\b(?:scrape|target)/i,
    signal: /scrape|target-down|metrics-target/,
  },
];

/** 假设机制文字预示的症状类型 */
export function mechanismTypes(mechanism: string): Set<SymptomType> {
  return new Set(RULES.filter((r) => r.mechanism.test(mechanism)).map((r) => r.type));
}

function nameTypes(name: string): Set<SymptomType> {
  const n = name.toLowerCase();
  return new Set(RULES.filter((r) => r.signal.test(n)).map((r) => r.type));
}

/**
 * 检查测的卡片定义：卡片检查为 `<包>/<链>/<卡>`，查询模板为模板 id
 */
export function checkDefinition(check: string): string {
  return parseCardCheckId(check)?.card ?? check;
}

/** 只说明判定方式、不说明测什么的卡名：信号类型取证据链名 */
const GENERIC_NAMES: ReadonlySet<string> = new Set(['errors', 'condition', 'conditions', 'status', 'usage', 'health']);

/**
 * 检查测的信号的症状类型：先按卡名（定义的最后一段），卡名归不出类型或只是通用词时按证据链名，再按包名；
 * 例如 `workload/pod-restarts/memory` 测内存，`node/node-network/errors` 测网络，
 * `cchp-alerts/cnpg-instance-restarted/condition` 测重启
 */
export function signalTypes(check: string): Set<SymptomType> {
  const parts = checkDefinition(check).split('/').reverse();
  for (const p of parts) {
    if (GENERIC_NAMES.has(p.toLowerCase())) {
      continue;
    }
    const t = nameTypes(p);
    if (t.size) {
      return t;
    }
  }
  return new Set();
}

export interface Targeting {
  related: boolean;
  /** 判断依据，写入运行明细 */
  basis: string;
}

/**
 * 检查与假设机制是否对应：检查测的信号类型与机制预示的症状类型有交集；或检查测的卡片定义与假设的某张支持卡相同
 * （机制的症状已经在这个信号上出现）。任一边归不出类型时视为对应。
 */
export function targets(check: string, mechanism: string, supportDefinitions: ReadonlySet<string>): Targeting {
  const signal = signalTypes(check);
  if (signal.size === 0) {
    return { related: true, basis: '检查的信号类型未知' };
  }
  const mech = mechanismTypes(mechanism);
  if (mech.size === 0) {
    return { related: true, basis: '假设机制的症状类型未知' };
  }
  const shared = [...signal].filter((t) => mech.has(t));
  if (shared.length) {
    return { related: true, basis: `信号类型 ${shared.join('、')} 属于机制预示的症状` };
  }
  const def = checkDefinition(check);
  if (supportDefinitions.has(def)) {
    return { related: true, basis: `与支持卡同一定义 ${def}` };
  }
  return {
    related: false,
    basis: `检查测的是 ${[...signal].join('、')}，机制预示的症状是 ${[...mech].join('、')}`,
  };
}
