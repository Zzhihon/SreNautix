import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANON_VERSION,
  evidenceFingerprint,
  jcs,
  observeFingerprint,
  paramsHash,
  proposalIdempotencyKey,
  sha256Hex,
  type FingerprintState,
} from '../src/index.js';

// Go 与 TS 共用的黄金向量（contract/gateway/v1/testvectors）
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../contract/gateway/v1/testvectors/approval-vectors.json', import.meta.url)),
    'utf8',
  ),
) as {
  canon_version: string;
  canonicalization: Array<{ name: string; input: string; canonical: string; sha256: string }>;
  params_hash: Array<{ name: string; params: Record<string, unknown>; canonical: string; params_hash: string }>;
};

describe('jcs-sha256-v1 与 gateway 的黄金向量一致', () => {
  it('规范化版本', () => {
    expect(CANON_VERSION).toBe(vectors.canon_version);
  });

  it.each(vectors.canonicalization.map((v) => [v.name, v] as const))('规范化 %s', (_, v) => {
    expect(jcs(JSON.parse(v.input))).toBe(v.canonical);
    expect(sha256Hex(v.canonical)).toBe(v.sha256);
  });

  it.each(vectors.params_hash.map((v) => [v.name, v] as const))('params_hash %s', (_, v) => {
    expect(jcs(v.params)).toBe(v.canonical);
    expect(paramsHash(v.params)).toBe(v.params_hash);
  });

  it('幂等键与参数的键顺序无关', () => {
    const a = proposalIdempotencyKey({
      incidentId: 'i',
      sourceId: 'r',
      action: 'workload_scale',
      params: { replicas: 2, name: 'api' },
    });
    const b = proposalIdempotencyKey({
      incidentId: 'i',
      sourceId: 'r',
      action: 'workload_scale',
      params: { name: 'api', replicas: 2 },
    });
    const c = proposalIdempotencyKey({
      incidentId: 'i',
      sourceId: 'r',
      action: 'workload_scale',
      params: { name: 'api', replicas: 3 },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('证据指纹与迟滞', () => {
  const pod = { kind: 'Pod', namespace: 'shop', name: 'pg-1' };
  const v = (verdict: 'normal' | 'abnormal' | 'undeterminable') => [
    { card_id: 'postgres/availability/oom', entity: pod, verdict },
    {
      card_id: 'workload/errors/ratio',
      entity: { kind: 'Deployment', namespace: 'shop', name: 'api' },
      verdict: 'abnormal' as const,
    },
  ];

  it('与卡片顺序无关；同一卡片同一实体重复时报错', () => {
    expect(evidenceFingerprint(v('abnormal'))).toBe(evidenceFingerprint([...v('abnormal')].reverse()));
    expect(evidenceFingerprint(v('abnormal'))).not.toBe(evidenceFingerprint(v('normal')));
    expect(() => evidenceFingerprint([...v('abnormal'), v('normal')[0]!])).toThrow(/重复/);
  });

  it('新的判定向量连续两次对账一致才生效；中间的抖动不触发', () => {
    const A = evidenceFingerprint(v('abnormal'));
    const B = evidenceFingerprint(v('normal'));
    const C = evidenceFingerprint(v('undeterminable'));
    let state: FingerprintState | null = null;
    const seq: Array<[string, boolean, string]> = [];
    for (const [name, fp] of [
      ['A', A],
      ['B', B],
      ['A', A],
      ['B', B],
      ['C', C],
      ['B', B],
      ['B', B],
      ['B', B],
    ] as const) {
      const r = observeFingerprint(state, fp);
      state = r.state;
      seq.push([name, r.changed, r.state.current === A ? 'A' : r.state.current === B ? 'B' : 'C']);
    }
    expect(seq).toEqual([
      ['A', false, 'A'],
      ['B', false, 'A'],
      ['A', false, 'A'],
      ['B', false, 'A'],
      ['C', false, 'A'],
      ['B', false, 'A'],
      ['B', true, 'B'],
      ['B', false, 'B'],
    ]);
  });
});
