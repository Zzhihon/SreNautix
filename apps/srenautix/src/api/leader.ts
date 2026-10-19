import { hostname } from 'node:os';
import { ApiException, CoordinationV1Api, KubeConfig, V1MicroTime, type V1Lease } from '@kubernetes/client-node';
import { logger } from '../log.js';

export interface Leader {
  isLeader(): boolean;
  /** 成为主实例时 resolve。 */
  acquired(): Promise<void>;
  stop(): Promise<void>;
}

/** 单副本部署：始终是主实例。 */
export function singleLeader(): Leader {
  return { isLeader: () => true, acquired: async () => undefined, stop: async () => undefined };
}

/**
 * 用 Kubernetes Lease 选主（DESIGN §15.2：事件引擎、调度器与 Telegram 长轮询单活）。持有者身份是 Pod 名；
 * 每 duration/3 续约一次，续约失败或被别人取得时立即放弃主身份，单活工作在下一次检查时停止。
 */
export function leaseLeader(o: {
  namespace: string;
  name: string;
  durationMs: number;
  kubeconfigPath?: string;
  identity?: string;
}): Leader {
  const kc = new KubeConfig();
  if (o.kubeconfigPath) {
    kc.loadFromFile(o.kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  const api = kc.makeApiClient(CoordinationV1Api);
  const me = o.identity ?? process.env.POD_NAME ?? hostname();
  const durationS = Math.max(1, Math.round(o.durationMs / 1000));
  let leader = false;
  let stopped = false;
  let resolveAcquired: () => void = () => undefined;
  const acquired = new Promise<void>((r) => (resolveAcquired = r));

  const tryOnce = async () => {
    const now = new Date();
    let lease: V1Lease | null = null;
    try {
      lease = await api.readNamespacedLease({ name: o.name, namespace: o.namespace });
    } catch (e) {
      if (!(e instanceof ApiException && e.code === 404)) {
        throw e;
      }
    }
    const spec = lease?.spec;
    const renew = spec?.renewTime ? new Date(spec.renewTime).getTime() : 0;
    const expired = !spec?.holderIdentity || renew + (spec.leaseDurationSeconds ?? durationS) * 1000 < now.getTime();
    if (spec?.holderIdentity !== me && !expired) {
      leader = false;
      return;
    }
    const body: V1Lease = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: o.name,
        namespace: o.namespace,
        ...(lease?.metadata?.resourceVersion ? { resourceVersion: lease.metadata.resourceVersion } : {}),
      },
      spec: {
        holderIdentity: me,
        leaseDurationSeconds: durationS,
        acquireTime:
          spec?.holderIdentity === me && spec.acquireTime ? spec.acquireTime : new V1MicroTime(now.getTime()),
        renewTime: new V1MicroTime(now.getTime()),
        leaseTransitions: (spec?.leaseTransitions ?? 0) + (spec?.holderIdentity === me ? 0 : 1),
      },
    };
    try {
      if (lease) {
        await api.replaceNamespacedLease({ name: o.name, namespace: o.namespace, body });
      } else {
        await api.createNamespacedLease({ namespace: o.namespace, body });
      }
    } catch (e) {
      // 409：别的实例同时更新了 Lease，本轮不是主实例
      if (e instanceof ApiException && e.code === 409) {
        leader = false;
        return;
      }
      throw e;
    }
    if (!leader) {
      logger.info('成为主实例', { lease: `${o.namespace}/${o.name}`, identity: me });
    }
    leader = true;
    resolveAcquired();
  };

  const loop = async () => {
    while (!stopped) {
      try {
        await tryOnce();
      } catch (e) {
        if (leader) {
          logger.warn('Lease 续约失败，放弃主实例身份', { error: e });
        }
        leader = false;
      }
      await new Promise((r) => setTimeout(r, Math.max(500, o.durationMs / 3)).unref());
    }
  };
  void loop();
  return {
    isLeader: () => leader,
    acquired: () => acquired,
    stop: async () => {
      stopped = true;
      leader = false;
    },
  };
}
