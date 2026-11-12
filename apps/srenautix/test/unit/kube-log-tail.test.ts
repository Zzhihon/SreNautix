import type { CoreV1Api } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { finish, readLogTail } from '../../src/research/kube-tools.js';

// 容器日志尾部的截断：最新的行在最后，截断时保留末尾（报错通常在那里）

/** 按 kubelet 的语义读日志：先取最后 tailLines 行，再从这段的开头数 limitBytes 字节 */
function kubelet(lines: string[]) {
  const calls: number[] = [];
  const core = {
    async readNamespacedPodLog(p: { tailLines: number; limitBytes: number }) {
      calls.push(p.tailLines);
      const text = `${lines.slice(-p.tailLines).join('\n')}\n`;
      return Buffer.from(text, 'utf8').subarray(0, p.limitBytes).toString('utf8');
    },
  };
  return { core: core as unknown as CoreV1Api, calls };
}

const LOG = Array.from(
  { length: 500 },
  (_, i) => `2026-11-08T12:${String(i % 60).padStart(2, '0')}:00Z line ${i} ${'x'.repeat(200)}`,
);
LOG[499] = '2026-11-08T12:38:15Z ERROR export dead-lettered: proto: string field contains invalid UTF-8';

describe('日志尾部', () => {
  it('超出上限时保留末尾，从完整的一行开始', () => {
    const r = finish(LOG.join('\n'), 4096, 'tail');
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(4096);
    expect(r.text.endsWith(LOG[499] as string)).toBe(true);
    expect(r.text.split('\n')[0]).toMatch(/^2026-11-08T12:\d\d:00Z line \d+ x+$/);
  });

  it('单行超长时从字符边界开始，不产生乱码', () => {
    const r = finish(`开头${'错'.repeat(3000)}`, 1000, 'tail');
    expect(r.text).not.toContain('�');
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(1000);
  });

  it('kubelet 读满 limitBytes 时缩小 tailLines 重读，结果以最新的一行结尾', async () => {
    const k = kubelet(LOG);
    const r = await readLogTail(k.core, {
      namespace: 'cchp-prod',
      pod: 'archive-exporter-0',
      container: 'archive-exporter',
      previous: false,
      tailLines: 500,
      maxBytes: 4096,
    });
    expect(r.text.endsWith(`${LOG[499]}\n`)).toBe(true);
    expect(k.calls[0]).toBe(500);
    expect(k.calls.length).toBeGreaterThan(1);
    expect(k.calls.length).toBeLessThanOrEqual(3);
  });

  it('日志不超出上限时只读一次', async () => {
    const k = kubelet(LOG.slice(-5));
    const r = await readLogTail(k.core, {
      namespace: 'cchp-prod',
      pod: 'p',
      container: 'c',
      previous: true,
      tailLines: 100,
      maxBytes: 4096,
    });
    expect(r.truncated).toBe(false);
    expect(k.calls).toEqual([100]);
  });
});
