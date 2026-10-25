import { UI_MESSAGES } from '@srenautix/ui';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONSOLE_MESSAGES } from './index';

/**
 * 按契约枚举拼接的文案键（t(`condition.${type}`) 等）：契约里每个取值在两种语言里都必须有文案。
 * 枚举直接从 contract/ 读取，契约新增取值而控制台没有补文案时这里失败（CCHP 上 condition.QueryManifest 缺文案曾让整个控制台崩溃）。
 */
const FILES = import.meta.glob(['../../../../contract/schemas/*.json', '../../../../contract/**/*.yaml'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const docs = new Map<string, unknown>();
function doc(file: string): unknown {
  let d = docs.get(file);
  if (d === undefined) {
    const key = Object.keys(FILES).find((k) => k.endsWith(`/contract/${file}`));
    if (!key) {
      throw new Error(`没有契约文件 ${file}`);
    }
    const raw = FILES[key]!;
    d = file.endsWith('.json') ? JSON.parse(raw) : parse(raw);
    docs.set(file, d);
  }
  return d;
}

/** JSON Pointer 指向的 enum（可以经 $ref 跳转一次，可空的 null 取值去掉） */
function enumAt(file: string, pointer: string): string[] {
  let node = doc(file) as Record<string, unknown>;
  for (const seg of pointer.split('/').slice(1)) {
    node = (node as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')] as Record<string, unknown>;
    if (node === undefined) {
      throw new Error(`${file}#${pointer} 不存在`);
    }
  }
  if (!Array.isArray(node.enum) && typeof node.$ref === 'string') {
    const [f, p] = node.$ref.split('#');
    const target = f ? new URL(f, `http://x/${file}`).pathname.slice(1) : file;
    return enumAt(target, p ?? '');
  }
  if (!Array.isArray(node.enum)) {
    throw new Error(`${file}#${pointer} 没有 enum`);
  }
  return (node.enum as unknown[]).filter((v): v is string => typeof v === 'string');
}

const OPENAPI = 'openapi.yaml';
const S = (name: string) => `schemas/${name}.schema.json`;

/** 文案键前缀 → 契约中的枚举 */
const ENUMS: Array<[string, string, string]> = [
  ['condition', S('condition'), '/properties/type'],
  ['condition', 'gateway/v1/reader.openapi.yaml', '/components/schemas/ReaderCondition/properties/type'],
  ['status.severity', S('common'), '/$defs/Severity'],
  ['status.disposition', S('common'), '/$defs/Disposition'],
  ['status.conclusion', S('common'), '/$defs/ConclusionLevel'],
  ['status.verdict', S('evidence-result'), '/properties/display_state'],
  ['evidence.reason', S('evidence-result'), '/$defs/Reason/properties/kind'],
  ['evidence.egress', S('common'), '/$defs/Egress'],
  ['approval.level', S('proposal'), '/properties/level'],
  ['approval.tier', S('proposal'), '/properties/tier'],
  ['approval.undo', OPENAPI, '/components/schemas/ProposalDetail/properties/undo/properties/kind'],
  ['detail.risk', S('research-output'), '/$defs/Recommendation/properties/risk'],
  ['detail.rec_kind', S('research-output'), '/$defs/Recommendation/properties/kind'],
  ['verdict.stage_a', S('stage-a-report'), '/properties/disposition_reason'],
  ['timeline.kind', OPENAPI, '/components/schemas/TimelineEntry/properties/kind'],
  ['subgraph.role', OPENAPI, '/components/schemas/Subgraph/properties/nodes/items/properties/role'],
  ['subgraph.source', S('topology-event'), '/$defs/Provenance'],
  [
    'inbox.blind',
    OPENAPI,
    '/paths/~1v1~1incidents/get/responses/200/content/application~1json/schema/properties/blind_spans/items/properties/kind',
  ],
  [
    'search.kind',
    OPENAPI,
    '/paths/~1v1~1search/get/responses/200/content/application~1json/schema/items/properties/kind',
  ],
  ['alerts.outcome', OPENAPI, '/components/schemas/AlertLookup/properties/outcome'],
  ['alerts.because', OPENAPI, '/components/schemas/AlertLookup/properties/outcome'],
  ['alerts.status', OPENAPI, '/components/schemas/AlertLookup/properties/alert/oneOf/1/properties/status'],
  ['research.state', OPENAPI, '/components/schemas/ResearchRun/properties/state'],
  ['research.reason', OPENAPI, '/components/schemas/ResearchRun/properties/reason'],
  ['run.stop_reason', OPENAPI, '/components/schemas/ResearchRun/properties/stop_reason'],
  ['run.repair', OPENAPI, '/components/schemas/LlmCall/properties/repair_step'],
  ['run.outcome', OPENAPI, '/components/schemas/LlmCall/properties/outcome'],
  ['users.perm', OPENAPI, '/components/schemas/Permission'],
  ['users.link_method', OPENAPI, '/components/schemas/ChatLink/properties/method'],
  ['integrations.tier', S('integration-manifest'), '/properties/tier'],
  ['integrations.direction', S('integration-manifest'), '/properties/direction'],
  ['packs.maturities', OPENAPI, '/components/schemas/PackStatus/properties/maturity'],
  ['packs.layer', OPENAPI, '/components/schemas/PackStatus/properties/layer'],
  ['models.breaker', OPENAPI, '/components/schemas/ModelRouteStatus/properties/breaker'],
  ['models.breaker_reason', OPENAPI, '/components/schemas/ModelRouteStatus/properties/breaker_reason'],
  ['health.metric', OPENAPI, '/components/schemas/AgentHealth/properties/scorecard/items/properties/metric'],
  [
    'topology.discovery',
    OPENAPI,
    '/components/schemas/TopologyCoverage/properties/components/items/properties/discovered_by',
  ],
  ['topology.alert_role', S('common'), '/$defs/AlertRole'],
  ['eval.case_type', OPENAPI, '/components/schemas/EvalCase/properties/type'],
  ['eval.pack_timing', OPENAPI, '/components/schemas/EvalCase/properties/pack_timing'],
  ['eval.pack_timing', S('eval-report'), '/$defs/ModelRow/properties/pack_timing'],
  ['eval.excluded_kind', OPENAPI, '/components/schemas/EvalCase/properties/excluded/items/properties/kind'],
  ['eval.snapshot', OPENAPI, '/components/schemas/EvalCase/properties/snapshot_status'],
  ['eval.granularity', OPENAPI, '/components/schemas/EvalCase/properties/truth/properties/granularity'],
  ['eval.mode', S('eval-report'), '/properties/mode'],
];

describe('契约枚举的文案', () => {
  const merged = {
    'zh-CN': { ...UI_MESSAGES['zh-CN'], ...CONSOLE_MESSAGES['zh-CN'] },
    en: { ...UI_MESSAGES.en, ...CONSOLE_MESSAGES.en },
  };

  it('每个契约枚举值在两种语言里都有文案', () => {
    const ids: string[] = [];
    for (const [prefix, file, pointer] of ENUMS) {
      const values = enumAt(file, pointer);
      expect(values.length, `${prefix} ← ${file}#${pointer}`).toBeGreaterThan(0);
      for (const v of values) {
        ids.push(`${prefix}.${v}`);
      }
    }
    for (const locale of ['zh-CN', 'en'] as const) {
      expect(
        [...new Set(ids)].filter((id) => merged[locale][id] === undefined),
        locale,
      ).toEqual([]);
    }
  });
});
