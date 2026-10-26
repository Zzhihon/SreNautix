import type { ChangeEvent, ChangeLink, Incident } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import {
  bookChangeGrades,
  changeCap,
  isReleaseComponent,
  managesChangeTargets,
} from '../../src/research/change-cap.js';
import { incidentBook } from '../../src/research/incident.js';
import type { LadderResult } from '../../src/research/ladder.js';
import { Ledger } from '../../src/research/ledger.js';
import { changesSegment } from '../../src/research/prompt.js';
import type { ResearchCase } from '../../src/research/types.js';
import { incident, researchCase, subgraph } from '../support/scenario.js';

// 变更关联分级对结论档位的限制（ADR 0169）。场景：shop 的 postgres 数据卷写满，api 5xx；同一时段 web 有一次发布
// （事件里的 change:1），另有一次不在事件里的 worker 发布（相关变更 change:2）。

const PG = 'StatefulSet:shop/postgres';
const WEB = 'Deployment:shop/web';
const APP = 'Application.argoproj.io:argocd/shop';
const ROLLOUT = 'k8s-rollout:shop/web-5f6d';

const link = (grade: ChangeLink['grade'], basis: ChangeLink['basis'], o: Partial<ChangeLink> = {}): ChangeLink => ({
  change_id: ROLLOUT,
  grade,
  basis,
  new_signals: grade === 'high' ? ['0000000000000002@1788257160'] : [],
  rollback: false,
  ...o,
});
const related: ChangeEvent = {
  change_id: 'k8s-rollout:shop/worker-11aa',
  source: 'k8s-rollout',
  kind: 'rollout',
  refs: ['ReplicaSet/worker-11aa'],
  revision: '11aa',
  actor: null,
  time: '2026-09-01T09:50:00Z',
  link: null,
  targets: ['Deployment:shop/worker'],
  summary: 'worker rolled out',
};
/** 事件的 web 发布由应用 shop 管理；子图里有 web → shop 的 managed_by */
function caseWith(links: ChangeLink[] | undefined, over: Partial<ResearchCase> = {}): ResearchCase {
  const base = incident();
  const inc: Incident = {
    ...base,
    changes: base.changes.map((c) => ({ ...c, refs: [...c.refs, APP] })),
    ...(links ? { change_links: links } : {}),
  };
  const sg = subgraph();
  return researchCase({
    incident: inc,
    relatedChanges: [related],
    subgraph: {
      ...sg,
      nodes: [
        ...sg.nodes,
        {
          component: APP,
          kind: 'Application.argoproj.io',
          namespace: 'argocd',
          name: 'shop',
          role: 'neighbor',
          alerts: [],
          hops: 2,
        },
      ],
      edges: [
        ...sg.edges,
        { from: WEB, to: APP, relation: 'managed_by', provenance: 'structural', confidence: 1, scope: 'service' },
      ],
    },
    ...over,
  });
}
const likely: LadderResult = {
  level: 'likely',
  consistency: {
    entity_in_scope: true,
    onset_precedes_symptom: true,
    no_contrary_normal: true,
    competitor_tested: false,
  },
  detail: null,
  notes: ['之前的说明'],
};
function chosen(rc: ResearchCase, root: string, supporting: string[]) {
  const book = incidentBook(rc);
  const ledger = new Ledger(book, rc.subgraph);
  ledger.merge(
    [{ id: 'h1', parent_id: null, root_component: root, mechanism: `${root} 引起`, supporting, refuting: [] }],
    [],
  );
  return { book, entry: ledger.entries.get('h1')! };
}

