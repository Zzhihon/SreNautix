// 导出结果的 ndjson 与 Markdown 形式（ADR 0186）。ndjson 每行一个 IncidentExportRecord；Markdown 给人阅读：先列疑似同一根因
// 的分组，再按系列汇总，最后是事件明细。外部来源的文字（告警名、模型摘要、证据卡说明、错误摘要）在 Markdown 里转义，
// 只作为文本显示。
import type {
  ExportedIncident,
  ExportedIssue,
  IncidentExport,
  IncidentExportRecord,
  KubeWarningCount,
  SuspectedCommonCauseGroup,
} from '@srenautix/contract';

/** ndjson 的各行：header、每个事件、每个系列（有时）、每个集群的 Warning 状态、end */
export function* exportRecords(x: IncidentExport): Generator<IncidentExportRecord> {
  yield {
    type: 'header',
    generated_at: x.generated_at,
    window: x.window,
    filters: x.filters,
    group: x.group,
    grouping: x.grouping,
  };
  for (const incident of x.incidents) {
    yield { type: 'incident', incident };
  }
  for (const series of x.series ?? []) {
    yield { type: 'series', series };
  }
  for (const kube_warnings of x.kube_warnings) {
    yield { type: 'kube_warnings', kube_warnings };
  }
  yield {
    type: 'end',
    incidents: x.incidents.length,
    suppressed_count: x.suppressed_count,
    complete: x.complete,
    truncated: x.truncated,
    next_cursor: x.next_cursor,
  };
}

/** Markdown 里的外部文字：换行并为空格，转义 Markdown 与 HTML 的控制字符 */
export function mdText(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => `\\${c}`);
}

/** 时长：天、小时、分、秒，取最大的两级 */
export function humanDuration(seconds: number): string {
  const parts: Array<[number, string]> = [
    [Math.floor(seconds / 86_400), '天'],
    [Math.floor((seconds % 86_400) / 3600), '小时'],
    [Math.floor((seconds % 3600) / 60), '分'],
    [seconds % 60, '秒'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) {
    return '0 秒';
  }
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, u]) => `${n} ${u}`)
    .join(' ');
}

const KIND_NAMES: Record<string, string> = { node_memory_eviction: '节点内存驱逐' };

const SOURCE_NAMES: Record<string, string> = { events: '事件', kube_state_metrics: 'kube-state-metrics' };
const UNIT_NAMES: Record<string, string> = { occurrences: '次', pods: '个 Pod', seconds: '秒' };

function countText(c: KubeWarningCount): string {
  const memory = c.memory ? `，其中提到内存 ${c.memory}` : '';
  return `${mdText(c.reason)} ${c.count} ${UNIT_NAMES[c.unit] ?? c.unit}（${SOURCE_NAMES[c.source] ?? c.source}${memory}）`;
}

function countsText(cs: readonly KubeWarningCount[]): string {
  return cs.length ? cs.map(countText).join('；') : '没有';
}

function issueText(i: ExportedIssue): string {
  const state = i.state === 'closed' ? '，已关闭' : '';
  const reused = i.reused ? '，同一系列复用' : '';
  return `[${mdText(i.repo)}#${i.number}](${encodeURI(i.url)})${state}${reused}`;
}

/** 表格单元格：外部文字转义，竖线在 mdText 里已转义 */
const cell = (s: string) => (s === '' ? ' ' : s);

function groupSection(cluster: string, g: SuspectedCommonCauseGroup, byId: Map<string, ExportedIncident>): string[] {
  const out = [
    `### ${KIND_NAMES[g.kind] ?? mdText(g.kind)}（${mdText(cluster)}，疑似）`,
    '',
    `- 分组：\`${g.group_id.slice(0, 19)}\`，时间 ${g.window.from} 至 ${g.window.to}`,
    `- 判据：信号 ${g.criteria.signal_reasons.map(mdText).join('、')}；同一节点信号间隔不超过 ${humanDuration(g.criteria.gap_seconds)} 时并为一段；事件可以早于信号 ${humanDuration(g.criteria.before_seconds)}、晚于信号 ${humanDuration(g.criteria.after_seconds)}；至少 ${g.criteria.min_incidents} 个事件`,
    `- 关联告警：${g.alertnames.map(mdText).join('、')}`,
  ];
  for (const n of g.nodes) {
    const spans = n.signal_windows.map((w) => `${w.from} 至 ${w.to}`).join('，');
    out.push(`- 节点 ${mdText(n.node)}：信号时间段 ${spans}；${countsText(n.counts)}`);
  }
  out.push('', '| 事件 | 告警 | 节点 | 与信号重叠 | 组件上的计数 |', '|---|---|---|---|---|');
  for (const i of g.incidents) {
    const inc = byId.get(i.incident_id);
    out.push(
      `| ${cell(inc ? mdText(inc.label) : i.incident_id)} | ${cell(i.alertnames.map(mdText).join('、'))} | ${cell(i.nodes.map(mdText).join('、'))} | ${humanDuration(i.overlap_seconds)} | ${cell(i.counts.length ? countsText(i.counts) : '')} |`,
    );
  }
  out.push('');
  return out;
}

function conclusionLines(i: ExportedIncident): string[] {
  const c = i.conclusion;
  const source = { research: '阶段 B 研判', stage_a: '阶段 A', none: '没有结论' }[c.source];
  const parts = [source];
  if (c.disposition) parts.push(`处置 ${c.disposition}`);
  if (c.conclusion_level) parts.push(`档位 ${c.conclusion_level}`);
  if (c.disposition_reason) parts.push(`依据 ${c.disposition_reason}`);
  const out = [`- 研判：${parts.join('，')}${c.at ? `（${c.at}）` : ''}`];
  if (c.summary) {
    out.push(`- 摘要：${mdText(c.summary)}`);
  }
  if (c.undetermined) {
    const codes = c.undetermined.codes.map(
      (r) => `\`${r.stage}/${r.code}\` ${mdText(r.text)}${r.detail ? `：${mdText(r.detail)}` : ''}`,
    );
    out.push(`- 无法判定的原因：${codes.length ? codes.join('；') : '没有终态记录'}`);
    if (c.undetermined.undetermined_reason) {
      out.push(`- 研判给出的原因：${mdText(c.undetermined.undetermined_reason)}`);
    }
  }
  return out;
}

