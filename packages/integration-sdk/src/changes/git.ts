// changes/v1 的通用 git 适配器（DESIGN §10.3）：覆盖 GitHub、GitLab、Gitee、Gitea 等任何 git 服务。
// 读取本地克隆（由 reader 定期 fetch）在窗口内的提交，按路径映射到拓扑节点；只读，不修改仓库。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeEvent, ChangesListRequest, ChangesListResponse } from '@srenautix/contract';
import { assertWindowInClock, toMillis } from '../clock.js';
import { DatasourceError } from '../errors.js';

const run = promisify(execFile);

export interface GitChangesConfig {
  /** 集成实例 id，写进 change_id 与 source */
  id: string;
  /** 本地克隆的路径 */
  repo_dir: string;
  /** 只看这个分支（远端跟踪分支，例如 origin/main） */
  ref: string;
  /** 提交页面的链接模板，{sha} 替换为提交号；例如 https://git.example/org/repo/commit/{sha} */
  link_template: string | null;
  /** 路径前缀 → 拓扑节点；一个提交触及的全部映射的并集就是它的 targets */
  paths: Array<{ prefix: string; targets: string[]; kind: ChangeEvent['kind'] }>;
}

const SEP = '\u001f';
const REC = '\u001e';

export class GitChangesAdapter {
  constructor(readonly config: GitChangesConfig) {}

  /**
   * changes.list：返回窗口内触及映射路径的提交，新的在前。
   * 回放时由调用方给出 clock_window；窗口必须落在其中。
   */
  async list(req: ChangesListRequest, clock: { from: string; to: string }): Promise<ChangesListResponse> {
    assertWindowInClock(req.window, clock);
    const limit = req.limit ?? 200;
    let stdout: string;
    try {
      ({ stdout } = await run(
        'git',
        [
          '-C',
          this.config.repo_dir,
          'log',
          this.config.ref,
          `--since=${req.window.from}`,
          `--until=${req.window.to}`,
          '--no-merges',
          `--format=${REC}%H${SEP}%an <%ae>${SEP}%cI${SEP}%s`,
          '--name-only',
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      ));
    } catch (err) {
      throw new DatasourceError(this.config.id, `git log 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const from = toMillis(req.window.from);
    const to = toMillis(req.window.to);
    const events: ChangeEvent[] = [];
    for (const rec of stdout.split(REC).slice(1)) {
      const [head, ...files] = rec.split('\n');
      const [sha, actor, time, subject] = head!.split(SEP) as [string, string, string, string];
      const t = toMillis(time);
      // git 的 --since/--until 按提交时间过滤，精度为秒；按毫秒再确认一次
      if (t < from || t > to) {
        continue;
      }
      const hits = this.config.paths.filter((p) => files.some((f) => f && f.startsWith(p.prefix)));
      if (!hits.length) {
        continue;
      }
      const targets = [...new Set(hits.flatMap((h) => h.targets))].sort();
      if (req.scope.components.length && !targets.some((x) => req.scope.components.includes(x))) {
        continue;
      }
      events.push({
        change_id: `${this.config.id}:${sha}`,
        source: this.config.id,
        kind: hits[0]!.kind,
        refs: [sha.slice(0, 12)],
        revision: sha,
        actor,
        time: new Date(t).toISOString(),
        link: this.config.link_template ? this.config.link_template.replace('{sha}', sha) : null,
        targets,
        summary: subject.length > 500 ? subject.slice(0, 500) : subject,
      });
    }
    events.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.change_id < b.change_id ? -1 : 1));
    const truncated = events.length > limit;
    return { changes: truncated ? events.slice(0, limit) : events, truncated };
  }
}
