import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import canonicalize from 'canonicalize';
import type pg from 'pg';
import { parseAllDocuments } from 'yaml';
import type { FixExpect, Label } from './labels.js';
import type { RunRecord } from './score.js';

// 自愈 PR 环节的度量（章程第二阶段 §3、§4 第 5 条，ADR 0110）：
// - PR 触发率：标注有仓库修复、结论为 likely 或 evidence_consistent 的运行中，提议了 gitops_pr 的比例；
//   标注没有仓库修复的运行提议了 gitops_pr 记为误触发；
// - 补丁可应用率：gitops_pr 的补丁对 as_of 时刻 base 分支的提交 `git apply --check` 通过的比例
//   （用临时索引文件，不检出、不改动工作区）；
// - 补丁正确率：应用后，标注的每个期望（文件、文档选择、JSON Pointer、取值）都成立的比例。
// - 模板匹配（ADR 0138）：自愈 PR 由 server 按修复模板生成，不是模型的提议。重建评测按每次运行的研判结论（根因、档位、
//   处置）对快照的阶段 A 卡与成员告警求值修复模板的适用条件，只匹配、不计划、不推送：标注有仓库修复、结论 likely
//   及以上的运行中，标注修复类别的模板适用的比例记为模板触发；标注没有仓库修复的运行中适用的模板按类别记为误触发。
// 影子环境（只读状态库）：gitops_pr 提议与事件关联的 PR 数，与研判结论为 likely 及以上的事件数对照。

export const REPAIR_LEVELS = new Set(['likely', 'evidence_consistent']);

export interface PatchCheck {
  case: string;
  route: string;
  run: number;
  base: string | null;
  applies: boolean;
  correct: boolean;
  detail: string;
}

/** 标注的修复类别 → 修复模板的类别 */
export const FIX_CLASS_CATEGORY: Record<string, string> = {
  release_rollback: 'release_rollback',
  config_resource: 'config_resource',
  alert_rule: 'alert_rule',
  topology_pack: 'topology_coverage',
};

export interface TemplateMatch {
  case: string;
  route: string;
  run: number;
  level: string | null;
  disposition: string | null;
  templates: string[];
}

export interface RemediationSummary {
  eligible_runs: number;
  triggered_runs: number;
  false_triggers: number;
  patches: number;
  applicable: number;
  correct: number;
  checks: PatchCheck[];
  /** 模板匹配（只在给出 templatesOf 时计算）：标注有仓库修复、结论 likely 及以上、标注类别的模板适用的运行 */
  template_triggered_runs?: number;
  /** 同一批运行中有任何修复模板适用的 */
  template_any_runs?: number;
  /** 标注没有仓库修复、结论 likely 及以上的运行中适用的模板，按类别计数 */
  template_false_triggers?: Record<string, number>;
  template_matches?: TemplateMatch[];
}

function git(repo: string, args: string[], env: Record<string, string>, input?: string): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** base 分支（优先取 origin/<分支>）在时刻 at 的提交（as_of 时仓库的状态）；没有时为 null */
export function baseCommit(repo: string, branch: string, at: string): string | null {
  const remote = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const ref = remote.status === 0 ? `origin/${branch}` : branch;
  const out = git(repo, ['rev-list', '-1', `--before=${at}`, ref], {}).trim();
  return out || null;
}

