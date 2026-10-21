import { createHash } from 'node:crypto';
import { HttpError } from '../api/errors.js';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { GitHubRepoReader } from '../remediation/github-repo.js';
import { filePatch } from '../remediation/patch.js';
import { addOverride, type TopologyOverride } from './overrides.js';

/** 覆盖规则 PR 的仓库：每个集群一个文件 <dir>/<cluster_id>.yaml */
export interface OverrideRepo {
  /** owner/name */
  repo: string;
  baseBranch: string;
  dir: string;
}

/** gitops_pr 提议的参数与基准提交（ADR 0025、0108：server 只读仓库，PR 由 gateway 的 gitops_pr 开出） */
export interface OverridePlan {
  path: string;
  branch: string;
  title: string;
  body: string;
  patch: string;
  /** 补丁基于的 base 分支提交 */
  base: string;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'x'
  );
}

/**
 * 为未映射的告警计划覆盖规则的 PR（DESIGN §12）：只读地取 base 分支上的 <dir>/<cluster_id>.yaml，追加规则，生成补丁。
 * - 基础分支上已有同一集群、同一告警名的规则：409；
 * - GitHub 拒绝 App 身份（未安装、私钥或 App id 不对）或不可达：503，带原因。
 * 分支名由集群、告警名与规则内容决定：同一条规则的提议幂等（ProposalService 的幂等键）。
 */
export async function planOverridePr(
  gh: GitHubApp,
  s: OverrideRepo,
  o: TopologyOverride,
  requestedBy: string,
): Promise<OverridePlan> {
  const path = `${s.dir.replace(/\/+$/, '')}/${o.cluster_id}.yaml`;
  const digest = createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8);
  const branch = `srenautix/topology-override-${slug(o.cluster_id)}-${slug(o.alertname)}-${digest}`;
  const reader = new GitHubRepoReader(gh, s.repo, s.baseBranch);
  try {
    const base = await reader.head();
    const existing = await reader.read(path);
    const next = addOverride(existing, path, o);
    if (next === null) {
      throw new HttpError(409, 'conflict', `${path} 中已有集群 ${o.cluster_id} 告警 ${o.alertname} 的覆盖规则`);
    }
    return {
      path,
      branch,
      base,
      title: `topology: map ${o.alertname} (${o.cluster_id}) to ${o.component}`,
      body: [
        `由 SreNautix 控制台为未映射的告警生成，发起人 ${requestedBy}。`,
        '',
        `- 集群：${o.cluster_id}`,
        `- 告警：${o.alertname}`,
        `- 组件：${o.component}`,
        `- 角色：${o.role}`,
        '',
        '合并后 server 在下一次重新加载拓扑覆盖目录时生效。',
      ].join('\n'),
      patch: filePatch(path, existing, next),
    };
  } catch (e) {
    if (e instanceof GitHubError) {
      const why =
        e.status === 0
          ? 'GitHub 不可达'
          : e.status === 401 || e.op === 'installation_token'
            ? 'GitHub App 身份无效或没有安装到仓库'
            : e.status === 403 || e.status === 404
              ? `GitHub App 没有仓库 ${s.repo} 的权限，或仓库、分支 ${s.baseBranch} 不存在`
              : 'GitHub 请求失败';
      throw new HttpError(503, 'unavailable', `${why}：${e.message}`);
    }
    throw e;
  }
}
