import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCommand } from '../../src/commands.js';
import { exportRequest, exportTime } from '../../src/export/cli.js';
import {
  exportIncidentsInput,
  exportIncidentsPath,
  listIncidentsInput,
  listIncidentsPath,
  MCP_EXPORT_LIMIT,
} from '../../src/mcp/server.js';
import { separateUntrusted } from '../../src/mcp/untrusted.js';

// 导出的两个客户端（ADR 0186 §8）：MCP 的 list_incidents_v2、export_incidents_v1 的参数与转给中心的查询串，
// 导出结果里外部文字移入 untrusted_text；命令行 incidents export 的参数解析。

const NOW = Date.parse('2026-11-05T12:00:00Z');
const listArgs = z.object(listIncidentsInput);
const exportArgs = z.object(exportIncidentsInput);
const decode = (path: string) => [...new URL(path, 'http://hub').searchParams.entries()];

describe('MCP：list_incidents_v2', () => {
  it('筛选参数原样转给 GET /v1/incidents，数组按重复参数给出，没有给出的参数不出现', () => {
    const a = listArgs.parse({
      from: '2026-11-02T00:00:00Z',
      to: '2026-11-05T00:00:00Z',
      severity: 'critical',
      category: ['availability', 'performance'],
      exclude_category: ['provider'],
      exclude_component: ['Deployment:shop/api', 'Deployment:shop/web'],
    });
    const path = listIncidentsPath(a);
    expect(path.startsWith('/v1/incidents?')).toBe(true);
    expect(decode(path)).toEqual([
      ['state', 'firing'],
      ['from', '2026-11-02T00:00:00Z'],
      ['to', '2026-11-05T00:00:00Z'],
      ['severity', 'critical'],
      ['category', 'availability'],
      ['category', 'performance'],
      ['exclude_category', 'provider'],
      ['exclude_component', 'Deployment:shop/api'],
      ['exclude_component', 'Deployment:shop/web'],
      ['limit', '20'],
    ]);
  });

  it('不接受 unclassified 的排除、非法时间与超过 100 的 limit', () => {
    expect(listArgs.safeParse({ exclude_category: ['unclassified'] }).success).toBe(false);
    expect(listArgs.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(listArgs.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('MCP：export_incidents_v1', () => {
  it('from、to 必填；默认 500 条、按事件导出；超过 500 的 limit 不接受', () => {
    expect(exportArgs.safeParse({ from: '2026-11-02T00:00:00Z' }).success).toBe(false);
    const a = exportArgs.parse({ from: '2026-11-02T00:00:00Z', to: '2026-11-05T00:00:00Z' });
    expect(a).toMatchObject({ limit: MCP_EXPORT_LIMIT, group: 'incident' });
    expect(exportArgs.safeParse({ ...a, limit: MCP_EXPORT_LIMIT + 1 }).success).toBe(false);
    expect(exportArgs.safeParse({ ...a, group_gap: '2d' }).success).toBe(false);
    const path = exportIncidentsPath(
      exportArgs.parse({ ...a, exclude_category: ['provider'], group: 'series', cursor: 'abc' }),
    );
    expect(path.startsWith('/v1/incidents/export?')).toBe(true);
    expect(decode(path)).toEqual([
      ['from', '2026-11-02T00:00:00Z'],
      ['to', '2026-11-05T00:00:00Z'],
      ['exclude_category', 'provider'],
      ['group', 'series'],
      ['cursor', 'abc'],
      ['limit', '500'],
    ]);
  });

  it('导出结果的摘要、原因说明、无法判定的原因与证据卡文字移入 untrusted_text，结构化字段保留', () => {
    const exported = {
      incidents: [
        {
          incident_id: '00000000-0000-4000-8000-000000000001',
          alertnames: ['KubeHpaMaxedOut'],
          firing_seconds: 3600,
          conclusion: {
            source: 'research',
            disposition: 'escalate',
            summary: '模型写的摘要',
            undetermined: {
              codes: [{ stage: 'research', code: 'step_limit', text: '达到步数上限', detail: null }],
              undetermined_reason: '查询没有返回样本',
            },
          },
          evidence: [{ ref: 'card:1', title: { 'zh-CN': '卡名' }, verdict: 'abnormal', summary: '12%：超过阈值' }],
        },
      ],
      kube_warnings: [{ cluster_id: 'c1', queries: [{ name: 'events', status: 'failed', detail: 'HTTP 502' }] }],
    };
    const s = separateUntrusted(exported);
    const paths = s.untrusted_text.map((u) => u.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/incidents/0/conclusion/summary',
        '/incidents/0/conclusion/undetermined/codes/0/text',
        '/incidents/0/conclusion/undetermined/undetermined_reason',
        '/incidents/0/evidence/0/title/zh-CN',
        '/incidents/0/evidence/0/summary',
        '/kube_warnings/0/queries/0/detail',
      ]),
    );
    const data = s.data as typeof exported;
    expect(data.incidents[0]!.alertnames).toEqual(['KubeHpaMaxedOut']);
    expect(data.incidents[0]!.conclusion.disposition).toBe('escalate');
    expect(data.incidents[0]!.conclusion.summary).toEqual({ untrusted_ref: expect.any(Number) });
  });
});

describe('命令行：incidents export', () => {
  const env = { SRENAUTIX_HUB_URL: 'http://hub:8080/', SRENAUTIX_TOKEN_FILE: '/run/token' };

  it('相对时长按现在换算，--to 默认为现在；可以重复的参数按重复参数转给中心', () => {
    const r = exportRequest(
      [
        '--from=3d',
        '--exclude-category=provider',
        '--category=availability',
        '--category=performance',
        '--group=series',
        '--format=md',
        '--suppressed',
      ],
      env,
      NOW,
    );
    expect(r.hubUrl).toBe('http://hub:8080');
    expect(r.tokenFile).toBe('/run/token');
    expect(decode(r.path)).toEqual([
      ['from', '2026-11-02T12:00:00.000Z'],
      ['to', '2026-11-05T12:00:00.000Z'],
      ['format', 'md'],
      ['group', 'series'],
      ['category', 'availability'],
      ['category', 'performance'],
      ['exclude_category', 'provider'],
      ['suppressed', 'true'],
    ]);
  });

  it('命令行参数优先于环境变量；format 默认 json；绝对时间照写', () => {
    const r = exportRequest(
      ['--hub-url=http://other', '--token-file=/tmp-not-read', '--from=2026-11-01T00:00:00Z', '--to=12h'],
      env,
      NOW,
    );
    expect(r).toMatchObject({ hubUrl: 'http://other', tokenFile: '/tmp-not-read' });
    expect(decode(r.path)).toEqual([
      ['from', '2026-11-01T00:00:00.000Z'],
      ['to', '2026-11-05T00:00:00.000Z'],
      ['format', 'json'],
    ]);
  });

  it('缺少中心地址、token 文件或 --from 时报错；未知选项与非法时间报错', async () => {
    expect(() => exportRequest(['--from=3d'], {}, NOW)).toThrow('SRENAUTIX_HUB_URL');
    expect(() => exportRequest(['--from=3d'], { SRENAUTIX_HUB_URL: 'http://hub' }, NOW)).toThrow(
      'SRENAUTIX_TOKEN_FILE',
    );
    expect(() => exportRequest([], env, NOW)).toThrow('需要 --from');
    expect(() => exportRequest(['--from=3d', '--config=/x'], env, NOW)).toThrow(/Unknown option/);
    expect(() => exportTime('--from', 'last week', NOW)).toThrow('--from 必须是');
    await expect(
      runCommand([
        'incidents',
        'export',
        '--hub-url=http://127.0.0.1:9',
        '--token-file=/nonexistent/token',
        '--from=1h',
      ]),
    ).rejects.toThrow(/\/nonexistent\/token/);
  });
});
