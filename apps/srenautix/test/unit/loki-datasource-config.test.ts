import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/config/server.js';
import { EvidenceSource } from '../../src/stage-a/packs.js';

const minimal = (loki: Record<string, unknown>) => ({
  cluster_id: 'c1',
  profile: 'observe',
  public_url: 'https://srenautix.example.com',
  ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }] },
  datasources: { prometheus: { url: 'http://127.0.0.1:9' }, loki },
  packs: { dirs: ['/packs'] },
  callers: { tokens_file: '/callers.yaml' },
  identity: { bindings_dir: '/bindings' },
  audit: { checkpoint_key_file: '/checkpoint.pem' },
});

describe('datasources.loki.ca_file', () => {
  it('可选；填了时原样保留', () => {
    expect(parseServerConfig(minimal({ url: 'https://loki:3100' })).datasources.loki?.ca_file).toBeUndefined();
    const c = parseServerConfig(
      minimal({ url: 'https://loki:3100', ca_file: '/etc/srenautix/secrets/loki-ca/ca.crt' }),
    );
    expect(c.datasources.loki?.ca_file).toBe('/etc/srenautix/secrets/loki-ca/ca.crt');
  });

  it('证据数据源的 Loki 适配器用这个 CA 校验证书', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loki-ca-'));
    const ca = join(dir, 'ca.crt');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n');
    const source = await EvidenceSource.create(
      { id: 'prometheus', url: 'http://127.0.0.1:9', dialect: 'promql', bearerTokenFile: null, timeoutMs: 1000 },
      {
        id: 'loki',
        url: 'https://loki:3100',
        bearerTokenFile: null,
        caFile: ca,
        tenant: null,
        labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
        timeoutMs: 1000,
      },
    );
    const logs = (source as unknown as { logs: { config: { ca_file?: string | null } } }).logs;
    expect(logs.config.ca_file).toBe(ca);
  });
});
