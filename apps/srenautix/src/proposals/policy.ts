import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValid } from '@srenautix/contract';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../config/files.js';

/** gateway 策略（contract/gateway/v1/gateway-policy.schema.json）中 server 用到的部分。 */
export interface GatewayPolicy {
  version: 1;
  cluster: string;
  actions: Array<{ id: string; namespaces?: string[]; auto_execution?: { rules: string[]; namespaces: string[] } }>;
  max_auto_executions_per_hour?: number;
  self_dependencies?: {
    namespaces?: string[];
    nodes?: string[];
    pg_clusters?: Array<{ namespace: string; name: string }>;
  };
  approvers: Array<{ principal: string; namespaces: string[]; max_tier: 'L' | 'H' }>;
}

/**
 * 各集群 gateway 的生效策略，与 gateway 挂载同一份 Git 内容（DESIGN §12.3 策略与目录页）。目录下每个 *.yaml 是一个集群的策略；
 * REVISION 文件（git-sync 写入的提交 SHA）作为版本展示，没有时用内容哈希。
 */
export class Policies {
  constructor(
    private readonly byCluster: Map<string, GatewayPolicy>,
    readonly revision: string,
  ) {}

  static load(dir: string | undefined): Policies {
    if (!dir) {
      return new Policies(new Map(), 'none');
    }
    if (!existsSync(dir)) {
      throw new ConfigError(`策略目录不存在：${dir}`);
    }
    const h = createHash('sha256');
    const m = new Map<string, GatewayPolicy>();
    for (const f of readdirSync(dir)
      .filter((x) => /\.ya?ml$/.test(x))
      .sort()) {
      const text = readFileSync(join(dir, f), 'utf8');
      h.update(f).update('\0').update(text);
      const p = assertValid<GatewayPolicy>('gateway/v1/gateway-policy.schema.json', parseYaml(text));
      if (m.has(p.cluster)) {
        throw new ConfigError(`集群 ${p.cluster} 有两份策略`);
      }
      m.set(p.cluster, p);
    }
    const rev = join(dir, 'REVISION');
    return new Policies(m, existsSync(rev) ? readFileSync(rev, 'utf8').trim() : `sha256:${h.digest('hex')}`);
  }

  get(cluster: string): GatewayPolicy | undefined {
    return this.byCluster.get(cluster);
  }

  all(): GatewayPolicy[] {
    return [...this.byCluster.values()];
  }

  /** 动作在该集群是否启用、目标命名空间是否允许；返回不允许的原因。 */
  check(cluster: string, action: string, namespace: string | null): string | null {
    const p = this.byCluster.get(cluster);
    if (!p) {
      return `集群 ${cluster} 没有 gateway 策略`;
    }
    const a = p.actions.find((x) => x.id === action);
    if (!a) {
      return `动作 ${action} 在集群 ${cluster} 未启用`;
    }
    if (namespace !== null && !(a.namespaces ?? []).includes(namespace)) {
      return `动作 ${action} 不允许作用于命名空间 ${namespace}`;
    }
    return null;
  }

  /**
   * 自动执行的规则名（DESIGN §9.1）：动作在策略中带 auto_execution、目标命名空间在其中、规则名在允许列表里。
   * 不允许时返回 null。等级与自身依赖由调用方判断，每小时上限由 gateway 执行时核对。
   */
  autoRule(cluster: string, action: string, namespace: string | null, ruleName: string): string | null {
    const a = this.byCluster.get(cluster)?.actions.find((x) => x.id === action);
    const auto = a?.auto_execution;
    if (!auto || !auto.rules.includes(ruleName)) {
      return null;
    }
    if (namespace !== null && !auto.namespaces.includes(namespace)) {
      return null;
    }
    return ruleName;
  }

  /** 目标是否落在 SreNautix 自身的依赖集合内（自我保护）。 */
  selfDependency(cluster: string, kind: string, namespace: string | null, name: string): boolean {
    const s = this.byCluster.get(cluster)?.self_dependencies;
    if (!s) {
      return false;
    }
    if (namespace !== null && (s.namespaces ?? []).includes(namespace)) {
      return true;
    }
    if (kind === 'Node' && (s.nodes ?? []).includes(name)) {
      return true;
    }
    return (s.pg_clusters ?? []).some((c) => c.namespace === namespace && c.name === name);
  }
}
