import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadActionCatalog } from '../src/pack/catalog.js';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const PACKS = join(REPO, 'packs');
export const CATALOG = loadActionCatalog(join(REPO, 'contract/gateway/v1/action-catalog.yaml'));
