import type { EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { trimOnce } from '../../src/llm/session.js';
import { segmentsText } from '../../src/llm/wire.js';
import type { LlmRequest } from '../../src/llm/types.js';
import { EvidenceBook } from '../../src/research/evidence.js';
import { hypothesizeItems, promptParts } from '../../src/research/prompt.js';
import { researchCase, stageA, stageACards } from '../support/scenario.js';

// 提示词裁剪顺序（ADR 0099）：与结论无关的证据卡先改为只列判定，然后依次去掉参考案例、知识、其余卡的判定列表，
// 再裁拓扑子图，最后才裁结论相关的证据卡；整次研判不因超限失败。

function bigCase() {
  const base = stageACards();
  const web = base[3] as EvidenceResult;
  const filler: EvidenceResult[] = Array.from({ length: 30 }, (_, i) => ({
    ...web,
    ref: `card:${100 + i}`,
    card_id: `workload/http/filler_${i}`,
    table: { head: ['pod', 'value'], rows: Array.from({ length: 8 }, (_, r) => [`web-${r}`, `${r}%`]) },
  }));
  const abnormal = base[0] as EvidenceResult;
  const withTable = {
    ...abnormal,
    table: { head: ['pod', 'ratio'], rows: Array.from({ length: 8 }, (_, r) => [`api-${r}`, `${30 + r}%`]) },
  };
  const rc = researchCase({
    stageA: stageA([withTable, ...base.slice(1), ...filler]),
    knowledge: [
      {
        id: 'k1',
        components: ['StatefulSet:shop/postgres'],
        text: 'KNOWLEDGE-postgres WAL 堆积会写满数据卷',
        learned_from: [],
        learned_at: null,
        source: 'human',
      },
    ],
    cases: [
      {
        incident_id: 'old-1',
        label: 'x',
        root_component: 'StatefulSet:shop/postgres',
        mechanism: 'CASE-wal-growth',
        resolved_at: '2026-08-01T00:00:00Z',
        source: 'human',
      },
    ],
  });
  return { rc, book: new EvidenceBook(rc) };
}

function text(req: LlmRequest): string {
  return req.items.map((i) => (i.type === 'user' || i.type === 'system' ? segmentsText(i.segments) : '')).join('\n');
}

describe('提示词裁剪', () => {
  it('不裁剪时与原来的排列一致：事件、拓扑、成员告警、证据卡、知识与参考案例', () => {
    const { rc, book } = bigCase();
    const items = hypothesizeItems('zh', promptParts('zh', rc, book, 400_000, null), null, book);
    const t = text({ items, maxOutputTokens: 1 });
    const order = [
      '## 事件',
      '## 拓扑（根因两跳内）',
      '## 成员告警',
      '## 证据卡（阶段 A）',
      '## 知识条目',
      '## 参考案例',
    ];
    const at = order.map((h) => t.indexOf(h));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(t).not.toContain('其余证据卡（只列判定）');
  });

  it('按优先级逐步裁剪：结论相关的证据卡 > 拓扑子图 > 知识 > 参考案例', () => {
    const { rc, book } = bigCase();
    let req: LlmRequest = {
      items: hypothesizeItems('zh', promptParts('zh', rc, book, 400_000, null), null, book),
      maxOutputTokens: 1,
    };
    const labels: string[] = [];
    const snapshots: string[] = [];
    for (;;) {
      const t = trimOnce(req);
      if (!t) {
        break;
      }
      labels.push(t.label);
      req = t.request;
      snapshots.push(text(req));
    }
    const idx = (re: RegExp) => labels.findIndex((l) => re.test(l));
    expect(idx(/改为只列判定/)).toBe(0);
    expect(idx(/参考案例 1 条/)).toBeGreaterThan(idx(/改为只列判定/));
    expect(idx(/知识条目 1 条/)).toBeGreaterThan(idx(/参考案例/));
    expect(idx(/其余证据卡的判定列表/)).toBeGreaterThan(idx(/知识条目/));
    expect(idx(/^拓扑子图/)).toBeGreaterThan(idx(/知识条目/));
    expect(idx(/表格/)).toBeGreaterThan(idx(/^拓扑子图/));
    expect(idx(/^结论相关证据卡 \d+ 张/)).toBeGreaterThan(idx(/表格/));
    // 第一步之后：无关卡只剩判定，结论相关卡仍是完整的
    expect(snapshots[0]).toContain('其余证据卡（只列判定）');
    expect(snapshots[0]).toContain('CASE-wal-growth');
    // 知识被裁之前参考案例已经不在
    const knowledgeGone = snapshots[idx(/知识条目 1 条/)] as string;
    expect(knowledgeGone).not.toContain('CASE-wal-growth');
    expect(knowledgeGone).not.toContain('KNOWLEDGE-postgres');
    expect(knowledgeGone).toContain('## 拓扑（根因两跳内）');
    // 裁到底：事件与成员告警保留，结论相关的卡至少留下排名第一的那张（候选根因上的异常卡优先）
    const last = snapshots.at(-1) as string;
    expect(last).toContain('## 事件');
    expect(last).toContain('## 成员告警');
    expect(last).not.toContain('## 拓扑（根因两跳内）');
    expect(last).toContain('"verdict":"abnormal"');
    expect(last).not.toContain('workload/http/filler_');
  });
});
