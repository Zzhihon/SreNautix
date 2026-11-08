import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/config/files.js';
import { NOTIFY_RULES_DEFAULT, parseServerConfig } from '../../src/config/server.js';
import { ServerMetrics } from '../../src/metrics.js';

// 外部上游汇总的等待（ADR 0147）：notify.digest.external_roots.grace 是周期结束后等待多久再统计与发送，默认 30s，
// 取值 0s 到 120s；汇总的发送延迟按渠道记成直方图

const minimal = (notify: Record<string, unknown>) => ({
  cluster_id: 'c1',
  profile: 'observe',
  public_url: 'https://srenautix.example.com',
  ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }] },
  datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
  packs: { dirs: ['/packs'] },
  callers: { tokens_file: '/callers.yaml' },
  identity: { bindings_dir: '/bindings' },
  audit: { checkpoint_key_file: '/checkpoint.pem' },
  notify,
});

const withGrace = (grace: string) => minimal({ digest: { external_roots: { grace } } });

describe('notify.digest.external_roots.grace', () => {
  it('默认 30s：没有 notify、没有 digest、只给出 external_roots 的其他项时都是 30s', () => {
    const noNotify = minimal({});
    delete (noNotify as { notify?: unknown }).notify;
    expect(parseServerConfig(noNotify).notify.digest.external_roots.grace).toBe('30s');
    expect(parseServerConfig(minimal({})).notify.digest.external_roots.grace).toBe('30s');
    const c = parseServerConfig(minimal({ digest: { external_roots: { period: '30m' } } }));
    expect(c.notify.digest.external_roots).toMatchObject({ period: '30m', grace: '30s' });
    expect(NOTIFY_RULES_DEFAULT.digest.external_roots.grace).toBe('30s');
    expect(parseDuration('grace', NOTIFY_RULES_DEFAULT.digest.external_roots.grace)).toBe(30_000);
  });

  it('0s 到 120s 之间的值原样保留', () => {
    for (const g of ['0s', '45s', '120s', '2m', '90000ms']) {
      expect(parseServerConfig(withGrace(g)).notify.digest.external_roots.grace).toBe(g);
    }
  });

  it('超过 120s 时拒绝并写明范围；不是时长的值被 schema 拒绝', () => {
    for (const g of ['121s', '3m', '1h']) {
      expect(() => parseServerConfig(withGrace(g))).toThrow(
        'notify.digest.external_roots.grace 必须在 0s 与 120s 之间',
      );
    }
    for (const g of ['-5s', '30', '30 s', '']) {
      expect(() => parseServerConfig(withGrace(g))).toThrow();
    }
  });
});

describe('外部上游汇总的发送延迟', () => {
  it('srenautix_notify_external_digest_delay_seconds 是按 channel 区分的直方图，桶覆盖 30s 等待附近', async () => {
    const m = new ServerMetrics('server', false);
    m.externalDigestDelay.observe({ channel: 'telegram' }, 31.2);
    m.externalDigestDelay.observe({ channel: 'feishu' }, 95);
    const text = await m.registry.metrics();
    expect(text).toContain('# TYPE srenautix_notify_external_digest_delay_seconds histogram');
    expect(text).toContain('srenautix_notify_external_digest_delay_seconds_bucket{le="30",channel="telegram"} 0');
    expect(text).toContain('srenautix_notify_external_digest_delay_seconds_bucket{le="35",channel="telegram"} 1');
    expect(text).toContain('srenautix_notify_external_digest_delay_seconds_bucket{le="90",channel="feishu"} 0');
    expect(text).toContain('srenautix_notify_external_digest_delay_seconds_bucket{le="120",channel="feishu"} 1');
    expect(text).toContain('srenautix_notify_external_digest_delay_seconds_count{channel="telegram"} 1');
  });
});
