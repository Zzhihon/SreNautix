import type pg from 'pg';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { appendAudit } from '../store/audit.js';
import { tx, type Queryable } from '../store/pool.js';
import { GitHubError, type GitHubApp } from './app.js';
import { backoffMs, MAX_ATTEMPTS, openedLastHour } from './issues.js';

/**
 * 拓扑与领域包覆盖的缺口（ADR 0171）：成员告警没有命中任何告警目录条目（也没有拓扑覆盖）时，每个 (集群, 告警名) 在 ops
 * 仓库开一个 issue，由人决定是否补齐，不开自愈 PR。与事件 issue（ADR 0095）、业务 issue（ADR 0146）同一套机制：
 * - 缺口记在 server.coverage_gaps，出现过的事件记在 server.coverage_gap_incidents；
 * - issue 正文带标记 srenautix:coverage=<集群>/<告警名>。创建请求的结果未知（超时、连接中断、5xx）时记为 unknown，下一次
 *   先按标记在仓库中找回，找不到才再次创建，重试不会重复开 issue；
 * - 标签为 issues.labels 加 coverage；每小时新开的数量与事件 issue 共用 issues.max_per_hour（同一仓库最近 1 小时开出的事件
 *   issue 与覆盖 issue 的合计），达到上限时推迟到之后的轮次；
 * - 同一缺口出现在新的事件里时只在 issue 下追加评论；人关闭 issue 之后不再重开，也不再评论，只在状态库里计数；
 * - GitHub 失败时按退避重试，开出最多 MAX_ATTEMPTS 次；开出、找回、放弃、评论与关闭写治理审计。
 * 只用 GitHub App 的安装令牌，请求都在 ops 仓库角色的白名单内（开 issue、评论、读取 issue）。
 */
export interface CoverageSettings {
  /** owner/name：事件 issue 的仓库（issues.repo） */
  repo: string;
  /** issues.labels；覆盖 issue 另加 coverage */
  labels: string[];
  /** 标题前缀，例如 "[影子]"；空字符串表示没有 */
  titlePrefix: string;
  /** issues.max_per_hour，与事件 issue 共用 */
  maxPerHour: number;
  /** 只登记最近这段时间内更新过的事件里的缺口（issues.lookback） */
  lookbackMs: number;
  consoleUrl: string;
  language: 'zh' | 'en';
}

export const COVERAGE_LABEL = 'coverage';
/** 达到每小时上限时推迟这么久再试 */
export const RATE_LIMIT_DEFER_MS = 10 * 60_000;
/** 正文与评论最多列出的事件数；其余只计数，完整列表在控制台 */
export const MAX_LISTED_INCIDENTS = 20;

export const coverageMarker = (clusterId: string, alertname: string) =>
  `<!-- srenautix:coverage=${clusterId}/${alertname} -->`;
const commentMarker = (clusterId: string, alertname: string) =>
  `<!-- srenautix:coverage-comment=${clusterId}/${alertname} -->`;

/** 结果未知的失败：请求可能已经被 GitHub 处理 */
const unknownOutcome = (e: GitHubError) => e.status === 0 || e.status >= 500;

interface GapRow {
  cluster_id: string;
  alertname: string;
  repo: string;
  state: 'pending' | 'unknown' | 'open' | 'closed' | 'failed';
  number: number | null;
  url: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  attempts: number;
}

interface Occurrence {
  incident_id: string;
  label: string;
  seen_at: Date;
}

