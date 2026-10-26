import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  candidateLabel,
  mergeCandidates,
  STAGE_A_DELAY_MS,
  WINDOW_LEAD_MS,
  WINDOW_TAIL_MS,
  writeCandidates,
  type CandidatesFile,
} from '../../src/eval/candidates.js';
import { loadLabels, matchesFault } from '../../src/eval/labels.js';
import { incident } from '../support/scenario.js';

// 评测候选生成标注与合并进标注文件（ADR 0175）

const DIR = resolve(import.meta.dirname, '../../../../.scratch', `eval-candidates-${process.pid}`);

beforeAll(() => mkdirSync(DIR, { recursive: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const inc = { ...incident(), ended_at: '2026-09-01T10:40:00Z', state: 'resolved' as const };
const members: Array<{ alertname: string; labels: Record<string, string> }> = [
  {
    alertname: 'KubePersistentVolumeFillingUp',
    labels: { alertname: 'KubePersistentVolumeFillingUp', namespace: 'shop', prometheus: 'mon/k8s' },
  },
  { alertname: 'ApiHighErrorRate', labels: { alertname: 'ApiHighErrorRate', service: 'api' } },
  { alertname: 'ApiHighErrorRate', labels: { alertname: 'ApiHighErrorRate', service: 'api' } },
];
const candidate = (over: Partial<Parameters<typeof candidateLabel>[0]> = {}): Parameters<typeof candidateLabel>[0] => ({
  candidate_id: '7a1b2c3d-0000-4000-8000-0000000000d1',
  incident_label: inc.label,
  incident: inc,
  incident_updated_at: new Date('2026-09-01T10:41:00Z'),
  run_started_at: new Date('2026-09-01T10:02:00Z'),
  source: 'feedback',
  source_ref: '7a1b2c3d-0000-4000-8000-0000000000f1',
  reason_code: 'known_issue',
  reason: '每周备份时都会触发',
  label: { type: 'benign', roots: [], disposition: 'ignore', mechanism: null },
  decided_by: 'admin',
  ...over,
});

describe('候选生成标注', () => {
  it('窗口覆盖事件前后，分析时刻是研判开始的时刻，故障告警取成员告警（去掉告警名与外部标签、去重）', () => {
    const l = candidateLabel(candidate(), members);
    expect(l.id).toBe('candidate:7a1b2c3d-0000-4000-8000-0000000000d1');
    expect(l.type).toBe('benign');
    expect(Date.parse(l.window.from)).toBe(Date.parse(inc.first_firing_at) - WINDOW_LEAD_MS);
    expect(Date.parse(l.window.to)).toBe(Date.parse(inc.ended_at) + WINDOW_TAIL_MS);
    expect(l.as_of).toBe('2026-09-01T10:02:00.000Z');
    expect(l.fault_alerts).toEqual([
      { alertname: 'KubePersistentVolumeFillingUp', labels: { namespace: 'shop' } },
      { alertname: 'ApiHighErrorRate', labels: { service: 'api' } },
    ]);
    expect(matchesFault(l, 'ApiHighErrorRate', { alertname: 'ApiHighErrorRate', service: 'api', pod: 'p' })).toBe(true);
    expect(l.evidence).toEqual([
      {
        kind: 'state',
        ref: 'feedback:7a1b2c3d-0000-4000-8000-0000000000f1',
        note: '评测候选 7a1b2c3d-0000-4000-8000-0000000000d1，来源 feedback，原因码 known_issue，admin 确认，原因：每周备份时都会触发',
      },
    ]);
  });

  it('关闭的 PR 与 issue 的证据是链接；没有研判时分析时刻取首次触发之后；真实事件带根因', () => {
    const l = candidateLabel(
      candidate({
        source: 'pr_closed',
        source_ref: 'https://github.example.test/acme/gitops/pull/7',
        reason_code: null,
        reason: null,
        run_started_at: null,
        label: { type: 'incident', roots: ['StatefulSet:shop/postgres'], disposition: 'act', mechanism: '数据卷写满' },
      }),
      members,
    );
    expect(l.evidence[0]).toMatchObject({ kind: 'pr', ref: 'https://github.example.test/acme/gitops/pull/7' });
    expect(Date.parse(l.as_of)).toBe(Date.parse(inc.first_firing_at) + STAGE_A_DELAY_MS);
    expect(l).toMatchObject({ roots: ['StatefulSet:shop/postgres'], disposition: 'act', mechanism: '数据卷写满' });
  });

  it('没有确认的候选不能生成标注', () => {
    expect(() => candidateLabel(candidate({ label: null }), members)).toThrow(/没有确认/);
  });
});

describe('合并进标注文件', () => {
  const LABELS = `# 部署方本地维护的标注
version: 1
cluster_id: prod
labels:
  # 已有的一条
  - id: existing
    title: 已有
    type: benign
    window: {from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z"}
    as_of: "2026-09-01T10:00:00Z"
    fault_alerts: [{alertname: A}]
    disposition: ignore
    evidence: [{kind: state, ref: x}]
`;
  const file = (confirmed: CandidatesFile['confirmed']): CandidatesFile => ({
    version: 1,
    exported_at: '2026-09-02T00:00:00.000Z',
    since: '2026-09-01T00:00:00.000Z',
    until: '2026-09-02T00:00:00.000Z',
    confirmed,
    pending: [
      {
        candidate_id: '7a1b2c3d-0000-4000-8000-0000000000d9',
        cluster_id: 'prod',
        incident_id: inc.incident_id,
        incident_label: inc.label,
        source: 'issue_not_planned',
        source_ref: 'https://github.example.test/acme/ops/issues/3',
        suggested_type: null,
        reason_code: null,
        reason: null,
        created_at: '2026-09-01T12:00:00.000Z',
      },
    ],
  });

  it('同一集群、新的 id 追加；已有的 id 与其他集群不合并；原有注释保留；再合并一次不变', () => {
    const labels = join(DIR, 'labels.yaml');
    const cands = join(DIR, 'candidates.yaml');
    writeFileSync(labels, LABELS);
    const l = candidateLabel(candidate(), members);
    writeCandidates(
      cands,
      file([
        { cluster_id: 'prod', candidate_id: '7a1b2c3d-0000-4000-8000-0000000000d1', label: l },
        { cluster_id: 'prod', candidate_id: '7a1b2c3d-0000-4000-8000-0000000000d2', label: { ...l, id: 'existing' } },
        {
          cluster_id: 'staging',
          candidate_id: '7a1b2c3d-0000-4000-8000-0000000000d3',
          label: { ...l, id: 'candidate:other' },
        },
      ]),
    );
    const r = mergeCandidates(cands, labels);
    expect(r).toEqual({
      added: ['candidate:7a1b2c3d-0000-4000-8000-0000000000d1'],
      existing: ['existing'],
      otherCluster: ['candidate:other'],
      pending: 1,
    });
    const text = readFileSync(labels, 'utf8');
    expect(text).toContain('# 部署方本地维护的标注');
    expect(text).toContain('# 已有的一条');
    const merged = loadLabels(labels);
    expect(merged.labels.map((x) => x.id)).toEqual(['existing', 'candidate:7a1b2c3d-0000-4000-8000-0000000000d1']);
    expect(merged.labels[1]).toEqual(l);
    expect(mergeCandidates(cands, labels).added).toEqual([]);
    expect(readFileSync(labels, 'utf8')).toBe(text);
  });

  it('合并后不符合标注 schema 时抛出，不写文件', () => {
    const labels = join(DIR, 'labels-bad.yaml');
    const cands = join(DIR, 'candidates-bad.yaml');
    // 已有标注里有同名 id 的两条：文件本身不合法
    writeFileSync(
      labels,
      `${LABELS}  - id: existing\n    title: 重复\n    type: benign\n    window: {from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z"}\n    as_of: "2026-09-01T10:00:00Z"\n    fault_alerts: [{alertname: A}]\n    disposition: ignore\n    evidence: [{kind: state, ref: x}]\n`,
    );
    writeCandidates(cands, file([]));
    const before = readFileSync(labels, 'utf8');
    expect(() => mergeCandidates(cands, labels)).toThrow(/重复/);
    expect(readFileSync(labels, 'utf8')).toBe(before);
  });
});
