import { createHash } from 'node:crypto';
import { HttpError } from '../api/errors.js';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { addOverride, type TopologyOverride } from './overrides.js';

/** 覆盖规则 PR 的仓库：每个集群一个文件 <dir>/<cluster_id>.yaml */
export interface OverrideRepo {
  /** owner/name */
  repo: string;
  baseBranch: string;
  dir: string;
}

export interface OverridePrResult {
  pr_url: string;
  pr_number: number;
  branch: string;
  head_sha: string;
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
 * 为未映射的告警开覆盖规则的 PR（DESIGN §12）：在 srenautix/* 分支上修改 <dir>/<cluster_id>.yaml，开 PR，从不合并。
 * - 基础分支上已有同一集群、同一告警名的规则：409；
 * - 同一内容的分支已经存在（PR 已开过）：409；
 * - GitHub 拒绝 App 身份（未安装、私钥或 App id 不对）或不可达：503，带原因。
 */
export async function createOverridePr(
  gh: GitHubApp,
  s: OverrideRepo,
  o: TopologyOverride,
  requestedBy: string,
  /** 关联的事件 issue（例如 #12 或 owner/name#12）；PR 描述里写 Refs，GitHub 在 issue 上显示关联 */
  refs: string | null = null,
): Promise<OverridePrResult> {
  const path = `${s.dir.replace(/\/+$/, '')}/${o.cluster_id}.yaml`;
  const digest = createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8);
  const branch = `srenautix/topology-override-${slug(o.cluster_id)}-${slug(o.alertname)}-${digest}`;
  try {
    const base = await gh.api<{ object: { sha: string } }>(
      'GET',
      `/repos/${s.repo}/git/ref/heads/${encodeURIComponent(s.baseBranch)}`,
      undefined,
      'get_base_ref',
    );
    let existing: { content: string; sha: string } | null = null;
    try {
      const f = await gh.api<{ content: string; sha: string; encoding: string }>(
        'GET',
        `/repos/${s.repo}/contents/${path}?ref=${encodeURIComponent(s.baseBranch)}`,
        undefined,
        'get_file',
      );
      existing = { content: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha };
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) {
        throw e;
      }
    }
    const next = addOverride(existing?.content ?? null, path, o);
    if (next === null) {
      throw new HttpError(409, 'conflict', `${path} 中已有集群 ${o.cluster_id} 告警 ${o.alertname} 的覆盖规则`);
    }
    try {
      await gh.api(
        'POST',
        `/repos/${s.repo}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: base.object.sha },
        'create_branch',
      );
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) {
        throw new HttpError(409, 'conflict', `分支 ${branch} 已存在：这条覆盖规则的 PR 已经开过`);
      }
      throw e;
    }
    const put = await gh.api<{ commit: { sha: string } }>(
      'PUT',
      `/repos/${s.repo}/contents/${path}`,
      {
        message: `topology: map ${o.alertname} in ${o.cluster_id} to ${o.component} as ${o.role}`,
        content: Buffer.from(next).toString('base64'),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      },
      'put_file',
    );
    const pr = await gh.api<{ html_url: string; number: number }>(
      'POST',
      `/repos/${s.repo}/pulls`,
      {
        title: `topology: map ${o.alertname} (${o.cluster_id}) to ${o.component}`,
        head: branch,
        base: s.baseBranch,
        body: [
          `由 SreNautix 控制台为未映射的告警生成，发起人 ${requestedBy}。`,
          '',
          `- 集群：${o.cluster_id}`,
          `- 告警：${o.alertname}`,
          `- 组件：${o.component}`,
          `- 角色：${o.role}`,
          '',
          '合并后 server 在下一次重新加载拓扑覆盖目录时生效。',
          ...(refs ? ['', `Refs ${refs}`] : []),
        ].join('\n'),
        maintainer_can_modify: true,
      },
      'create_pull',
    );
    return { pr_url: pr.html_url, pr_number: pr.number, branch, head_sha: put.commit.sha };
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