const T = {
  zh: {
    title: (alertname: string, cluster: string) => `覆盖缺口：告警 ${alertname} 没有告警目录条目（集群 ${cluster}）`,
    lead: (alertname: string, cluster: string) =>
      `**覆盖缺口**：告警 \`${alertname}\`（集群 \`${cluster}\`）没有命中任何告警目录条目，也没有拓扑覆盖。这样的告警按默认规则分类（角色与置信度来自标签或默认值），归属只能按标签推断，阶段 A 不为它执行目录条目声明的证据链。`,
    facts: '缺口',
    count: (n: number) => `出现次数：${n} 个事件`,
    first: (at: string) => `首次出现：${at}`,
    last: (at: string) => `最近一次出现：${at}`,
    labels: (l: string) => `最近一次触发的标签：${l}`,
    incidents: '涉及事件',
    more: (n: number, url: string) => `另有 ${n} 个事件，见[控制台](${url})`,
    how: '怎样补齐',
    steps: (topology: string) => [
      '在领域包的告警目录（`<领域包>/alerts.yaml`）为这条告警加一条条目，写明角色（cause、symptom、meta）与实体：标签契约的 `entity` 与 `entity_kind`，或命名对象的标签（deployment、statefulset、pod 等）。告警规则只带分组标签时，先在规则上加 `entity` 与 `entity_kind` 标签，否则条目也给不出实体。',
      `只需要把告警映射到拓扑对象时，在控制台的[拓扑覆盖页](${topology})加一条覆盖，保存时 server 开出覆盖 PR。`,
      '条目或覆盖合并、同步之后，新触发的告警会命中它们。',
    ],
    close: '不需要补齐时关闭这个 issue：SreNautix 不会再为这条告警开 issue，也不再评论。',
    footer: '由 SreNautix 生成；这条告警出现在新的事件里时追加在评论里。',
    again: (alertname: string, n: number, total: number) =>
      `告警 \`${alertname}\` 又出现在 ${n} 个事件里（累计 ${total} 个事件）：`,
  },
  en: {
    title: (alertname: string, cluster: string) =>
      `Coverage gap: alert ${alertname} has no catalog entry (cluster ${cluster})`,
    lead: (alertname: string, cluster: string) =>
      `**Coverage gap**: alert \`${alertname}\` (cluster \`${cluster}\`) matches no alert catalog entry and no topology override. Such an alert is classified by the default rules (role and confidence from its labels or defaults), its owner can only be inferred from labels, and stage A runs no evidence chain declared by a catalog entry for it.`,
    facts: 'Gap',
    count: (n: number) => `Incidents with this alert: ${n}`,
    first: (at: string) => `First seen: ${at}`,
    last: (at: string) => `Last seen: ${at}`,
    labels: (l: string) => `Labels of the latest firing: ${l}`,
    incidents: 'Incidents',
    more: (n: number, url: string) => `${n} more incidents, see the [console](${url})`,
    how: 'How to close the gap',
    steps: (topology: string) => [
      'Add an entry for this alert to a pack alert catalog (`<pack>/alerts.yaml`) with its role (cause, symptom, meta) and entity: the label contract `entity` and `entity_kind`, or the labels naming an object (deployment, statefulset, pod and so on). When the rule only carries grouping labels, add `entity` and `entity_kind` to the rule first, otherwise the entry cannot give an entity either.',
      `When the alert only needs to map to a topology object, add an override on the console [topology coverage page](${topology}); saving it makes the server open an override PR.`,
      'Once the entry or override is merged and synced, new firings of the alert match it.',
    ],
    close:
      'Close this issue when the gap needs no fix: SreNautix will not open another issue for this alert and will not comment again.',
    footer: 'Generated by SreNautix; new incidents with this alert are added as comments.',
    again: (alertname: string, n: number, total: number) =>
      `Alert \`${alertname}\` appeared in new incidents: ${n} (${total} in total):`,
  },
};

export class CoverageIssues {
  constructor(
    private readonly pool: pg.Pool,
    private readonly gh: GitHubApp,
    private readonly s: CoverageSettings,
    private readonly metrics: ServerMetrics,
  ) {}

