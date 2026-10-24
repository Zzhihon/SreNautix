import { INCIDENT_SYMPTOM_RULES, type SymptomType, type TypeRule } from '../research/targeting.js';

// 主动优化的症状类型（ADR 0146 §2.3）：在事件研判的集合（ADR 0133）上增加性能类的症状。只用于优化控制器的账本，
// 事件研判的检查与机制对应规则不变。

export type OptimizationSymptom =
  | SymptomType
  | 'seq_scan'
  | 'index'
  | 'temp_spill'
  | 'lock_wait'
  | 'io_read'
  | 'connection_pool'
  | 'cache_miss'
  | 'polling'
  | 'n_plus_one'
  | 'payload_size'
  | 'overprovision';

export const OPTIMIZATION_SYMPTOM_RULES: readonly TypeRule<OptimizationSymptom>[] = [
  ...INCIDENT_SYMPTOM_RULES,
  {
    type: 'seq_scan',
    mechanism: /顺序扫描|全表扫描|\b(?:seq(?:uential)? ?scan|full (?:table )?scan)/i,
    signal: /seq-scan|seqscan|sequential/,
  },
  {
    type: 'index',
    mechanism: /索引|\b(?:index|indexes|indices)\b/i,
    signal: /index/,
  },
  {
    type: 'temp_spill',
    mechanism: /临时文件|溢出到磁盘|落盘|\b(?:temp(?:orary)? (?:file|block)s?|spill|work_mem)/i,
    signal: /temp|spill|work-mem/,
  },
  {
    type: 'lock_wait',
    mechanism: /锁等待|等待锁|行锁|\b(?:lock wait|waiting for lock|row lock)/i,
    signal: /lock-wait|locks|wait-event/,
  },
  {
    type: 'io_read',
    mechanism: /磁盘读|物理读|块读取|缓存命中率|\b(?:disk read|blk_read|block read|buffer hit|io read)/i,
    signal: /blk-read|io-read|hit-ratio|buffer|read-time/,
  },
  {
    type: 'connection_pool',
    mechanism: /连接池|池饱和|连接等待|\b(?:connection pool|pool saturat|pgbouncer|max_connections)/i,
    signal: /pool|connections|max-connections/,
  },
  {
    type: 'cache_miss',
    mechanism: /缓存未命中|缓存失效|\b(?:cache miss|cache hit|evict)/i,
    signal: /cache|evict|hit-rate/,
  },
  {
    type: 'polling',
    mechanism: /轮询|高频调用|重复查询|\b(?:poll|polling|hot loop)/i,
    signal: /poll|calls-per|frequency/,
  },
  {
    type: 'n_plus_one',
    mechanism: /N\+1|逐条查询|循环中查询|\b(?:n\+1|n plus one)/i,
    signal: /n-plus-one|spans-per-request|repeat/,
  },
  {
    type: 'payload_size',
    mechanism: /请求体|响应体|负载大小|\b(?:payload|body size|response size|request size)/i,
    signal: /payload|body-size|bytes-per/,
  },
  {
    type: 'overprovision',
    mechanism:
      /request 过大|资源过量|超额申请|利用率低|\b(?:overprovision|over-provision|underutiliz|low utilization)/i,
    signal: /overprovision|utilization|right-size|usage-ratio/,
  },
];
