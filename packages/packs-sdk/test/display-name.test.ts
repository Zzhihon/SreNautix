import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backendsDir,
  PrometheusApiAdapter,
  startPrometheus,
  type FixtureMetricSeries,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { compilePackSet } from '../src/pack/compile.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { LiveDataSource } from '../src/runtime/datasource.js';
import { resolveDisplayName } from '../src/runtime/display-name.js';
import { CATALOG, PACKS } from './support.js';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const fixtures: FixtureMetricSeries[] = [
  {
    labels: {
      __name__: 'kube_deployment_labels',
      namespace: 'shop',
      deployment: 'web',
      label_app_kubernetes_io_display_name: '商城前端',
    },
    points: Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v: 1 })),
  },
  {
    labels: { __name__: 'kube_deployment_labels', namespace: 'shop', deployment: 'api' },
    points: Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v: 1 })),
  },
];

let prom: TsdbInstance | undefined;
const scratch: string[] = [];
beforeAll(async () => {
  prom = await startPrometheus(fixtures);
});
afterAll(async () => {
  await prom?.stop();
  for (const d of scratch) {
    rmSync(d, { recursive: true, force: true });
  }
});

function source(url: string): LiveDataSource {
  return new LiveDataSource({
    metrics: {
      adapter: new PrometheusApiAdapter({ id: 'prometheus', url, dialects: ['promql'] }),
      profile: {
        namespace: 'namespace',
        pod: 'pod',
        container: 'container',
        node: 'node',
        cluster: null,
        scrape_interval_seconds: 60,
        tenant: null,
      },
    },
  });
}

const at = T0 + 30 * MIN;
const entity = (name: string) => ({ cluster_id: 'c1', kind: 'Deployment', namespace: 'shop', name });

describe('组件的可读名称', () => {
  it('按声明顺序取第一个非空且不等于实体名的值，都没有时为 null', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS, ['_example']), { catalog: CATALOG });
    const ds = source(prom!.url);
    // 告警注解优先
    expect(
      await resolveDisplayName(
        set,
        'example.web',
        { entity: entity('web'), labels: {}, annotations: { display_name: '前端（注解）' } },
        ds,
        at,
      ),
    ).toBe('前端（注解）');
    // 注解缺失或等于实体名时取指标标签
    const variants: Array<Record<string, string>> = [{}, { display_name: 'web' }, { display_name: '  ' }];
    for (const annotations of variants) {
      expect(
        await resolveDisplayName(set, 'example.web', { entity: entity('web'), labels: {}, annotations }, ds, at),
      ).toBe('商城前端');
    }
    // 指标上没有这个标签
    expect(
      await resolveDisplayName(set, 'example.web', { entity: entity('api'), labels: {}, annotations: {} }, ds, at),
    ).toBeNull();
    // 没有 display_name 的组件类型与不存在的组件类型
    expect(
      await resolveDisplayName(set, 'missing.type', { entity: entity('web'), labels: {}, annotations: {} }, ds, at),
    ).toBeNull();
  });

  it('数据源不可达时 signal 来源落空，不抛出', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS, ['_example']), { catalog: CATALOG });
    const ds = source('http://127.0.0.1:9');
    expect(
      await resolveDisplayName(set, 'example.web', { entity: entity('web'), labels: {}, annotations: {} }, ds, at),
    ).toBeNull();
  });

  it('signal 来源必须是本包的 metrics 信号', async () => {
    const base = join(backendsDir(), 'runs');
    mkdirSync(base, { recursive: true });
    for (const [signal, pattern] of [
      ['no_such_signal', /不在本包中/],
      ['oom_log_lines', /必须是 metrics 信号/],
    ] as const) {
      const dir = mkdtempSync(join(base, 'display-name-'));
      scratch.push(dir);
      const pack = join(dir, '_example');
      cpSync(join(PACKS, '_example'), pack, { recursive: true });
      const file = join(pack, 'components.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('signal: deployment_display_name', `signal: ${signal}`));
      const err = await compilePackSet([loadPackDir(pack, 'builtin')], { catalog: CATALOG }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PackLintError);
      expect((err as Error).message).toMatch(pattern);
    }
  });
});