  /** 后台一轮：登记缺口 → 开出到期的 issue → 为新出现的事件追加评论 */
  async runOnce(): Promise<void> {
    await this.scan();
    for (const g of await this.due("state IN ('pending', 'unknown')")) {
      await this.openOne(g.cluster_id, g.alertname);
    }
    for (const g of await this.due(
      `state = 'open' AND EXISTS (SELECT 1 FROM server.coverage_gap_incidents x
         WHERE x.cluster_id = g.cluster_id AND x.alertname = g.alertname AND x.reported_at IS NULL)`,
    )) {
      await this.commentOne(g.cluster_id, g.alertname);
    }
  }

  /**
   * 登记缺口：最近 lookback 内更新过、没有被抑制或合并的事件中，仍在事件里、分类没有命中告警目录条目的成员告警。
   * 每个 (集群, 告警名, 事件) 记一行；同一告警在事件里有多条（不同的标签集）时取最早开始的一条
   */
  async scan(): Promise<void> {
    await this.pool.query(
      `WITH m AS (
         SELECT i.cluster_id, a.alertname, i.incident_id,
                (array_agg(a.alert_id ORDER BY a.starts_at, a.alert_id))[1] AS alert_id, min(a.starts_at) AS seen_at
           FROM server.incidents i
           CROSS JOIN LATERAL jsonb_array_elements(i.body->'members') mem
           JOIN server.alert_state a ON a.alert_id = mem->>'alert_id'
          WHERE NOT i.suppressed AND i.state <> 'merged' AND i.updated_at > now() - make_interval(secs => $2)
            AND mem->>'left_version' IS NULL
            AND coalesce(a.classification->>'catalog_entry', '') = ''
          GROUP BY i.cluster_id, a.alertname, i.incident_id
       ), gaps AS (
         INSERT INTO server.coverage_gaps (cluster_id, alertname, repo, state, first_seen_at, last_seen_at)
         SELECT cluster_id, alertname, $1, 'pending', min(seen_at), max(seen_at) FROM m GROUP BY cluster_id, alertname
         ON CONFLICT (cluster_id, alertname) DO UPDATE
           SET first_seen_at = least(server.coverage_gaps.first_seen_at, excluded.first_seen_at),
               last_seen_at = greatest(server.coverage_gaps.last_seen_at, excluded.last_seen_at),
               updated_at = now()
           WHERE excluded.first_seen_at < server.coverage_gaps.first_seen_at
              OR excluded.last_seen_at > server.coverage_gaps.last_seen_at
       )
       INSERT INTO server.coverage_gap_incidents (cluster_id, alertname, incident_id, alert_id, seen_at)
       SELECT cluster_id, alertname, incident_id, alert_id, seen_at FROM m
       ON CONFLICT (cluster_id, alertname, incident_id) DO NOTHING`,
      [this.s.repo, this.s.lookbackMs / 1000],
    );
  }

  private async due(where: string): Promise<Array<{ cluster_id: string; alertname: string }>> {
    const r = await this.pool.query<{ cluster_id: string; alertname: string }>(
      `SELECT cluster_id, alertname FROM server.coverage_gaps g WHERE next_attempt_at <= now() AND ${where}
        ORDER BY first_seen_at LIMIT 20`,
    );
    return r.rows;
  }

