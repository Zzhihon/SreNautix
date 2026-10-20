import { GitHubError, type GitHubApp } from '../github/app.js';
import { logger } from '../log.js';
import type { TargetInfo, TargetResolver } from '../proposals/service.js';

/**
 * gitops_pr 的目标（GitRepository）不在集群拓扑里：UID 取参数中 base 分支当前的提交 SHA，
 * gateway 的 base_head 预检核对它与执行时的 base 一致（动作目录）。其余类型交给拓扑解析。
 * 没有配置 GitHub App、仓库或分支读不到时 UID 为 null，提议的 target_resolved 检查不通过。
 */
export class GitRepositoryTargets implements TargetResolver {
  constructor(
    private readonly inner: TargetResolver,
    private readonly github: () => GitHubApp | null,
  ) {}

  async resolve(
    clusterId: string,
    kind: string,
    namespace: string | null,
    name: string,
    params?: Record<string, unknown>,
  ): Promise<TargetInfo> {
    if (kind !== 'GitRepository') {
      return this.inner.resolve(clusterId, kind, namespace, name, params);
    }
    const gh = this.github();
    const base = typeof params?.base === 'string' ? params.base : null;
    if (!gh || !base) {
      return { uid: null, controllerManaged: false };
    }
    try {
      const r = await gh.api<{ object: { sha: string } }>(
        'GET',
        `/repos/${name}/git/ref/heads/${base.split('/').map(encodeURIComponent).join('/')}`,
        undefined,
        'get_base_ref',
      );
      return { uid: r.object.sha, controllerManaged: false };
    } catch (e) {
      if (!(e instanceof GitHubError)) {
        throw e;
      }
      logger.warn('读取 gitops_pr 的 base 分支失败', { repo: name, base, error: e.message });
      return { uid: null, controllerManaged: false };
    }
  }
}
