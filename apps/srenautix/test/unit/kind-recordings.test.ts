import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePlaceholders } from '../../src/llm/replay.js';
import { bindSchema, formatErrors, modelSchema, validatorOf } from '../../src/llm/schema.js';
import { JUDGE_SCHEMA } from '../../src/research/prompt.js';

// kind-e2e 的模型录制（deploy/kind/scenarios/<场景>/llm/）：按 Kind 中可能出现的组件、证据卡与工具解析占位符之后，
// 每份录制都必须直接通过绑定后的完整 schema（不靠本地挽救），并且根因、支持卡与检查都解析得出来

const SCENARIOS = resolve(import.meta.dirname, '../../../../deploy/kind/scenarios');
const COMPONENTS = [
  'Application.argoproj.io:argocd/shop',
  'Deployment:shop/api',
  'Deployment:shop/checkout',
  'Job:shop/shop-migrate-r2',
  'Service:shop/api',
  'Pod:shop/api-7d9f8-a',
];
const CARDS = [
  ['workload/release/init-waiting', 'Deployment:shop/api'],
  ['workload/release/migration-jobs', 'Job:shop/shop-migrate-r2'],
  ['workload/release/replicasets', 'Deployment:shop/api'],
  ['workload/release/serving-versions', 'Deployment:shop/api'],
  ['workload/job/status', 'Job:shop/shop-migrate-r2'],
  ['workload/pod-restarts/restarts', 'Deployment:shop/api'],
  ['workload/pod-restarts/memory', 'Deployment:shop/checkout'],
  ['workload/rollout/deployment', 'Deployment:shop/api'],
] as const;
const REFS = CARDS.map((_, i) => `card:${i + 1}`);
const PROMPT = JSON.stringify(
  CARDS.map(([card, entity], i) => ({ ref: `card:${i + 1}`, card, entity, verdict: 'abnormal' })),
);
const ENUMS = {
  components: COMPONENTS,
  evidence_refs: REFS,
  sample_refs: [],
  check_templates: ['kube_pod_status', 'kube_workload_pods', 'kube_events', 'kube_logs'],
  runbooks: [],
  actions: [],
};

const scenarios = readdirSync(SCENARIOS).filter((s) => {
  try {
    return readdirSync(join(SCENARIOS, s, 'llm')).length > 0;
  } catch {
    return false;
  }
});

function check(file: string, schema: Record<string, unknown>, portable: Record<string, unknown>) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as { output: unknown };
  const req = { input: [{ content: [{ text: PROMPT }] }], text: { format: { name: 'x', schema: portable } } };
  const out = resolvePlaceholders(rec.output, req);
  const v = validatorOf(schema);
  expect(v(out), `${file}：${formatErrors(v.errors)}`).toBe(true);
  return out as Record<string, unknown>;
}

describe.each(scenarios)('%s 的录制', (s) => {
  const dir = join(SCENARIOS, s, 'llm');

  it('hypothesize：根因、至少一张支持卡与一项工具检查都解析得出来', () => {
    const b = bindSchema(modelSchema('hypothesize'), ENUMS);
    const out = check(join(dir, 'hypothesize_output.json'), b.full, b.portable) as {
      hypotheses: Array<{ root_component: string; supporting: string[] }>;
      next_checks: Array<{ template: string; args_json: string }>;
    };
    expect(out.hypotheses).toHaveLength(1);
    expect(COMPONENTS).toContain(out.hypotheses[0]!.root_component);
    expect(out.hypotheses[0]!.supporting.length).toBeGreaterThan(0);
    expect(out.next_checks).toHaveLength(1);
    expect(() => JSON.parse(out.next_checks[0]!.args_json) as unknown).not.toThrow();
  });

  it('check_judgement 与 conclude 符合 schema', () => {
    check(join(dir, 'check_judgement.json'), JUDGE_SCHEMA as unknown as Record<string, unknown>, {});
    const b = bindSchema(modelSchema('conclude'), ENUMS);
    check(join(dir, 'conclude_output.json'), b.full, b.portable);
  });
});

it('五个场景都有录制', () => {
  expect(scenarios.sort()).toEqual([
    'alert-too-sensitive',
    'config-resource-oom',
    'release-bad-image',
    'release-stuck-init',
    'unmapped-alert',
  ]);
});
