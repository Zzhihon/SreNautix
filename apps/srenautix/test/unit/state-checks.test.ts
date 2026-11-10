import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { incidentTrack } from '../../src/incident/migrations.js';
import type { Track } from '../../src/kernel/store/migrate.js';
import { optimizationTrack } from '../../src/optimize/migrations.js';
import { proposalsTrack } from '../../src/proposals/migrations.js';

// 状态列的 CHECK 约束与契约枚举一致：契约加了状态而迁移没跟上时，写入会在运行时被数据库拒绝，这里先失败

const CONTRACT = resolve(import.meta.dirname, '../../../../contract');
const schema = (file: string) => JSON.parse(readFileSync(`${CONTRACT}/schemas/${file}`, 'utf8'));
const openapi = parseYaml(readFileSync(`${CONTRACT}/openapi.yaml`, 'utf8'));

/** 迁移里名为 constraint 的 CHECK 的取值列表，按出现顺序 */
function checkValues(track: Track, constraint: string): string[] {
  const sql = track.migrations.map((m) => m.sql).join('\n');
  const m = new RegExp(`ADD CONSTRAINT ${constraint}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(sql);
  if (!m) {
    throw new Error(`没有约束 ${constraint}`);
  }
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('状态列的 CHECK 与契约枚举一致', () => {
  it.each([
    ['proposals_state_check', proposalsTrack, () => schema('proposal.schema.json').$defs.State.enum],
    ['research_runs_state_check', incidentTrack, () => openapi.components.schemas.ResearchState.enum],
    [
      'optimization_findings_status_check',
      optimizationTrack,
      () => schema('finding.schema.json').$defs.FindingStatus.enum,
    ],
    [
      'optimization_recommendations_state_check',
      optimizationTrack,
      () => schema('recommendation.schema.json').$defs.RecommendationState.enum,
    ],
  ] as const)('%s', (constraint, track, contractEnum) => {
    expect(checkValues(track, constraint)).toEqual(contractEnum());
  });
});