function incidentSection(i: ExportedIncident): string[] {
  const root = i.root.component ? `\`${i.root.component}\`${i.root.ambiguous ? '（有歧义）' : ''}` : '没有';
  const entity = i.root.entity
    ? `，实体 \`${i.root.entity.kind}:${i.root.entity.namespace ? `${i.root.entity.namespace}/` : ''}${i.root.entity.name}\``
    : '';
  const out = [
    `### ${mdText(i.label)}`,
    '',
    `- 集群 ${mdText(i.cluster_id)}，${i.state === 'firing' ? '触发中' : '已恢复'}，${i.severity}，类别 ${i.categories.join('、')}（主类别 ${i.primary_category}）`,
    `- 告警：${i.alertnames.map(mdText).join('、')}`,
    `- 根因：${root}${entity}`,
    `- 时间：首次 ${i.first_firing_at}，末次 ${i.last_firing_at}，${i.ended_at ? `恢复 ${i.ended_at}` : '仍在触发'}；累计触发 ${humanDuration(i.firing_seconds)}（${i.occurrences} 次发生）；合并 ${i.merged_count} 次，重开 ${i.reopened_count} 次`,
    ...conclusionLines(i),
  ];
  for (const e of i.evidence) {
    const title = e.title['zh-CN'] ?? e.title.en ?? e.card_id;
    out.push(`- 证据 ${mdText(title)}（${e.verdict}，${e.reason_kind}）：${mdText(e.summary)}`);
  }
  const k = i.kube_warnings;
  out.push(`- Kubernetes Warning（组件）：${countsText(k.counts)}${k.complete ? '' : '（计数不完整）'}`);
  for (const n of k.nodes) {
    out.push(`- Kubernetes Warning（节点 ${mdText(n.node)}）：${countsText(n.counts)}`);
  }
  if (i.issues.length) {
    out.push(`- issue：${i.issues.map(issueText).join('，')}`);
  }
  out.push('');
  return out;
}

/** Markdown 形式 */
export function exportMarkdown(x: IncidentExport): string {
  const f = x.filters;
  const filters = [
    f.cluster_id ? `集群 ${f.cluster_id}` : null,
    f.severity ? `严重度 ${f.severity}` : null,
    f.component ? `组件 ${f.component}` : null,
    f.category.length ? `类别 ${f.category.join('、')}` : null,
    f.exclude_category.length ? `排除类别 ${f.exclude_category.join('、')}` : null,
    f.exclude_component.length ? `排除组件 ${f.exclude_component.join('、')}` : null,
    f.suppressed ? '包含被抑制的事件' : null,
  ].filter((s): s is string => s !== null);
  const out = [
    '# SreNautix 事件导出',
    '',
    `- 时间窗：${x.window.from} 至 ${x.window.to}（生成于 ${x.generated_at}）`,
    `- 筛选：${filters.length ? mdText(filters.join('；')) : '没有'}`,
    `- 事件 ${x.incidents.length} 个${x.suppressed_count ? `，另有 ${x.suppressed_count} 个被抑制的事件没有导出` : ''}`,
  ];
  if (x.truncated) {
    out.push(`- 符合条件的事件多于本次上限，余下的用 \`cursor=${x.next_cursor ?? ''}\` 继续导出`);
  }
  for (const k of x.kube_warnings) {
    const failed = k.queries.filter((q) => q.status !== 'ok');
    out.push(
      `- Kubernetes Warning（${mdText(k.cluster_id)}）：${k.complete ? '查询完整' : `计数不完整：${failed.map((q) => `${q.name} ${q.status}${q.detail ? `（${mdText(q.detail)}）` : ''}`).join('；')}`}`,
    );
  }
  const byId = new Map(x.incidents.map((i) => [i.incident_id, i]));
  out.push('', '## 疑似同一根因', '');
  const groups = x.kube_warnings.flatMap((k) => k.groups.map((g) => ({ cluster: k.cluster_id, g })));
  if (groups.length) {
    out.push('按节点信号的启发式分组，只表示疑似，依据列在每组中。', '');
    for (const { cluster, g } of groups) {
      out.push(...groupSection(cluster, g, byId));
    }
  } else {
    out.push('没有。', '');
  }
  out.push('## 按系列汇总', '');
  if (x.series?.length) {
    out.push(
      '| 系列 | 告警 | 发生次数 | 累计触发 | 首次 | 末次 | 事件数 | issue |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const s of x.series) {
      out.push(
        `| ${cell(s.root_component ? `\`${s.root_component}\`` : '没有根因')} | ${cell(s.alertnames.map(mdText).join('、'))} | ${s.occurrences} | ${humanDuration(s.firing_seconds)} | ${s.first_firing_at} | ${s.ended_at === null ? `${s.last_firing_at}（仍在触发）` : s.last_firing_at} | ${s.incident_ids.length} | ${cell(s.issues.map(issueText).join('，'))} |`,
      );
    }
    out.push('');
  } else {
    out.push('没有。', '');
  }
  out.push('## 事件明细', '');
  for (const i of x.incidents) {
    out.push(...incidentSection(i));
  }
  return `${out.join('\n').trimEnd()}\n`;
}