describe('changeCap', () => {
  it('supporting 引用的变更是 high：档位不变', () => {
    const rc = caseWith([link('high', ['component_match'])]);
    const { book, entry } = chosen(rc, WEB, ['change:1']);
    expect(changeCap(likely, entry, rc.incident, book, rc.subgraph)).toBe(likely);
  });

  it('supporting 引用的变更是 medium：最高 inconclusive，validation_notes 写明变更、分级与缺少的条件', () => {
    const rc = caseWith([link('medium', ['component_match'])]);
    const { book, entry } = chosen(rc, WEB, ['change:1']);
    const r = changeCap(likely, entry, rc.incident, book, rc.subgraph);
    expect(r.level).toBe('inconclusive');
    expect(r.notes).toEqual([
      '之前的说明',
      `假设 h1 的根因 ${WEB} 归到变更上，但对应的变更没有 high 分级（change:1（${ROLLOUT}）分级 medium：变更之后目标上没有开始的 symptom 或 cause 告警（新信号）），档位由 likely 改为 inconclusive（ADR 0169）`,
    ]);
  });

  it('只经拓扑可达（medium）、late 与命名空间（low）各自写出缺少的条件；evidence_consistent 同样受限', () => {
    const consistent = { ...likely, level: 'evidence_consistent' as const };
    const cases: Array<[ChangeLink, RegExp]> = [
      [link('medium', ['topology_reach']), /分级 medium：变更没有直接作用在告警的对象上，只经拓扑可达关联/],
      [link('low', ['component_match', 'late']), /分级 low：变更晚于它自己目标上已经开始的问题/],
      [link('low', ['namespace']), /分级 low：只经 namespace 关联，变更没有直接作用在告警的对象上/],
      [link('low', ['component_match']), /分级 low：直接作用的告警不满足时间条件/],
    ];
    for (const [l, note] of cases) {
      const rc = caseWith([l]);
      const { book, entry } = chosen(rc, WEB, ['change:1']);
      const r = changeCap(consistent, entry, rc.incident, book, rc.subgraph);
      expect(r.level).toBe('inconclusive');
      expect(r.notes.at(-1)).toMatch(note);
      expect(r.notes.at(-1)).toMatch(/档位由 evidence_consistent 改为 inconclusive/);
    }
  });

  it('引用不在事件里的相关变更：按 low', () => {
    const rc = caseWith([link('high', ['component_match'])]);
    const { book, entry } = chosen(rc, 'Deployment:shop/worker', ['change:2']);
    const r = changeCap(likely, entry, rc.incident, book, rc.subgraph);
    expect(r.level).toBe('inconclusive');
    expect(r.notes.at(-1)).toMatch(/change:2（k8s-rollout:shop\/worker-11aa）分级 low：不在事件里/);
  });

  it('根因是管理变更目标的 GitOps 应用：不引用变更也按它管理的目标上的变更限制', () => {
    const weak = caseWith([link('medium', ['topology_reach'])]);
    const a = chosen(weak, APP, []);
    expect(managesChangeTargets(APP, weak.incident.changes[0]!, weak.subgraph)).toBe(true);
    expect(changeCap(likely, a.entry, weak.incident, a.book, weak.subgraph).level).toBe('inconclusive');
    const strong = caseWith([link('high', ['component_match'])]);
    const b = chosen(strong, APP, []);
    expect(changeCap(likely, b.entry, strong.incident, b.book, strong.subgraph)).toBe(likely);
  });

  it('根因是发布的逻辑组件：证据簿里的全部变更都对应它；没有变更时同样限制', () => {
    expect(isReleaseComponent('component:release')).toBe(true);
    expect(isReleaseComponent('component:shop/release')).toBe(true);
    expect(isReleaseComponent('component:releases')).toBe(false);
    const strong = caseWith([link('high', ['component_match'])]);
    const a = chosen(strong, 'component:release', []);
    expect(changeCap(likely, a.entry, strong.incident, a.book, strong.subgraph)).toBe(likely);
    const none = caseWith([], { relatedChanges: [] });
    const noChanges = { ...none, incident: { ...none.incident, changes: [], change_links: [] } };
    const b = chosen(noChanges, 'component:release', []);
    const r = changeCap(likely, b.entry, noChanges.incident, b.book, noChanges.subgraph);
    expect(r.level).toBe('inconclusive');
    expect(r.notes.at(-1)).toMatch(/事件与证据簿里没有对应的变更/);
  });

  it('根因不归到变更上：不限制；档位已经是 inconclusive 或没有选中假设时不变', () => {
    const rc = caseWith([link('low', ['namespace'])]);
    const { book, entry } = chosen(rc, PG, ['card:2']);
    expect(changeCap(likely, entry, rc.incident, book, rc.subgraph)).toBe(likely);
    const web = chosen(rc, WEB, ['change:1']);
    const inconclusive = { ...likely, level: 'inconclusive' as const };
    expect(changeCap(inconclusive, web.entry, rc.incident, web.book, rc.subgraph)).toBe(inconclusive);
    expect(changeCap(likely, null, rc.incident, web.book, rc.subgraph)).toBe(likely);
  });

  it('契约 2.37.0 之前算出的事件没有分级：不限制，记一条说明', () => {
    const rc = caseWith(undefined);
    const { book, entry } = chosen(rc, WEB, ['change:1']);
    const r = changeCap(likely, entry, rc.incident, book, rc.subgraph);
    expect(r.level).toBe('likely');
    expect(r.notes.at(-1)).toBe('事件没有变更关联分级（契约 2.37.0 之前算出），假设 h1 的档位不按分级限制');
    expect(bookChangeGrades(book, rc.incident).size).toBe(0);
  });
});

describe('提示词的变更片段', () => {
  it('每个变更带 grade、basis、new_signals（成员告警引用）与 rollback；相关变更为 low；GitHub 变更带命中的路径', () => {
    const rc = caseWith([link('high', ['component_match'], { rollback: true })]);
    const withPaths = { ...related, paths: ['apps/worker/'] };
    const book = incidentBook({ ...rc, relatedChanges: [withPaths] });
    const text = changesSegment(book, rc.incident).text;
    const json = JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!) as Array<Record<string, unknown>>;
    expect(json[0]).toMatchObject({
      ref: 'change:1',
      in_incident: true,
      grade: 'high',
      basis: ['component_match'],
      new_signals: ['alert:2'],
      rollback: true,
    });
    expect(json[1]).toMatchObject({
      ref: 'change:2',
      in_incident: false,
      grade: 'low',
      basis: [],
      new_signals: [],
      rollback: false,
      paths: ['apps/worker/'],
    });
  });

  it('事件没有分级时不带分级字段', () => {
    const rc = caseWith(undefined);
    const text = changesSegment(incidentBook(rc), rc.incident).text;
    expect(text).not.toMatch(/"grade"/);
  });
});