function at(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function pointer(doc: unknown, p: string): unknown {
  if (p === '') {
    return doc;
  }
  let cur: unknown = doc;
  for (const raw of p.slice(1).split('/')) {
    const seg = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 文件内容（JSON 或多文档 YAML）中按选择与 JSON Pointer 取值 */
export function expectedHolds(content: string, path: string, e: FixExpect): { ok: boolean; got: unknown } {
  const docs = path.endsWith('.json')
    ? [JSON.parse(content) as unknown]
    : parseAllDocuments(content).map((d) => d.toJS() as unknown);
  const doc = docs.find((d) => Object.entries(e.select).every(([k, v]) => at(d, k) === v));
  if (doc === undefined) {
    return { ok: false, got: undefined };
  }
  const got = pointer(doc, e.pointer);
  return { ok: canonicalize(got) === canonicalize(e.value), got };
}

/**
 * 在 base 提交上检查补丁：可应用（git apply --check --cached），应用后标注的期望是否成立。
 * 使用 scratch 目录下的临时索引文件，结束时删除。
 */
export function checkPatch(
  repo: string,
  base: string,
  patch: string,
  expect: readonly FixExpect[],
  scratch: string,
): { applies: boolean; correct: boolean; detail: string } {
  const dir = mkdtempSync(join(scratch, 'patch-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(repo, ['read-tree', base], env);
    try {
      git(repo, ['apply', '--check', '--cached', '-'], env, patch);
    } catch (e) {
      return {
        applies: false,
        correct: false,
        detail: `git apply --check 失败：${String((e as { stderr?: string }).stderr ?? e).slice(0, 300)}`,
      };
    }
    git(repo, ['apply', '--cached', '-'], env, patch);
    const misses: string[] = [];
    for (const x of expect) {
      let content: string;
      try {
        content = git(repo, ['show', `:${x.path}`], env);
      } catch {
        misses.push(`${x.path} 不存在`);
        continue;
      }
      const r = expectedHolds(content, x.path, x);
      if (!r.ok) {
        misses.push(`${x.path}${x.pointer} 为 ${JSON.stringify(r.got)}，期望 ${JSON.stringify(x.value)}`);
      }
    }
    return { applies: true, correct: misses.length === 0, detail: misses.join('；') || '期望全部成立' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 重建运行的提议 → 三项指标；labelOf 把用例映射到标注（没有标注的用例不计） */
export function scoreRemediation(
  runs: readonly RunRecord[],
  labelOf: (caseId: string) => Label | null,
  repo: string | null,
  scratch: string,
  templatesOf?: (r: RunRecord) => Array<{ key: string; category: string }>,
): RemediationSummary {
  const out: RemediationSummary = {
    eligible_runs: 0,
    triggered_runs: 0,
    false_triggers: 0,
    patches: 0,
    applicable: 0,
    correct: 0,
    checks: [],
  };
  for (const r of runs) {
    const l = labelOf(r.caseId);
    if (!l) {
      continue;
    }
    const prs = r.proposals.filter((p) => p.action_id === 'gitops_pr');
    const likely = r.level !== null && REPAIR_LEVELS.has(r.level);
    if (l.fix && likely) {
      out.eligible_runs++;
      if (prs.length) {
        out.triggered_runs++;
      }
    }
    if (!l.fix && prs.length) {
      out.false_triggers++;
    }
    if (templatesOf && likely) {
      const t = templatesOf(r);
      out.template_triggered_runs ??= 0;
      out.template_any_runs ??= 0;
      out.template_false_triggers ??= {};
      (out.template_matches ??= []).push({
        case: r.caseId,
        route: r.routeId,
        run: r.run,
        level: r.level,
        disposition: r.disposition,
        templates: t.map((x) => x.key),
      });
      if (l.fix) {
        if (t.some((x) => x.category === FIX_CLASS_CATEGORY[l.fix!.class])) {
          out.template_triggered_runs++;
        }
        if (t.length) {
          out.template_any_runs++;
        }
      } else {
        for (const x of t) {
          out.template_false_triggers[x.category] = (out.template_false_triggers[x.category] ?? 0) + 1;
        }
      }
    }
    for (const p of prs) {
      out.patches++;
      const params = p.params as { base?: unknown; patch?: unknown };
      const patch = typeof params.patch === 'string' ? params.patch : '';
      if (!repo || !l.fix) {
        out.checks.push({
          case: r.caseId,
          route: r.routeId,
          run: r.run,
          base: null,
          applies: false,
          correct: false,
          detail: !repo ? '没有给出 --repo，补丁未检查' : '标注没有仓库修复（误触发）',
        });
        continue;
      }
      const base = baseCommit(repo, typeof params.base === 'string' ? params.base : 'HEAD', l.as_of);
      const c = base
        ? checkPatch(repo, base, patch, l.fix.expect, scratch)
        : { applies: false, correct: false, detail: 'as_of 之前 base 分支没有提交' };
      if (c.applies) {
        out.applicable++;
      }
      if (c.correct) {
        out.correct++;
      }
      out.checks.push({ case: r.caseId, route: r.routeId, run: r.run, base, ...c });
    }
  }
  return out;
}

export interface LiveRemediation {
  gitops_pr_proposals: number;
  linked_pulls: number;
  issues_open: number;
}

/** 影子环境：时间窗口内的 gitops_pr 提议、事件关联的 PR 与已开的 issue（只读会话） */
export async function liveRemediation(
  q: Pick<pg.Client, 'query'>,
  clusterId: string,
  since: Date,
  until: Date,
): Promise<LiveRemediation> {
  const p = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM server.proposals
      WHERE cluster_id = $1 AND action = 'gitops_pr' AND created_at >= $2 AND created_at < $3`,
    [clusterId, since, until],
  );
  const l = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM server.github_issue_links
      WHERE kind = 'pull' AND created_at >= $1 AND created_at < $2`,
    [since, until],
  );
  const i = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM server.github_issues WHERE state = 'open' AND created_at >= $1 AND created_at < $2`,
    [since, until],
  );
  return { gitops_pr_proposals: p.rows[0]?.n ?? 0, linked_pulls: l.rows[0]?.n ?? 0, issues_open: i.rows[0]?.n ?? 0 };
}
