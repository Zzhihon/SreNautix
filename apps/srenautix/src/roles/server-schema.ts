import { changesTrack } from '../changes/migrations.js';
import { consoleTrack } from '../console-bff/migrations.js';
import { githubTrack } from '../github/migrations.js';
import { identityTrack } from '../identity/migrations.js';
import { incidentTrack } from '../incident/migrations.js';
import { ingestTrack } from '../ingest/migrations.js';
import { notifyTrack } from '../notify/migrations.js';
import { proposalsTrack } from '../proposals/migrations.js';
import { notifyCorrections } from '../notify/corrections.js';
import type { Correction } from '../store/corrections.js';
import type { Track } from '../store/migrate.js';
import { storeTrack } from '../store/migrations.js';
import { topologyTrack } from '../topology/migrations.js';
import { detectorTrack } from '../detectors/migrations.js';
import { remediationTrack } from '../remediation/migrations.js';
import { optimizationTrack } from '../optimize/migrations.js';

/** server schema 的全部迁移轨道，按依赖顺序排列。 */
export const serverTracks: readonly Track[] = [
  storeTrack,
  identityTrack,
  ingestTrack,
  topologyTrack,
  incidentTrack,
  proposalsTrack,
  notifyTrack,
  consoleTrack,
  changesTrack,
  githubTrack,
  detectorTrack,
  remediationTrack,
  optimizationTrack,
];

/** server 取得主实例之后、开始单活工作之前执行一次的数据修正（ADR 0176），按列出的顺序执行 */
export const serverCorrections: readonly Correction[] = [...notifyCorrections];