  /** 开出一个缺口的 issue（或按标记找回）；达到每小时上限时推迟 */
  async openOne(clusterId: string, alertname: string): Promise<void> {
    await tx(this.pool, async (c) => {
      const row = await this.lock(c, clusterId, alertname);
      if (!row || (row.state !== 'pending' && row.state !== 'unknown')) {
        return;
      }
      const opened = await openedLastHour(c, row.repo);
      if (opened >= this.s.maxPerHour) {
        const note = `仓库 ${row.repo} 最近 1 小时已开 ${opened} 个 issue（事件 issue 与覆盖 issue 合计），达到上限 ${this.s.maxPerHour}，稍后再开`;
        await c.query(
          `UPDATE server.coverage_gaps SET last_error = $3, next_attempt_at = now() + make_interval(secs => $4),
             updated_at = now() WHERE cluster_id = $1 AND alertname = $2`,
          [clusterId, alertname, note, RATE_LIMIT_DEFER_MS / 1000],
        );
        this.metrics.coverageIssues.inc({ repo: row.repo, outcome: 'deferred' });
        logger.info('覆盖 issue 达到每小时上限，推迟', { cluster_id: clusterId, alertname, repo: row.repo });
        return;
      }
      try {
        const found = row.state === 'unknown' ? await this.findByMarker(row.repo, clusterId, alertname) : null;
        const issue = found ?? (await this.create(c, row));
        await c.query(
          `UPDATE server.coverage_gaps SET state = 'open', number = $3, url = $4, opened_at = now(), attempts = 0,
             last_error = NULL, next_attempt_at = now(), updated_at = now() WHERE cluster_id = $1 AND alertname = $2`,
          [clusterId, alertname, issue.number, issue.url],
        );
        // 新开出的 issue 正文列出了已登记的全部事件；找回的 issue 正文是之前某次创建时的内容，不知道列到了哪里，
        // 已登记的事件都以评论追加一次
        if (!found) {
          await c.query(
            `UPDATE server.coverage_gap_incidents SET reported_at = now()
              WHERE cluster_id = $1 AND alertname = $2 AND reported_at IS NULL`,
            [clusterId, alertname],
          );
        }
        await appendAudit(c, 'github.coverage_issue_opened', 'server', {
          cluster_id: clusterId,
          alertname,
          repo: row.repo,
          number: issue.number,
          url: issue.url,
          recovered: found !== null,
        });
        this.metrics.coverageIssues.inc({ repo: row.repo, outcome: found ? 'recovered' : 'opened' });
        logger.info('覆盖 issue 已开', { cluster_id: clusterId, alertname, url: issue.url, recovered: !!found });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = row.attempts + 1;
        const give = attempts >= MAX_ATTEMPTS;
        // 结果未知的失败之后，状态保持 unknown，直到按标记找回或确认没有开出
        const state = give ? 'failed' : row.state === 'unknown' || unknownOutcome(e) ? 'unknown' : 'pending';
        await c.query(
          `UPDATE server.coverage_gaps SET state = $3, attempts = $4, last_error = $5,
             next_attempt_at = now() + make_interval(secs => $6), updated_at = now()
           WHERE cluster_id = $1 AND alertname = $2`,
          [clusterId, alertname, state, attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        if (give) {
          await appendAudit(c, 'github.coverage_issue_failed', 'server', {
            cluster_id: clusterId,
            alertname,
            repo: row.repo,
            attempts,
            error: e.message.slice(0, 500),
          });
        }
        this.metrics.coverageIssues.inc({ repo: row.repo, outcome: give ? 'failed' : 'retry' });
        logger.warn(give ? '覆盖 issue 重试用尽，放弃' : '覆盖 issue 开出失败，稍后重试', {
          cluster_id: clusterId,
          alertname,
          attempts,
          error: e.message,
        });
      }
    });
  }

  /** 为新出现的事件追加一条评论；issue 已被人关闭时记为 closed，不再评论 */
  async commentOne(clusterId: string, alertname: string): Promise<void> {
    await tx(this.pool, async (c) => {
      const row = await this.lock(c, clusterId, alertname);
      if (!row || row.state !== 'open' || row.number === null) {
        return;
      }
      const fresh = await this.occurrences(c, clusterId, alertname, true);
      if (!fresh.length) {
        return;
      }
      try {
        if (!(await this.isOpen(row.repo, row.number))) {
          await c.query(
            `UPDATE server.coverage_gaps SET state = 'closed', closed_at = now(), updated_at = now()
              WHERE cluster_id = $1 AND alertname = $2`,
            [clusterId, alertname],
          );
          await appendAudit(c, 'github.coverage_issue_closed', 'server', {
            cluster_id: clusterId,
            alertname,
            repo: row.repo,
            number: row.number,
          });
          this.metrics.coverageIssues.inc({ repo: row.repo, outcome: 'closed' });
          logger.info('覆盖 issue 已被关闭，不再评论', { cluster_id: clusterId, alertname, url: row.url });
          return;
        }
        const total = await this.count(c, clusterId, alertname);
        const t = T[this.s.language];
        const body = [
          commentMarker(clusterId, alertname),
          t.again(alertname, fresh.length, total),
          '',
          ...this.list(fresh, clusterId),
        ].join('\n');
        await this.gh.api(
          'POST',
          `/repos/${row.repo}/issues/${row.number}/comments`,
          { body: body.slice(0, 60_000) },
          'create_comment',
        );
        await c.query(
          `UPDATE server.coverage_gap_incidents SET reported_at = now()
            WHERE cluster_id = $1 AND alertname = $2 AND incident_id = ANY($3::uuid[])`,
          [clusterId, alertname, fresh.map((o) => o.incident_id)],
        );
        await c.query(
          `UPDATE server.coverage_gaps SET attempts = 0, last_error = NULL, updated_at = now()
            WHERE cluster_id = $1 AND alertname = $2`,
          [clusterId, alertname],
        );
        await appendAudit(c, 'github.coverage_issue_comment', 'server', {
          cluster_id: clusterId,
          alertname,
          repo: row.repo,
          number: row.number,
          incidents: fresh.map((o) => o.incident_id),
        });
        this.metrics.coverageIssues.inc({ repo: row.repo, outcome: 'commented' });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = row.attempts + 1;
        await c.query(
          `UPDATE server.coverage_gaps SET attempts = $3, last_error = $4,
             next_attempt_at = now() + make_interval(secs => $5), updated_at = now()
           WHERE cluster_id = $1 AND alertname = $2`,
          [clusterId, alertname, attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        this.metrics.coverageIssues.inc({ repo: row.repo, outcome: 'retry' });
        logger.warn('覆盖 issue 的评论失败，稍后重试', { cluster_id: clusterId, alertname, error: e.message });
      }
    });
  }

  private async lock(c: Queryable, clusterId: string, alertname: string): Promise<GapRow | undefined> {
    const r = await c.query<GapRow>(
      `SELECT cluster_id, alertname, repo, state, number, url, first_seen_at, last_seen_at, attempts
         FROM server.coverage_gaps WHERE cluster_id = $1 AND alertname = $2 FOR UPDATE`,
      [clusterId, alertname],
    );
    return r.rows[0];
  }

  /** 缺口出现过的事件，按开始触发的时间倒序；onlyNew 时只取还没有写进 issue 的 */
  private async occurrences(
    c: Queryable,
    clusterId: string,
    alertname: string,
    onlyNew: boolean,
  ): Promise<Occurrence[]> {
    const r = await c.query<Occurrence>(
      `SELECT x.incident_id, coalesce(i.label, x.incident_id::text) AS label, x.seen_at
         FROM server.coverage_gap_incidents x LEFT JOIN server.incidents i USING (incident_id)
        WHERE x.cluster_id = $1 AND x.alertname = $2 AND ($3 = false OR x.reported_at IS NULL)
        ORDER BY x.seen_at DESC, x.incident_id`,
      [clusterId, alertname, onlyNew],
    );
    return r.rows;
  }

  private async count(c: Queryable, clusterId: string, alertname: string): Promise<number> {
    const r = await c.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM server.coverage_gap_incidents WHERE cluster_id = $1 AND alertname = $2',
      [clusterId, alertname],
    );
    return r.rows[0]!.n;
  }

  private base(): string {
    return this.s.consoleUrl.replace(/\/+$/, '');
  }

  /** 事件列表：最多 MAX_LISTED_INCIDENTS 条，其余给出控制台入口 */
  private list(items: readonly Occurrence[], clusterId: string): string[] {
    const t = T[this.s.language];
    const lines = items
      .slice(0, MAX_LISTED_INCIDENTS)
      .map((o) => `- [${o.label}](${this.base()}/incidents/${o.incident_id}) · ${o.seen_at.toISOString()}`);
    if (items.length > MAX_LISTED_INCIDENTS) {
      lines.push(
        `- ${t.more(items.length - MAX_LISTED_INCIDENTS, `${this.base()}/incidents?cluster=${encodeURIComponent(clusterId)}`)}`,
      );
    }
    return lines;
  }

  /** issue 的标题与正文：标记、缺口的事实（出现次数、首次与最近一次出现、标签）、涉及事件、补齐说明与控制台入口 */
  async render(c: Queryable, row: GapRow): Promise<{ title: string; body: string }> {
    const t = T[this.s.language];
    const all = await this.occurrences(c, row.cluster_id, row.alertname, false);
    const latest = all[0];
    const labels = latest
      ? (
          await c.query<{ labels: Record<string, string> }>(
            'SELECT labels FROM server.alert_state a JOIN server.coverage_gap_incidents x USING (alert_id) WHERE x.cluster_id = $1 AND x.alertname = $2 AND x.incident_id = $3',
            [row.cluster_id, row.alertname, latest.incident_id],
          )
        ).rows[0]?.labels
      : undefined;
    const shown = Object.entries(labels ?? {})
      .filter(([k]) => k !== 'alertname')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `\`${k}=${v}\``)
      .join('、');
    const topology = `${this.base()}/topology?view=coverage&cluster=${encodeURIComponent(row.cluster_id)}`;
    const body = [
      coverageMarker(row.cluster_id, row.alertname),
      t.lead(row.alertname, row.cluster_id),
      '',
      `### ${t.facts}`,
      '',
      `- ${t.count(all.length)}`,
      `- ${t.first(row.first_seen_at.toISOString())}`,
      `- ${t.last(row.last_seen_at.toISOString())}`,
      ...(shown ? [`- ${t.labels(shown)}`] : []),
      '',
      `### ${t.incidents}`,
      '',
      ...this.list(all, row.cluster_id),
      '',
      `### ${t.how}`,
      '',
      ...t.steps(topology).map((s, i) => `${i + 1}. ${s}`),
      '',
      t.close,
      '',
      `---\n${t.footer}`,
    ].join('\n');
    const prefix = this.s.titlePrefix ? `${this.s.titlePrefix} ` : '';
    return { title: `${prefix}${t.title(row.alertname, row.cluster_id)}`.slice(0, 250), body: body.slice(0, 60_000) };
  }

  private async create(c: Queryable, row: GapRow): Promise<{ number: number; url: string }> {
    const content = await this.render(c, row);
    const r = await this.gh.api<{ number: number; html_url: string }>(
      'POST',
      `/repos/${row.repo}/issues`,
      { title: content.title, body: content.body, labels: [...new Set([...this.s.labels, COVERAGE_LABEL])] },
      'create_issue',
    );
    return { number: r.number, url: r.html_url };
  }

  private async findByMarker(
    repo: string,
    clusterId: string,
    alertname: string,
  ): Promise<{ number: number; url: string } | null> {
    const marker = coverageMarker(clusterId, alertname);
    const list = await this.gh.api<
      Array<{ number: number; html_url: string; body: string | null; pull_request?: unknown }>
    >(
      'GET',
      `/repos/${repo}/issues?labels=${encodeURIComponent(COVERAGE_LABEL)}&state=all&sort=created&direction=desc&per_page=100`,
      undefined,
      'list_issues',
    );
    const hit = list.find((i) => !i.pull_request && (i.body ?? '').includes(marker));
    return hit ? { number: hit.number, url: hit.html_url } : null;
  }

  private async isOpen(repo: string, number: number): Promise<boolean> {
    const r = await this.gh.api<{ state: string }>('GET', `/repos/${repo}/issues/${number}`, undefined, 'get_issue');
    return r.state === 'open';
  }
}
