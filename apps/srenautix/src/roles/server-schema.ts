import { identityTrack } from '../identity/migrations.js';
import type { Track } from '../store/migrate.js';
import { storeTrack } from '../store/migrations.js';

/** server schema 的全部迁移轨道，按依赖顺序排列。 */
export const serverTracks: readonly Track[] = [storeTrack, identityTrack];
