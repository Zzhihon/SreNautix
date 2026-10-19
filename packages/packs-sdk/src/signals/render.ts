// 信号查询模板的渲染（DESIGN §6.2）。模板一律用规范标签名书写（namespace、pod、container、
// node、persistentvolumeclaim），渲染后经官方解析器按标签档案改写，并注入外部标签 cluster。
//
// 可用变量：
//   $selector     按实体展开的标签匹配器（不含花括号）
//   $namespace    实体的命名空间
//   $name         实体名
//   $node         实体所在节点（拓扑给出时可用）
//   $rate_window  由抓取间隔推导的 rate 窗口
//   $window       卡片窗口的长度，用于 increase(x[$window]) 这类覆盖整个窗口的查询
//   $params.<名>  卡片与引用的参数

import type { LabelProfile, SignalAlternative } from '@srenautix/contract';
import { rateWindow, re2Escape, renameMap, type PromqlEngine } from '@srenautix/integration-sdk';

export interface RenderEntity {
  cluster_id: string;
  kind: string;
  namespace: string | null;
  name: string;
  node?: string | null;
}

export class RenderError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'RenderError';
  }
}

/** 控制器创建的 Pod 名：按工作负载类型匹配它的 Pod */
const POD_PATTERNS: Record<string, (name: string) => string> = {
  Deployment: (n) => `${re2Escape(n)}-[a-z0-9]{5,10}-[a-z0-9]{5}`,
  ReplicaSet: (n) => `${re2Escape(n)}-[a-z0-9]{5}`,
  StatefulSet: (n) => `${re2Escape(n)}-[0-9]+`,
  DaemonSet: (n) => `${re2Escape(n)}-[a-z0-9]{5}`,
  Job: (n) => `${re2Escape(n)}-[a-z0-9]{5}`,
  CronJob: (n) => `${re2Escape(n)}-[0-9]+-[a-z0-9]{5}`,
  // CNPG 的 Cluster 实例 Pod 为 <cluster>-<序号>
  Cluster: (n) => `${re2Escape(n)}-[0-9]+`,
};

const q = (v: string) => JSON.stringify(v);

/** 工作负载类实体对应 Pod 名的 RE2 模式；不是工作负载时为 null */
export function podPattern(e: RenderEntity): string | null {
  const p = POD_PATTERNS[e.kind];
  return p ? p(e.name) : null;
}

/** 实体的规范标签匹配器 */
export function selectorFor(e: RenderEntity): string {
  switch (e.kind) {
    case 'cluster':
      // 匹配全部序列（空标签也匹配 .*），用于集群范围的信号与探测
      return 'namespace=~".*"';
    case 'Node':
      return `node=${q(e.name)}`;
    case 'Namespace':
      return `namespace=${q(e.name)}`;
    case 'Pod':
      return `namespace=${q(need(e).namespace)},pod=${q(e.name)}`;
    case 'PersistentVolumeClaim':
      return `namespace=${q(need(e).namespace)},persistentvolumeclaim=${q(e.name)}`;
    default: {
      const pattern = POD_PATTERNS[e.kind];
      if (pattern) {
        return `namespace=${q(need(e).namespace)},pod=~${q(pattern(e.name))}`;
      }
      return e.namespace ? `namespace=${q(e.namespace)}` : 'namespace=~".*"';
    }
  }
}

function need(e: RenderEntity): { namespace: string } {
  if (!e.namespace) {
    throw new RenderError(`${e.kind} ${e.name} 缺少命名空间`);
  }
  return { namespace: e.namespace };
}

function secondsDuration(s: number): string {
  const r = Math.max(1, Math.round(s));
  if (r % 3600 === 0) {
    return `${r / 3600}h`;
  }
  return r % 60 === 0 ? `${r / 60}m` : `${r}s`;
}

export interface RenderContext {
  entity: RenderEntity;
  params: Record<string, number | string | boolean>;
  /** 卡片窗口长度（秒） */
  windowSeconds: number;
  profile: LabelProfile;
}

const VAR = /\$(selector|namespace|name|node|rate_window|window|params\.[a-zA-Z_][a-zA-Z0-9_]*)\b/g;

/** 替换模板变量；字符串值按双引号字符串的内容转义 */
export function substitute(template: string, ctx: RenderContext): string {
  const inner = (v: string) => JSON.stringify(v).slice(1, -1);
  const out = template.replace(VAR, (_m, v: string) => {
    switch (v) {
      case 'selector':
        return selectorFor(ctx.entity);
      case 'namespace':
        if (!ctx.entity.namespace) {
          throw new RenderError(`模板使用 $namespace，但 ${ctx.entity.kind} ${ctx.entity.name} 没有命名空间`);
        }
        return inner(ctx.entity.namespace);
      case 'name':
        return inner(ctx.entity.name);
      case 'node':
        if (!ctx.entity.node) {
          throw new RenderError(`模板使用 $node，但没有 ${ctx.entity.kind} ${ctx.entity.name} 所在的节点`);
        }
        return inner(ctx.entity.node);
      case 'rate_window':
        return rateWindow(ctx.profile);
      case 'window':
        return secondsDuration(ctx.windowSeconds);
      default: {
        const p = v.slice('params.'.length);
        if (!(p in ctx.params)) {
          throw new RenderError(`模板引用了未声明的参数 ${p}`);
        }
        const val = ctx.params[p]!;
        return typeof val === 'string' ? inner(val) : String(val);
      }
    }
  });
  const left = out.match(/\$[a-zA-Z_][a-zA-Z0-9_.]*/);
  if (left) {
    throw new RenderError(`模板中有未知变量 ${left[0]}`);
  }
  return out;
}

/** 渲染一个指标备选：替换变量 → 严格解析 → 按标签档案改写并注入集群标签 */
export function renderMetrics(
  engine: PromqlEngine,
  alt: SignalAlternative,
  ctx: RenderContext,
  template = alt.expr,
): string {
  const dialect = alt.dialect ?? 'promql';
  if (dialect !== 'promql' && dialect !== 'metricsql') {
    throw new RenderError(`指标信号不支持方言 ${dialect}`);
  }
  const text = substitute(template, ctx);
  const inject: Record<string, string> = ctx.profile.cluster ? { [ctx.profile.cluster]: ctx.entity.cluster_id } : {};
  return engine.rewrite(text, dialect, { rename: renameMap(ctx.profile), inject });
}
